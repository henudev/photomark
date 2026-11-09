const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { resolveLocation } = require('../src/location.cjs');
const { DEFAULTS, normalizeSettings, migratePreferences } = require('../src/settings.cjs');
const { render } = require('../src/image.cjs');
const { Batch, fileHash } = require('../src/batch.cjs');
const S = { ...DEFAULTS, timeSource: 'manual', manualDate: '2026-11-09T14:30:25', location: '手动补充地点' };
const GPS = { GPSLatitudeRef: 'N', GPSLatitude: '30/1 15/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '120/1 10/1 0/1' };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photomark-location-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, '照片'), output = path.join(dir, '作品');
  await fs.mkdir(source);
  return { source, output };
}
async function writePhoto(file, { gps = false, named = false } = {}) {
  let image = sharp({ create: { width: 640, height: 480, channels: 3, background: '#7b9da2' } }).jpeg()
    .withExif({ IFD2: { DateTimeOriginal: '2026:11:09 14:30:25' }, ...(gps ? { IFD3: GPS } : {}) });
  if (named) image = image.withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/" photoshop:City="杭州" Iptc4xmpCore:Location="西湖" /></rdf:RDF></x:xmpmeta>');
  await image.toFile(file);
}
test('默认自动提取，旧偏好升级为自动补充；旧任务与显式关闭保持原设置', () => {
  assert.equal(DEFAULTS.locationMode, 'auto'); assert.equal(normalizeSettings({}).locationMode, 'auto');
  const old = { settings: { ...S, locationMode: 'manual' }, lastJob: { source: 'a', output: 'b', settings: { ...S, locationMode: 'manual' } } };
  const original = JSON.stringify(old);
  const updated = migratePreferences(old);
  assert.equal(updated.settings.locationMode, 'auto'); assert.equal(updated.settings.location, S.location);
  assert.deepEqual(updated.lastJob, old.lastJob); assert.equal(JSON.stringify(old), original);
  const saved = { settingsVersion: 2, settings: { ...S, locationMode: 'manual' } };
  assert.equal(migratePreferences(saved), saved);
  assert.equal(migratePreferences({ settings: { locationMode: 'none' } }).settings.locationMode, 'none');
});
test('逐张优先自动信息，手动内容仅作缺失补充；合法零坐标不会丢失', () => {
  const detected = resolveLocation({ gps: { latitude: 30.25, longitude: 120.1666666 } }, S);
  assert.equal(detected.location, '30.25000°, 120.16667°'); assert.equal(detected.locationMissing, false); assert.equal(detected.locationFallback, false);
  assert.equal(resolveLocation({ gps: { latitude: 0, longitude: 0 } }, S).location, '0.00000°, 0.00000°');
  for (const gps of [{ latitude: NaN, longitude: 120 }, { latitude: 100, longitude: 120 }, { latitude: 30, longitude: 181 }]) {
    const info = resolveLocation({ gps }, S); assert.equal(info.location, S.location); assert.equal(info.locationFallback, true);
  }
  assert.equal(resolveLocation(null, { ...S, location: '' }).locationStatus, 'missing');
  assert.equal(resolveLocation({ gps: { latitude: 30, longitude: 120 } }, { ...S, locationMode: 'manual' }).location, S.location);
  assert.equal(resolveLocation({ gps: { latitude: 30, longitude: 120 } }, { ...S, locationMode: 'none' }).location, '');
});
test('读取 EXIF 地点名称与内嵌 XMP/IPTC 地点，不误用照片说明或画面主体地点', () => {
  const ascii = new Uint8Array(Buffer.concat([Buffer.from('ASCII\0\0\0'), Buffer.from('West Lake\0')]));
  assert.equal(resolveLocation({ gps: { GPSAreaInformation: ascii, latitude: 30, longitude: 120 } }, S).location, 'West Lake');
  const unicode = new Uint8Array(Buffer.concat([Buffer.from('UNICODE\0'), Buffer.from('\ufeff杭州西湖', 'utf16le')]));
  assert.equal(resolveLocation({ gps: { GPSAreaInformation: unicode } }, S).location, '杭州西湖');
  assert.equal(resolveLocation({ photoshop: { City: '杭州' }, Iptc4xmpCore: { Location: '西湖' } }, S).location, '杭州 · 西湖');
  assert.equal(resolveLocation({ iptc: { City: '杭州', SubLocation: '西湖' } }, S).location, '杭州 · 西湖');
  assert.equal(resolveLocation({ ImageDescription: '一张山水照', Iptc4xmpExt: { LocationShown: { City: '杭州' } } }, S).location, S.location);
});
test('实际 EXIF GPS / XMP 文件可自动提取，缺失可补充，预览与导出一致', async t => {
  const { source } = await fixture(t);
  for (const [name, props] of [['gps', { gps: true }], ['named', { gps: true, named: true }], ['missing', {}]]) await writePhoto(path.join(source, `${name}.jpg`), props);
  const gps = await render(path.join(source, 'gps.jpg'), S); assert.equal(gps.info.location, '30.25000°, 120.16667°');
  const named = await render(path.join(source, 'named.jpg'), S); assert.equal(named.info.location, '杭州 · 西湖');
  const file = path.join(source, 'missing.jpg');
  const before = await fileHash(file);
  const exported = await render(file, S), preview = await render(file, S, { preview: true });
  assert.equal(exported.info.locationMissing, true); assert.equal(exported.info.locationFallback, true); assert.equal(exported.info.location, S.location);
  assert.deepEqual(preview.info, exported.info);
  assert.deepEqual(await sharp(preview.buffer).raw().toBuffer(), await sharp(exported.buffer).raw().toBuffer());
  assert.equal(await fileHash(file), before);
  const missing = await render(file, { ...S, location: '' }); assert.equal(missing.info.location, ''); assert.equal(missing.info.locationMissing, true);
});
test('日期关闭且无位置时仍能预览并提示，导出禁止空水印；补充后可导出', async t => {
  const { source } = await fixture(t); const file = path.join(source, 'missing.jpg'); await writePhoto(file);
  const empty = { ...S, timeSource: 'none', location: '' };
  const preview = await render(file, empty, { preview: true }); assert.equal(preview.info.locationStatus, 'missing'); assert.equal(preview.info.dateText, '');
  await assert.rejects(render(file, empty), /水印为空/);
  assert.equal((await render(file, { ...empty, location: '手动地点' })).info.location, '手动地点');
});
test('混合批次逐张使用各自位置，仅无位置照片使用手动补充并统计', async t => {
  const { source, output } = await fixture(t);
  for (const [name, props] of [['gps', { gps: true }], ['named', { named: true }], ['missing', {}]]) await writePhoto(path.join(source, `${name}.jpg`), props);
  const job = await new Batch().run(source, output, S); assert.equal(job.done, 3); assert.equal(job.failed, 0); assert.equal(job.missingLocations, 1); assert.equal(job.manualLocations, 1);
  const manifest = JSON.parse(await fs.readFile(job.manifestPath, 'utf8'));
  assert.equal(manifest.entries['gps.jpg'].info.location, '30.25000°, 120.16667°');
  assert.equal(manifest.entries['named.jpg'].info.location, '杭州 · 西湖');
  assert.equal(manifest.entries['missing.jpg'].info.location, S.location);
  const omitted = await new Batch().run(source, output, { ...S, location: '' });
  assert.equal(omitted.done, 3); assert.equal(omitted.missingLocations, 1); assert.equal(omitted.manualLocations, 0);
});
