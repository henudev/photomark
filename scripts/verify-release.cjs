const { _electron: electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const assert = require('node:assert/strict');
const { DEFAULTS } = require('../src/settings.cjs');
const root = path.join(__dirname, '..');
const { version } = require('../package.json');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function smokeMac(folder, arch) {
  const userData = path.join(root, `verification/packaged-${arch}-user-data`);
  const output = path.join(root, `verification/packaged-${arch}-output`);
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(path.join(userData, 'preferences.json'), JSON.stringify({ source: path.join(root, 'demo-photos'), output,
    settings: { ...DEFAULTS, timeSource: 'filename', location: '杭州 · 西湖' } }));
  const env = { ...process.env, PHOTOMARK_TEST_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: path.join(root, `release/${folder}/PhotoMark.app/Contents/MacOS/PhotoMark`), args: [], env, timeout: 60000 });
  try {
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.waitForSelector('#preview-image:not(.hidden)', { timeout: 60000 });
    assert.equal(await page.inputValue('#locationMode'), 'auto');
    assert.match(await page.textContent('#location-status'), /未提取到位置信息.*手动补充/);
    await page.waitForFunction(() => document.querySelector('#preview-image').complete && document.querySelector('#preview-image').naturalWidth > 0);
    const layout = await page.evaluate(() => ({ htmlHeight: document.documentElement.scrollHeight, bodyHeight: document.body.scrollHeight, height: innerHeight,
      boxes: ['main', '.workspace', '.settings', '.setting-body', '.setting-panel:not(.hidden)', '.preview', '.preview-stage', '.batch', 'footer'].map(selector => { const el = document.querySelector(selector), r = el.getBoundingClientRect(); return { selector, top: r.top, bottom: r.bottom, client: el.clientHeight, scroll: el.scrollHeight, cssHeight: getComputedStyle(el).height }; }) }));
    await page.screenshot({ path: path.join(root, `verification/packaged-${arch}-layout-check.png`) });
    assert.ok(layout.htmlHeight <= layout.height + 1 && layout.bodyHeight <= layout.height + 1, JSON.stringify(layout));
    const native = await app.evaluate(() => ({ arch: process.arch, sharp: process.mainModule.require('sharp').versions.sharp }));
    assert.equal(native.arch, arch); assert.equal(native.sharp, '0.35.5');
    await page.click('#start');
    await page.waitForFunction(() => document.querySelector('#batch-title').textContent.includes('处理完成'), null, { timeout: 60000 });
    const count = (await fs.readdir(path.join(root, 'demo-photos'))).filter(name => name.endsWith('.jpg')).length;
    const progress = await page.textContent('#progress-count'); assert.equal(progress, `成功 ${count} / ${count}`);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(root, `verification/packaged-${arch}.png`), fullPage: true });
    return { arch, native, runtimeErrors: errors, progress, passed: true, environment: 'Apple Silicon macOS native' };
  } finally { await app.close(); }
}
async function main() {
  const sources = ['src/main.cjs', 'src/preload.cjs', 'src/image.cjs', 'src/time.cjs', 'src/location.cjs', 'src/batch.cjs', 'src/storage.cjs', 'src/settings.cjs', 'renderer/app.js', 'renderer/index.html', 'renderer/styles.css'];
  const bundles = [
    'release/mac-arm64/PhotoMark.app/Contents/Resources/app.asar',
    'release/win-unpacked/resources/app.asar',
  ];
  for (const bundle of bundles) for (const file of sources) {
    assert.equal(hash(asar.extractFile(path.join(root, bundle), file)), hash(await fs.readFile(path.join(root, file))), `${bundle} stale: ${file}`);
  }
  for (const bundle of bundles) {
    const unwanted = asar.listPackage(path.join(root, bundle)).filter(file => /\/node_modules\/@img\/sharp-(?:libvips-)?darwin-x64(?:\/|$)/.test(file));
    assert.deepEqual(unwanted, [], `${bundle} contains removed Intel Mac dependencies`);
  }
  const pe = await fs.readFile(path.join(root, 'release/win-unpacked/PhotoMark.exe'));
  const header = pe.readUInt32LE(0x3c); assert.equal(pe.readUInt16LE(header + 4), 0x8664);
  const dlls = ['sharp-win32-x64-0.35.5.node', 'libvips-42.dll', 'libvips-cpp-8.18.7.dll'];
  for (const name of dlls) await fs.access(path.join(root, 'release/win-unpacked/resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib', name));
  const mac = [await smokeMac('mac-arm64', 'arm64')];
  const artifacts = [];
  for (const filename of [`PhotoMark-${version}-mac-arm64.zip`, `PhotoMark-${version}-windows-x64.exe`]) {
    const data = await fs.readFile(path.join(root, 'release', filename)); artifacts.push({ filename, bytes: data.length, sha256: hash(data) });
  }
  const report = { checkedAt: new Date().toISOString(), packagedSourceMatches: true, coreTests: { command: 'npm test', note: 'Run separately; release verification does not rerun core tests.' }, mac,
    windows: { payloadMachine: 'AMD64 (0x8664)', sharpNativeAndDllsIncluded: true, portableWrapper: 'NSIS 32-bit bootstrap, containing x86-64 Electron app', runtimeTested: false }, artifacts };
  await fs.writeFile(path.join(root, 'verification/release-report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(root, 'release/SHA256SUMS.txt'), artifacts.map(x => `${x.sha256}  ${x.filename}`).join('\n') + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
