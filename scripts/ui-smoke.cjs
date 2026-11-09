const { _electron: electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createDemo } = require('./create-demo.cjs');
const root = path.join(__dirname, '..');
const userData = path.join(root, 'verification/ui-user-data');
const output = path.join(root, 'verification/ui-output');
const errors = [];
async function launch() {
  const env = { ...process.env, PHOTOMARK_TEST_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], env });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}
async function main() {
  await fs.rm(userData, { recursive: true, force: true });
  await fs.rm(output, { recursive: true, force: true });
  const source = await createDemo();
  for (let i = 1; i <= 4; i++) await fs.copyFile(path.join(source, 'IMG_20261109_143025.jpg'), path.join(source, `IMG_2026110${i}_143025.jpg`));
  let { app, page } = await launch();
  try {
    await page.waitForFunction(() => document.querySelector('#platform-label').textContent === 'macOS');
    assert.equal(await page.locator('.setting-panel:visible').count(), 1);
    assert.ok(await page.evaluate(() => document.body.scrollHeight <= innerHeight + 1));
    await page.screenshot({ path: path.join(root, 'verification/empty-state.png'), fullPage: true });
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
    await page.click('#choose-source');
    await page.waitForSelector('#preview-image:not(.hidden)');
    assert.equal(await page.inputValue('#locationMode'), 'auto');
    assert.match(await page.textContent('#location-status'), /未提取到位置信息/);
    assert.equal(await page.locator('#location-manual-field').isVisible(), true);
    await app.evaluate(({ dialog }, output) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [output] }); }, output);
    await page.click('#choose-output');
    await page.fill('#location', '杭州 · 西湖');
    await page.click('#tab-date');
    await page.selectOption('#timeSource', 'filename');
    await page.waitForFunction(() => document.querySelector('#source-note').textContent.includes('杭州'));
    assert.match(await page.textContent('#location-status'), /已使用手动补充/);
    assert.match((await page.textContent('#photo-meta')).replaceAll(',', ''), /2400 × 1600/);
    const firstPreview = await page.getAttribute('#preview-image', 'src');
    await page.click('#tab-style');
    await page.click('[data-position="top-left"]');
    await page.waitForFunction(before => document.querySelector('#preview-image').src !== before, firstPreview);
    await page.click('#compare');
    await page.waitForFunction(() => document.querySelector('#stage-label').textContent.includes('原图对照'));
    await page.click('#compare');
    await page.click('[data-position="bottom-right"]');
    await page.waitForFunction(() => document.querySelector('#stage-label').textContent.includes('预览缩略图'));
    await page.waitForSelector('#preview-loading', { state: 'hidden' });
    await page.click('#tab-location');
    await page.screenshot({ path: path.join(root, 'verification/desktop-preview.png'), fullPage: true });
    await page.click('#zoom');
    await page.waitForFunction(() => document.querySelector('#zoom-info').textContent.includes('2400 × 1600'));
    await page.click('#zoom-fit');
    assert.ok(await page.locator('#zoom-stage').evaluate(el => el.scrollWidth >= 2400));
    await page.click('#zoom-close');
    await page.click('#next');
    await page.waitForFunction(() => document.querySelector('#photo-index').textContent === '2 / 6');
    await page.waitForSelector('#preview-loading', { state: 'hidden' });
    // Pause through the public renderer bridge after the first successful image.
    await page.evaluate(() => window.photomark.onProgress(s => { if (s?.done === 1 && s.running) window.photomark.pause(); }));
    await page.click('#start');
    await page.waitForFunction(() => document.querySelector('#batch-title').textContent.includes('已暂停'));
    assert.match(await page.textContent('#progress-count'), /成功 [1-5] \/ 6/);
    await app.close();
    ({ app, page } = await launch());
    await page.waitForSelector('#preview-image:not(.hidden)');
    assert.equal(await page.inputValue('#location'), '杭州 · 西湖');
    await page.click('#restore-job');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已恢复上次任务'));
    await page.click('#start');
    await page.waitForFunction(() => document.querySelector('#batch-title').textContent.includes('处理完成'));
    assert.match(await page.textContent('#progress-count'), /成功 6 \/ 6/);
    await page.screenshot({ path: path.join(root, 'verification/batch-completed.png'), fullPage: true });
    assert.deepEqual(errors, []);
    const report = { platform: process.platform, arch: process.arch, passed: true, runtimeErrors: errors,
      checks: ['empty state', 'native directory dialog', 'Chinese watermark', 'corner change', 'original comparison', 'full-resolution 1:1 preview', 'photo navigation', 'pause', 'restart', 'restore task settings', 'resume to completion'], checkedAt: new Date().toISOString() };
    await fs.writeFile(path.join(root, 'verification/ui-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await app.close().catch(() => {}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
