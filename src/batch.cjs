const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { render } = require('./image.cjs');
const { normalizeSettings } = require('./settings.cjs');
const { atomicJson, readJson } = require('./storage.cjs');
const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff']);
const RAW_EXTENSIONS = new Set(['.heic', '.heif', '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf']);
async function scan(source, recursive = false) {
  const root = await fs.realpath(source);
  const files = []; let unsupported = 0;
  async function visit(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      if (item.name.startsWith('.')) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory() && recursive) await visit(full);
      else if (item.isFile()) {
        const ext = path.extname(item.name).toLowerCase();
        if (EXTENSIONS.has(ext)) files.push({ path: full, relative: path.relative(root, full), name: item.name });
        else if (RAW_EXTENSIONS.has(ext)) unsupported++;
      }
    }
  }
  await visit(root);
  files.sort((a, b) => a.relative.localeCompare(b.relative, 'zh-CN', { numeric: true }));
  return { source: root, files, unsupported };
}
async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function canonicalOutput(output) {
  const resolved = path.resolve(output);
  // Resolve the nearest existing ancestor, including symlinks, before creating anything.
  let parent = resolved; const suffix = [];
  for (;;) {
    try { return path.join(await fs.realpath(parent), ...suffix.reverse()); }
    catch (e) { if (e.code !== 'ENOENT') throw e; suffix.push(path.basename(parent)); const next = path.dirname(parent); if (next === parent) throw e; parent = next; }
  }
}
async function publishFile(temp, destination) {
  try { await fs.link(temp, destination); }
  catch (error) {
    if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
    // FAT/exFAT and some network shares do not support hard links. Exclusive copy
    // never replaces an existing file. A publishing journal recovers interrupted copies.
    await fs.copyFile(temp, destination, constants.COPYFILE_EXCL);
    const handle = await fs.open(destination, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
class Batch extends require('node:events') {
  constructor() { super(); this.running = false; this.stopping = false; this.current = null; }
  pause() { this.stopping = true; }
  snapshot() {
    if (!this.current) return null;
    const { manifest, manifestPath } = this.current;
    const entries = Object.values(manifest.entries);
    return { id: manifest.id, source: manifest.source, output: manifest.output, settings: manifest.settings,
      total: entries.length, done: entries.filter(x => x.status === 'done').length,
      failed: entries.filter(x => x.status === 'failed').length, running: this.running,
      missingLocations: entries.filter(x => x.status === 'done' && x.info?.locationMissing).length,
      manualLocations: entries.filter(x => x.status === 'done' && x.info?.locationFallback).length,
      paused: this.stopping, currentFile: this.current.file || '', manifestPath,
      errors: entries.filter(x => x.status === 'failed').map(x => ({ file: x.relative, error: x.error })) };
  }
  notify() { this.emit('progress', this.snapshot()); }
  async run(source, output, rawSettings) {
    if (this.running) throw new Error('已有任务正在运行');
    this.running = true; this.stopping = false;
    try {
      const settings = normalizeSettings(rawSettings);
      const listing = await scan(source, settings.recursive);
      if (!listing.files.length) throw new Error('源目录中没有支持的照片');
      const target = await canonicalOutput(output);
      if (inside(listing.source, target) || inside(target, listing.source)) throw new Error('源目录和目标目录必须分开，且不能相互包含；建议使用旁边的“原目录_水印”');
      await fs.mkdir(target, { recursive: true });
      const id = crypto.createHash('sha256').update(JSON.stringify({ engine: 1, source: listing.source, settings })).digest('hex').slice(0, 16);
      const manifestPath = path.join(target, '.photomark', `task-${id}.json`);
      const previous = await readJson(manifestPath);
      if (previous && (previous.schema !== 1 || previous.id !== id || previous.source !== listing.source)) throw new Error('任务记录与当前目录不匹配');
      const manifest = previous || { schema: 1, id, source: listing.source, output: target, settings, createdAt: new Date().toISOString(), entries: {} };
      // A current scan is authoritative. Removed inputs must not remain in the progress total.
      manifest.entries = Object.fromEntries(listing.files.map(file => [file.relative, { ...manifest.entries[file.relative], relative: file.relative }]));
      this.current = { manifest, manifestPath, file: '' };
      await atomicJson(manifestPath, manifest); this.notify();
      const ext = { png: '.png', jpeg: '.jpg', tiff: '.tif' }[settings.format];
      for (const file of listing.files) {
        if (this.stopping) break;
        const entry = manifest.entries[file.relative];
        this.current.file = file.relative; this.notify();
        try {
          const inputHash = await fileHash(file.path);
          const destination = path.join(target, `${file.relative}.watermark-${id.slice(0, 8)}${ext}`);
          // Never use paths loaded from a manifest to write files.
          let existingHash = await fileHash(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (entry.status === 'done' && entry.inputHash === inputHash && existingHash === entry.outputHash) continue;
          if (existingHash && entry.status === 'done') throw new Error('原图或输出已变化，保留现有文件；请更换目标目录后重新处理');
          entry.status = 'processing'; entry.inputHash = inputHash; entry.output = destination; delete entry.error;
          await atomicJson(manifestPath, manifest);
          const result = await render(file.path, settings);
          // Catch a source file changed while it was being decoded.
          if (await fileHash(file.path) !== inputHash) throw new Error('处理过程中原照片发生变化，请重试');
          const outputHash = crypto.createHash('sha256').update(result.buffer).digest('hex');
          if (existingHash && existingHash !== outputHash && entry.publishHash === outputHash) {
            // An exclusive copy was interrupted. Preserve the partial/changed file
            // under a unique name, then retry publishing the verified complete image.
            const backup = `${destination}.interrupted-${crypto.randomUUID()}`;
            await fs.rename(destination, backup); existingHash = null;
          }
          if (existingHash) {
            // Crash after publishing but before journalling: adopt only byte-identical output.
            if (existingHash !== outputHash) throw new Error('目标已存在不同内容，已保留；请更换目标目录');
          } else {
            await fs.mkdir(path.dirname(destination), { recursive: true });
            const temp = `${destination}.photomark-tmp-${id}`;
            // This deterministic temporary path belongs only to this task and is safe to replace after interruption.
            const handle = await fs.open(temp, 'w');
            try { await handle.writeFile(result.buffer); await handle.sync(); } finally { await handle.close(); }
            entry.status = 'publishing'; entry.publishHash = outputHash;
            await atomicJson(manifestPath, manifest);
            try { await publishFile(temp, destination); } finally { await fs.unlink(temp).catch(() => {}); }
          }
          Object.assign(entry, { status: 'done', outputHash, completedAt: new Date().toISOString(), info: result.info });
          delete entry.publishHash;
        } catch (error) { entry.status = 'failed'; entry.error = error.message; }
        manifest.updatedAt = new Date().toISOString();
        await atomicJson(manifestPath, manifest); this.notify();
      }
      this.current.file = '';
      await atomicJson(manifestPath, manifest);
    } finally { this.running = false; this.notify(); }
    return this.snapshot();
  }
}
module.exports = { Batch, scan, fileHash, inside, canonicalOutput, publishFile };
