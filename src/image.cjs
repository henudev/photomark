const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const exifr = require('exifr');
const opentype = require('opentype.js');
const { resolveTime, formatDate } = require('./time.cjs');
const { normalizeSettings } = require('./settings.cjs');
const { resolveLocation } = require('./location.cjs');
const METADATA_OPTIONS = { reviveValues: false, translateValues: false, sanitize: true, xmp: true, iptc: true, mergeOutput: false };
sharp.cache({ memory: 64, files: 0 });
sharp.concurrency(2);
let font;
function getFont() {
  if (!font) font = opentype.loadSync(path.join(__dirname, '../assets/NotoSansCJKsc-Regular.otf'));
  return font;
}
async function inspect(file, settings) {
  const [metadata, stat, tags] = await Promise.all([
    sharp(file, { failOn: 'error' }).metadata(), fs.stat(file),
    exifr.parse(file, METADATA_OPTIONS).catch(() => null),
  ]);
  if (!['jpeg', 'png', 'webp', 'tiff'].includes(metadata.format)) throw new Error('仅支持 JPG、PNG、WebP 和单页 8 位 TIFF；HEIC / RAW 请先导出');
  if ((metadata.pages || 1) > 1) throw new Error('不支持动画或多页照片，请先导出单张图像');
  if (metadata.depth !== 'uchar') throw new Error(`检测到 ${metadata.depth} 高位深图像，为避免降位深，本版本不处理`);
  if (!['srgb', 'rgb', 'b-w'].includes(metadata.space)) throw new Error(`暂不处理 ${metadata.space} 色彩空间，请先导出 RGB 照片`);
  const oriented = metadata.autoOrient || ((metadata.orientation || 1) >= 5 ? { width: metadata.height, height: metadata.width } : metadata);
  const time = resolveTime(file, { ...tags?.ifd0, ...tags?.exif }, stat.mtimeMs, settings);
  const exif = metadata.exif;
  const byteOrder = exif?.subarray(exif.subarray(0, 4).toString('ascii') === 'Exif' ? 6 : 0).subarray(0, 2).toString('ascii');
  const locationInfo = resolveLocation(tags, settings, byteOrder);
  const dateText = formatDate(time.date, settings.dateFormat);
  const lines = [locationInfo.location, dateText].filter(Boolean);
  return { metadata, width: oriented.width, height: oriented.height, lines, timeSource: time.source, fallback: time.fallback || false,
    ...locationInfo, dateText };
}
function overlaySvg(width, height, lines, settings) {
  const f = getFont();
  let fontSize = Math.max(4, Math.min(width, height) * settings.fontScale / 100);
  const margin = Math.max(2, Math.min(width, height) * settings.margin / 100);
  const available = Math.max(1, width - margin * 2 - fontSize * 0.8);
  const widest = Math.max(...lines.map(line => f.getAdvanceWidth(line, fontSize)));
  if (widest > available) fontSize *= available / widest;
  const lineHeight = fontSize * 1.5;
  const textWidth = Math.max(...lines.map(line => f.getAdvanceWidth(line, fontSize)));
  const textHeight = fontSize + (lines.length - 1) * lineHeight;
  const right = settings.position.endsWith('right');
  const top = settings.position.startsWith('top');
  const x = right ? width - margin - textWidth : margin;
  const y = top ? margin : height - margin - textHeight;
  const paths = lines.map((line, i) => {
    const lineX = right ? width - margin - f.getAdvanceWidth(line, fontSize) : x;
    const d = f.getPath(line, lineX, y + fontSize * 0.88 + i * lineHeight, fontSize).toPathData(2);
    return `<path d="${d}"/>`;
  }).join('');
  const pad = fontSize * 0.4;
  const bg = settings.background ? `<rect x="${Math.max(0, x - pad)}" y="${Math.max(0, y - pad)}" width="${textWidth + pad * 2}" height="${textHeight + pad * 2}" rx="${pad * .5}" fill="#000" opacity="0.45"/>` : '';
  const shadow = settings.shadow ? `<g fill="#000" stroke="#000" stroke-width="${Math.max(.5, fontSize / 18)}" stroke-linejoin="round" opacity="0.7" transform="translate(${fontSize / 25},${fontSize / 20})">${paths}</g>` : '';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g opacity="${settings.opacity / 100}">${bg}${shadow}<g fill="${settings.color}">${paths}</g></g></svg>`);
}
async function render(file, rawSettings, { preview = false, original = false, fullResolution = false } = {}) {
  const settings = normalizeSettings(rawSettings);
  const info = await inspect(file, settings);
  if (!info.lines.length && !preview) throw new Error('水印为空：请开启日期或填写地点');
  // Work with encoded RGB values, retaining the original ICC profile. No resize or
  // automatic tone/colour adjustment is applied to the exported image.
  let pipeline = sharp(file, { failOn: 'error', ignoreIcc: true }).autoOrient();
  if (!original && info.lines.length) pipeline = pipeline.composite([{ input: overlaySvg(info.width, info.height, info.lines, settings) }]);
  if (settings.preserveMetadata && !preview) pipeline = pipeline.keepMetadata();
  else pipeline = pipeline.keepIccProfile();
  if (preview) {
    // Export-sized composition first; then downsample a separate display copy.
    const full = await pipeline.png().toBuffer();
    if (fullResolution) return { buffer: full, info: publicInfo(info) };
    const buffer = await sharp(full).resize({ width: 1440, height: 1080, fit: 'inside', withoutEnlargement: true }).keepIccProfile().png().toBuffer();
    return { buffer, info: publicInfo(info) };
  }
  if (settings.format === 'jpeg') pipeline = pipeline.jpeg({ quality: 100, chromaSubsampling: '4:4:4', mozjpeg: false });
  else if (settings.format === 'tiff') pipeline = pipeline.tiff({ compression: 'lzw', predictor: 'horizontal' });
  else pipeline = pipeline.png({ compressionLevel: 6, palette: false });
  const buffer = await pipeline.toBuffer();
  return { buffer, info: publicInfo(info) };
}
function publicInfo(info) {
  return { width: info.width, height: info.height, format: info.metadata.format, hasIcc: !!info.metadata.icc,
    timeSource: info.timeSource, fallback: info.fallback, locationMissing: info.locationMissing,
    locationSource: info.locationSource, locationFallback: info.locationFallback, locationStatus: info.locationStatus,
    dateText: info.dateText, location: info.location };
}
module.exports = { render, inspect, overlaySvg };
