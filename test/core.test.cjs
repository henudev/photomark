const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { DEFAULTS, normalizeSettings } = require('../src/settings.cjs');
const { parseDate, dateFromFilename, resolveTime, formatDate } = require('../src/time.cjs');
const { render } = require('../src/image.cjs');
const { Batch, scan, fileHash, publishFile } = require('../src/batch.cjs');
const S = { ...DEFAULTS, location: '杭州 · 西湖', timeSource: 'manual', manualDate: '2026-11-09T14:30:25' };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photomark-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, '原始照片'), output = path.join(dir, '输出照片');
  await fs.mkdir(source);
  return { dir, source, output };
}
async function photo(file, extra = {}) {
  const width = 320, height = 220;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const p = (y * width + x) * 3; raw[p] = x % 256; raw[p + 1] = y % 256; raw[p + 2] = (x + y) % 256; }
  let p = sharp(raw, { raw: { width, height, channels: 3 } }).png();
  if (extra.orientation) p = p.withMetadata({ orientation: extra.orientation });
  if (extra.icc) p = p.withIccProfile(extra.icc);
  if (extra.exif) p = p.withExif({ IFD2: { DateTimeOriginal: extra.exif } });
  await p.toFile(file);
}
test('日期校验、秒级格式和文件名提取不受时区转换影响', () => {
  assert.equal(parseDate('2026-02-30'), null);
  assert.equal(parseDate('2026-11-09T25:00:00'), null);
  assert.equal(formatDate(parseDate('2026:11:09 14:30:25'), 'yyyy年MM月dd日 HH:mm:ss'), '2026年11月09日 14:30:25');
  assert.equal(formatDate(dateFromFilename('IMG_20261109_143025.jpg'), 'yyyy/MM/dd HH:mm:ss'), '2026/11/09 14:30:25');
  assert.equal(dateFromFilename('1234567890120261109143025123.jpg'), null);
  const r = resolveTime('无日期.jpg', {}, Date.UTC(2026, 0, 1), DEFAULTS);
  assert.equal(r.source, '文件修改时间'); assert.equal(r.fallback, true);
  assert.throws(() => normalizeSettings({ opacity: NaN }));
  assert.throws(() => normalizeSettings({ dateFormat: 'YYYY-MM-DD' }));
});
test('PNG 无损输出：尺寸相同，水印区域外每个 RGB 像素完全一致，原文件 SHA 不变', async t => {
  const { source } = await fixture(t); const input = path.join(source, 'sample.png'); await photo(input);
  const before = await fileHash(input);
  const original = await sharp(input).ensureAlpha().raw().toBuffer();
  const { buffer } = await render(input, S);
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 320); assert.equal(info.height, 220);
  let changed = 0;
  for (let y = 0; y < 220; y++) for (let x = 0; x < 320; x++) {
    const p = (y * 320 + x) * 4;
    const a = original.subarray(p, p + 4), b = data.subarray(p, p + 4);
    if (!a.equals(b)) { changed++; assert.ok(x > 100 && y > 180, `水印外像素变化：${x}, ${y}`); }
  }
  assert.ok(changed > 20); assert.equal(await fileHash(input), before);
});
test('四个角均有水印，预览与导出使用相同合成结果', async t => {
  const { source } = await fixture(t); const file = path.join(source, 'a.png'); await photo(file);
  const orig = await sharp(file).ensureAlpha().raw().toBuffer();
  for (const position of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const settings = { ...S, position };
    const output = await render(file, settings);
    const raw = await sharp(output.buffer).ensureAlpha().raw().toBuffer();
    let count = 0;
    for (let y = 0; y < 220; y++) for (let x = 0; x < 320; x++) { const p = (y * 320 + x) * 4; if (!raw.subarray(p, p + 4).equals(orig.subarray(p, p + 4))) { count++; assert.ok(position.startsWith('top') ? y < 40 : y > 180); assert.ok(position.endsWith('left') ? x < 220 : x > 100); } }
    assert.ok(count > 20);
    const preview = await render(file, settings, { preview: true });
    assert.deepEqual(await sharp(preview.buffer).raw().toBuffer(), await sharp(output.buffer).raw().toBuffer());
  }
});
test('JPEG 解码转 PNG 和透明 PNG 的未覆盖像素不变', async t => {
  const { source } = await fixture(t);
  const png = path.join(source, 'a.png'); await photo(png);
  const jpg = path.join(source, 'photo.jpg'); await sharp(png).jpeg({ quality: 85 }).toFile(jpg);
  const alpha = path.join(source, 'alpha.png');
  await sharp(png).ensureAlpha(0.5).png().toFile(alpha);
  for (const file of [jpg, alpha]) {
    const a = await sharp(file, { ignoreIcc: true }).ensureAlpha().raw().toBuffer();
    const { buffer } = await render(file, S);
    const b = await sharp(buffer, { ignoreIcc: true }).ensureAlpha().raw().toBuffer();
    assert.deepEqual(a.subarray(0, 320 * 170 * 4), b.subarray(0, 320 * 170 * 4));
  }
});
test('EXIF 方向自动转正，拍摄时间与 ICC 保留，可关闭元数据', async t => {
  const { source } = await fixture(t); const file = path.join(source, 'camera.png'); await photo(file, { orientation: 6, icc: 'p3', exif: '2021:03:04 05:06:07' });
  const before = await sharp(file).metadata();
  const { buffer, info } = await render(file, { ...S, timeSource: 'exif' });
  const after = await sharp(buffer).metadata();
  assert.equal(after.width, 220); assert.equal(after.height, 320);
  assert.ok(!after.orientation || after.orientation === 1);
  assert.deepEqual(after.icc, before.icc);
  assert.equal(info.dateText, '2021-03-04 05:06:07');
  const a = await sharp(file, { ignoreIcc: true }).autoOrient().ensureAlpha().raw().toBuffer();
  const b = await sharp(buffer, { ignoreIcc: true }).ensureAlpha().raw().toBuffer();
  assert.deepEqual(a.subarray(0, 220 * 200 * 4), b.subarray(0, 220 * 200 * 4));
  const without = await render(file, { ...S, preserveMetadata: false });
  const m = await sharp(without.buffer).metadata(); assert.equal(m.exif, undefined); assert.deepEqual(m.icc, before.icc);
});
test('TIFF 无损 / JPEG 质量100 均可导出，拒绝空水印及高位深', async t => {
  const { source } = await fixture(t); const file = path.join(source, 'a.png'); await photo(file);
  for (const format of ['jpeg', 'tiff']) { const r = await render(file, { ...S, format }); assert.equal((await sharp(r.buffer).metadata()).format, format); }
  await assert.rejects(render(file, { ...S, timeSource: 'none', locationMode: 'none' }), /水印为空/);
  const hi = path.join(source, '16bit.tiff');
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#abc' } }).toColourspace('rgb16').tiff({ compression: 'lzw' }).toFile(hi);
  assert.equal((await sharp(hi).metadata()).depth, 'ushort');
  await assert.rejects(render(hi, S), /高位深/);
});
test('暂停后由新实例恢复：已完成文件不改写，失败照片修复后重试', async t => {
  const { source, output } = await fixture(t);
  for (const name of ['a.png', 'b.png']) await photo(path.join(source, name));
  await fs.writeFile(path.join(source, 'c.jpg'), 'broken jpeg');
  const first = new Batch(); first.on('progress', s => { if (s?.done === 1) first.pause(); });
  const paused = await first.run(source, output, S); assert.equal(paused.done, 1); assert.equal(paused.paused, true);
  const manifest = JSON.parse(await fs.readFile(paused.manifestPath, 'utf8'));
  const done = Object.values(manifest.entries).find(x => x.status === 'done');
  const before = (await fs.stat(done.output)).mtimeMs;
  const resumed = await new Batch().run(source, output, S);
  assert.equal(resumed.done, 2); assert.equal(resumed.failed, 1); assert.equal((await fs.stat(done.output)).mtimeMs, before);
  await photo(path.join(source, 'c.jpg'));
  const repaired = await new Batch().run(source, output, S);
  assert.equal(repaired.done, 3); assert.equal(repaired.failed, 0);
});
test('发布后未记账的中断可恢复；输出删除可补做；已修改输出不覆盖', async t => {
  const { source, output } = await fixture(t); await photo(path.join(source, 'a.png'));
  const first = await new Batch().run(source, output, S);
  const manifest = JSON.parse(await fs.readFile(first.manifestPath, 'utf8'));
  const entry = manifest.entries['a.png']; entry.status = 'processing'; delete entry.outputHash;
  await fs.writeFile(first.manifestPath, JSON.stringify(manifest));
  const recovered = await new Batch().run(source, output, S); assert.equal(recovered.done, 1);
  await fs.unlink(entry.output);
  assert.equal((await new Batch().run(source, output, S)).done, 1);
  await fs.writeFile(entry.output, 'user changes');
  const conflict = await new Batch().run(source, output, S); assert.equal(conflict.failed, 1);
  assert.equal(await fs.readFile(entry.output, 'utf8'), 'user changes');
});
test('递归目录结构、不同扩展名及设置隔离，拒绝源输出相互包含', async t => {
  const { dir, source, output } = await fixture(t);
  await fs.mkdir(path.join(source, 'sub')); await photo(path.join(source, 'sub', 'a.png'));
  await photo(path.join(source, 'a.png')); await photo(path.join(source, 'a.jpg'));
  await fs.writeFile(path.join(source, 'raw.heic'), 'unsupported');
  assert.equal((await scan(source)).files.length, 2); assert.equal((await scan(source, true)).files.length, 3); assert.equal((await scan(source)).unsupported, 1);
  const result = await new Batch().run(source, output, { ...S, recursive: true }); assert.equal(result.done, 3);
  const other = await new Batch().run(source, output, { ...S, recursive: true, position: 'top-left' }); assert.notEqual(other.id, result.id); assert.equal(other.done, 3);
  await assert.rejects(new Batch().run(source, path.join(source, 'output'), S), /不能相互包含/);
  await fs.symlink(source, path.join(dir, 'source-link'), 'dir');
  await assert.rejects(new Batch().run(source, path.join(dir, 'source-link', 'nested'), S), /不能相互包含/);
});
test('exFAT 无硬链接时使用排他复制，不覆盖已有文件', async t => {
  const { dir } = await fixture(t);
  const temp = path.join(dir, 'temp'), destination = path.join(dir, 'final');
  await fs.writeFile(temp, 'complete');
  t.mock.method(fs, 'link', async () => { const error = new Error('not supported'); error.code = 'EOPNOTSUPP'; throw error; });
  await publishFile(temp, destination); assert.equal(await fs.readFile(destination, 'utf8'), 'complete');
  await fs.writeFile(temp, 'changed');
  await assert.rejects(publishFile(temp, destination), { code: 'EEXIST' });
  assert.equal(await fs.readFile(destination, 'utf8'), 'complete');
});
test('发布日志能恢复中断的部分输出，并保留中断文件', async t => {
  const { source, output } = await fixture(t); await photo(path.join(source, 'a.png'));
  const first = await new Batch().run(source, output, S);
  const manifest = JSON.parse(await fs.readFile(first.manifestPath, 'utf8'));
  const entry = manifest.entries['a.png']; entry.status = 'publishing'; entry.publishHash = entry.outputHash; delete entry.outputHash;
  await fs.writeFile(entry.output, 'interrupted copy'); await fs.writeFile(first.manifestPath, JSON.stringify(manifest));
  const result = await new Batch().run(source, output, S); assert.equal(result.done, 1);
  const backup = (await fs.readdir(output)).find(name => name.includes('.interrupted-'));
  assert.equal(await fs.readFile(path.join(output, backup), 'utf8'), 'interrupted copy');
});
