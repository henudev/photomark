const { _electron: electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { DEFAULTS } = require('../src/settings.cjs');
const { Batch, fileHash } = require('../src/batch.cjs');
const root = path.join(__dirname, '..');
const source = path.join(root, 'verification/format-photos');
const output = path.join(root, 'verification/format-output');
const userData = path.join(root, 'verification/format-user-data');
const settings = { ...DEFAULTS, location: '杭州 · 西湖', timeSource: 'manual', manualDate: '2026-11-09T14:30:25' };
const runtimeErrors = [];
async function launch() {
  const env = { ...process.env, PHOTOMARK_TEST_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], env });
  const page = await app.firstWindow(); page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.waitForSelector('#preview-image:not(.hidden)');
  return { app, page };
}
async function waitSaved(format) {
  for (let i = 0; i < 80; i++) {
    const state = JSON.parse(await fs.readFile(path.join(userData, 'preferences.json'), 'utf8'));
    if (state.settings.format === format) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`选择的格式未保存：${format}`);
}
async function runExport(page, format) {
  await page.evaluate(() => {
    window.formatLocks = [];
    window.formatFinished = false;
    window.photomark.onProgress(value => {
      if (value?.running) window.formatLocks.push(['format', 'format-png', 'format-jpeg'].every(id => document.getElementById(id).disabled));
      else if (window.formatLocks.length) window.formatFinished = true;
    });
  });
  await page.click('#start');
  await page.waitForFunction(() => window.formatFinished);
  assert.ok(await page.evaluate(() => window.formatLocks.length > 0 && window.formatLocks.every(Boolean)), '处理中不能切换导出格式');
  const records = await fs.readdir(path.join(output, '.photomark'));
  for (const record of records) {
    const manifest = JSON.parse(await fs.readFile(path.join(output, '.photomark', record), 'utf8'));
    if (manifest.settings.format !== format) continue;
    assert.equal(Object.values(manifest.entries).filter(entry => entry.status === 'done').length, 2);
    for (const entry of Object.values(manifest.entries)) {
      const buffer = await fs.readFile(entry.output);
      const metadata = await sharp(buffer).metadata();
      assert.equal(metadata.format, format); assert.equal(metadata.width, 1200); assert.equal(metadata.height, 800);
      if (format === 'png') { assert.ok(entry.output.endsWith('.png')); assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); }
      if (format === 'jpeg') { assert.ok(entry.output.endsWith('.jpg')); assert.deepEqual([...buffer.subarray(0, 3)], [255, 216, 255]); }
    }
    return manifest;
  }
  throw new Error(`未生成预期格式：${format}`);
}
async function main() {
  await fs.rm(userData, { recursive: true, force: true }); await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(userData, { recursive: true }); await fs.mkdir(source, { recursive: true });
  for (const name of ['a.jpg', 'b.jpg']) await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#6e969a' } }).jpeg().toFile(path.join(source, name));
  await fs.writeFile(path.join(userData, 'preferences.json'), JSON.stringify({ source, output, settingsVersion: 2, settings }));
  let { app, page } = await launch();
  try {
    assert.equal(await page.locator('#format').isVisible(), true, '格式选择须在主界面始终可见');
    assert.equal(await page.inputValue('#format'), 'png');
    const options = await page.locator('#format option:not([hidden])').evaluateAll(nodes => nodes.map(node => node.value));
    assert.deepEqual(options, ['png', 'jpeg']);
    await page.click('#tab-export');
    assert.equal(await page.locator('#format-png').isChecked(), true);
    await page.click('label.format-choice:has(#format-jpeg)');
    assert.equal(await page.inputValue('#format'), 'jpeg');
    assert.match(await page.textContent('#quality-note'), /质量 100.*有损/);
    await waitSaved('jpeg'); await app.close();
    ({ app, page } = await launch());
    assert.equal(await page.inputValue('#format'), 'jpeg', '重启后保留 JPG 选择');
    await page.click('#tab-export'); assert.equal(await page.locator('#format-jpeg').isChecked(), true);
    const jpeg = await runExport(page, 'jpeg');
    const firstJpeg = Object.values(jpeg.entries)[0]; const jpegHash = await fileHash(firstJpeg.output); const jpegTime = (await fs.stat(firstJpeg.output)).mtimeMs;
    await page.selectOption('#format', 'png'); assert.equal(await page.locator('#format-png').isChecked(), true);
    assert.match(await page.textContent('#quality-note'), /PNG 无损/);
    const png = await runExport(page, 'png'); assert.notEqual(png.id, jpeg.id);
    assert.equal(await fileHash(firstJpeg.output), jpegHash, '切换 PNG 不改写 JPG 成品');
    await page.click('label.format-choice:has(#format-jpeg)'); await runExport(page, 'jpeg');
    assert.equal((await fs.stat(firstJpeg.output)).mtimeMs, jpegTime, '切回 JPG 时跳过已完成照片');
    await page.screenshot({ path: path.join(root, 'verification/format-selection.png') });
    await app.close();
    // Keep old TIFF task fingerprints resumable, without offering TIFF for new tasks.
    const legacyOutput = path.join(root, 'verification/format-legacy-output'); await fs.rm(legacyOutput, { recursive: true, force: true });
    const batch = new Batch(); batch.on('progress', value => { if (value?.done === 1) batch.pause(); });
    const legacy = { ...settings, format: 'tiff' };
    const paused = await batch.run(source, legacyOutput, legacy); assert.equal(paused.done, 1);
    await fs.writeFile(path.join(userData, 'preferences.json'), JSON.stringify({ source, output: legacyOutput, settingsVersion: 2, settings: legacy, lastJob: { source, output: legacyOutput, settings: legacy } }));
    ({ app, page } = await launch()); await page.click('#tab-export');
    assert.equal(await page.inputValue('#format'), 'tiff'); assert.equal(await page.locator('#legacy-format-note').isVisible(), true);
    await page.click('#restore-job'); await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已恢复上次任务'));
    await page.click('#start'); await page.waitForFunction(() => document.querySelector('#batch-title').textContent.includes('处理完成'));
    assert.match(await page.textContent('#progress-count'), /成功 2 \/ 2/);
    await page.click('label.format-choice:has(#format-png)'); assert.equal(await page.inputValue('#format'), 'png');
    assert.deepEqual(runtimeErrors, []);
    const report = { checkedAt: new Date().toISOString(), passed: true, checks: ['PNG default', 'two visible choices', 'toolbar and cards synchronized', 'quality hints', 'format remembered after restart', 'actual JPG encoding and extension', 'actual PNG encoding and extension', 'original dimensions', 'format locked while processing', 'separate task records per format', 'resume skips existing output', 'legacy TIFF task resumes'], runtimeErrors };
    await fs.writeFile(path.join(root, 'verification/format-ui-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally { await app.close().catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
