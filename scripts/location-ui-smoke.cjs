const { _electron: electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { DEFAULTS } = require('../src/settings.cjs');
const root = path.join(__dirname, '..');
async function checkLayout(app, page, size, label) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size);
  await page.waitForFunction(() => window.innerWidth > 0);
  const tabs = [];
  for (const name of ['date', 'location', 'style', 'export']) {
    await page.click(`#tab-${name}`);
    const state = await page.evaluate(() => {
      const content = document.querySelector('#settings-body'), panel = content.querySelector('section:not(.hidden)');
      const settings = document.querySelector('.settings').getBoundingClientRect();
      const controls = [...panel.querySelectorAll('input,select,button,label,small')].filter(el => el.getClientRects().length);
      return { width: innerWidth, height: innerHeight, documentHeight: document.documentElement.scrollHeight,
        documentWidth: document.documentElement.scrollWidth, bodyHeight: document.body.scrollHeight,
        panelHeight: panel.scrollHeight, available: content.clientHeight,
        clipped: controls.filter(el => el.getBoundingClientRect().bottom > settings.bottom - 5).map(el => el.id || el.textContent),
        actionBottom: document.querySelector('#start').getBoundingClientRect().bottom,
        imageHeight: document.querySelector('#preview-stage').clientHeight };
    });
    assert.ok(state.documentHeight <= state.height + 1 && state.bodyHeight <= state.height + 1, `${label}/${name}: page overflow ${JSON.stringify(state)}`);
    assert.ok(state.documentWidth <= state.width + 1, `${label}/${name}: horizontal overflow`);
    assert.ok(state.panelHeight <= state.available + 1, `${label}/${name}: hidden controls ${JSON.stringify(state)}`);
    assert.deepEqual(state.clipped, [], `${label}/${name}: controls clipped`);
    assert.ok(state.actionBottom < state.height, 'batch actions must remain visible');
    assert.ok(state.imageHeight > 180, 'preview too short');
    tabs.push({ name, ...state });
  }
  return { label, tabs };
}
async function main() {
  const source = path.join(root, 'verification/location-photos'), output = path.join(root, 'verification/location-output'), userData = path.join(root, 'verification/location-user-data');
  await fs.rm(userData, { recursive: true, force: true }); await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(userData, { recursive: true });
  for (const name of ['01-missing', '02-gps', '03-missing']) {
    await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#71969c' } }).jpeg().withExif({ IFD2: { DateTimeOriginal: '2026:11:09 14:30:25' },
      ...(name === '02-gps' ? { IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '30/1 15/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '120/1 10/1 0/1' } } : {}) }).toFile(path.join(source, `${name}.jpg`));
  }
  // Exercise upgrade from v0.1.0's manual default with the old job preserved.
  await fs.writeFile(path.join(userData, 'preferences.json'), JSON.stringify({ source, output, settings: { ...DEFAULTS, locationMode: 'manual' } }));
  const env = { ...process.env, PHOTOMARK_TEST_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], env });
  try {
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.waitForSelector('#preview-image:not(.hidden)');
    assert.equal(await page.locator('.setting-panel:visible').count(), 1);
    assert.ok(await page.evaluate(() => document.body.scrollHeight <= innerHeight + 1));
    assert.equal(await page.inputValue('#locationMode'), 'auto');
    assert.match(await page.textContent('#location-status'), /未提取到位置信息/);
    assert.equal(await page.locator('#location-manual-field').isVisible(), true);
    await page.screenshot({ path: path.join(root, 'verification/location-missing.png') });
    await page.fill('#location', '杭州 · 西湖');
    await page.waitForFunction(() => document.querySelector('#location-status').textContent.includes('已使用手动补充'));
    await page.click('#next');
    await page.waitForFunction(() => document.querySelector('#location-status').textContent.includes('30.25000°'));
    assert.equal(await page.locator('#location-manual-field').isVisible(), false);
    assert.match(await page.textContent('#source-note'), /EXIF GPS 坐标/);
    await page.screenshot({ path: path.join(root, 'verification/location-detected.png') });
    await page.click('#next');
    await page.waitForFunction(() => document.querySelector('#location-status').textContent.includes('已使用手动补充'));
    assert.equal(await page.inputValue('#location'), '杭州 · 西湖');
    await page.click('#tab-date');
    await page.selectOption('#timeSource', 'manual'); await page.fill('#manualDate', '2026-11-09T14:30:25');
    await page.selectOption('#date-preset', 'custom'); await page.fill('#dateFormat', 'yyyy年MM月dd日 HH:mm:ss');
    const layouts = [];
    for (const [size, label] of [[[1350, 860], 'standard'], [[1040, 700], 'compact'], [[1440, 980], 'large']]) layouts.push(await checkLayout(app, page, size, label));
    await page.click('#tab-location');
    await page.screenshot({ path: path.join(root, 'verification/no-scroll-layout.png') });
    await page.click('#start');
    await page.waitForFunction(() => document.querySelector('#batch-title').textContent.includes('处理完成'));
    assert.match(await page.textContent('#batch-status'), /2 张未提取到地点：2 张使用手动补充/);
    const manifestDir = path.join(output, '.photomark'); const [name] = await fs.readdir(manifestDir);
    const manifest = JSON.parse(await fs.readFile(path.join(manifestDir, name), 'utf8'));
    assert.equal(manifest.entries['02-gps.jpg'].info.location, '30.25000°, 120.16667°');
    assert.equal(manifest.entries['01-missing.jpg'].info.location, '杭州 · 西湖');
    // Failure details open separately without growing or scrolling the main page.
    await fs.writeFile(path.join(source, '04-broken.jpg'), 'broken image');
    await page.click('#start');
    await page.waitForFunction(() => document.querySelector('#batch-title').textContent.includes('部分照片需要重试'));
    await page.click('#errors');
    assert.match(await page.textContent('#errors-list'), /04-broken.jpg/);
    await page.click('#errors-close');
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight));
    await fs.unlink(path.join(source, '04-broken.jpg'));
    assert.deepEqual(errors, []);
    const report = { checkedAt: new Date().toISOString(), passed: true, locationChecks: ['old preferences migrated', 'missing EXIF hint', 'manual fallback shown', 'GPS preferred over fallback', 'input hidden for detected photo', 'fallback retained for next missing photo', 'per-photo batch locations', 'batch missing-location summary'], layouts, runtimeErrors: errors };
    await fs.writeFile(path.join(root, 'verification/location-ui-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await app.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
