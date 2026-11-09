const path = require('node:path');
function parseDate(value) {
  if (!value) return null;
  // Keep camera wall-clock time; do not convert EXIF dates into the computer's timezone.
  const m = String(value).match(/^(\d{4})[-:]?(\d{2})[-:]?(\d{2})(?:[T _-]?(\d{2})[:_-]?(\d{2})(?:[:_-]?(\d{2}))?)?/);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map((v, i) => Number(v ?? (i < 3 ? NaN : 0)));
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day); d.setUTCHours(hour, minute, second, 0);
  if (year < 1900 || year > 2200 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 ||
      d.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  return { year, month, day, hour, minute, second };
}
function dateFromFilename(filename) {
  const stem = path.basename(filename, path.extname(filename));
  const matches = stem.match(/(?<!\d)(?:19|20|21)\d{2}[-_]?(?:0[1-9]|1[0-2])[-_]?(?:0[1-9]|[12]\d|3[01])(?:[T _-]?(?:[01]\d|2[0-3])[:_-]?[0-5]\d(?:[:_-]?[0-5]\d)?)?(?!\d)/g) || [];
  for (const value of matches) { const d = parseDate(value); if (d) return d; }
  return null;
}
function localDate(value) {
  const d = new Date(value);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
}
function resolveTime(filename, exif, mtime, settings) {
  if (settings.timeSource === 'none') return { date: null, source: '不显示' };
  if (settings.timeSource === 'manual') {
    const date = parseDate(settings.manualDate);
    if (!date) throw new Error('请填写有效的手动日期和时间');
    return { date, source: '手动指定' };
  }
  const candidates = {
    exif: { date: parseDate(exif?.DateTimeOriginal) || parseDate(exif?.CreateDate), source: 'EXIF 拍摄时间' },
    filename: { date: dateFromFilename(filename), source: '文件名' },
    modified: { date: localDate(mtime), source: '文件修改时间' },
  };
  const order = settings.timeSource === 'modified' ? ['modified'] : [settings.timeSource, settings.timeSource === 'exif' ? 'filename' : 'exif', 'modified'];
  for (const key of order) if (candidates[key].date) return { ...candidates[key], fallback: key !== settings.timeSource };
  throw new Error('无法读取照片时间');
}
function formatDate(d, pattern) {
  if (!d) return '';
  const tokens = { yyyy: String(d.year).padStart(4, '0'), MM: d.month, dd: d.day, HH: d.hour, mm: d.minute, ss: d.second };
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, key => String(tokens[key]).padStart(2, '0'));
}
module.exports = { parseDate, dateFromFilename, resolveTime, formatDate };
