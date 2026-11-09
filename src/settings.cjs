const DEFAULTS = Object.freeze({
  recursive: false, timeSource: 'exif', dateFormat: 'yyyy-MM-dd HH:mm:ss', manualDate: '',
  locationMode: 'auto', location: '', position: 'bottom-right', fontScale: 2.6,
  margin: 3, color: '#ffffff', opacity: 95, shadow: true, background: false,
  format: 'png', preserveMetadata: true,
});
function normalizeSettings(raw = {}) {
  const s = { ...DEFAULTS };
  const enums = {
    timeSource: ['exif', 'filename', 'modified', 'manual', 'none'],
    locationMode: ['auto', 'manual', 'gps', 'none'],
    position: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
    format: ['png', 'jpeg', 'tiff'],
  };
  for (const [key, values] of Object.entries(enums)) {
    if (raw[key] !== undefined && !values.includes(raw[key])) throw new Error(`无效设置：${key}`);
    if (raw[key] !== undefined) s[key] = raw[key];
  }
  for (const key of ['recursive', 'shadow', 'background', 'preserveMetadata']) {
    if (raw[key] !== undefined) s[key] = Boolean(raw[key]);
  }
  for (const [key, min, max] of [['fontScale', 0.8, 8], ['margin', 1, 12], ['opacity', 10, 100]]) {
    if (raw[key] !== undefined) {
      const value = Number(raw[key]);
      if (!Number.isFinite(value) || value < min || value > max) throw new Error(`无效设置：${key}`);
      s[key] = value;
    }
  }
  for (const key of ['location', 'manualDate', 'dateFormat']) {
    if (raw[key] !== undefined) s[key] = String(raw[key]).trim().slice(0, key === 'location' ? 100 : 80);
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(raw.color ?? s.color)) throw new Error('颜色格式无效');
  s.color = raw.color ?? s.color;
  if (!s.dateFormat || /[a-zA-Z]/.test(s.dateFormat.replace(/yyyy|MM|dd|HH|mm|ss/g, ''))) {
    throw new Error('日期格式只支持 yyyy、MM、dd、HH、mm、ss 和分隔符');
  }
  return s;
}
function migratePreferences(previous = {}) {
  if (previous.settingsVersion >= 2) return previous;
  // Only change the current default. Keep the previous job's exact settings so
  // its fingerprint and interrupted outputs can still be resumed unchanged.
  return { ...previous, settingsVersion: 2, settings: { ...previous.settings, locationMode: previous.settings?.locationMode === 'none' ? 'none' : 'auto' } };
}
module.exports = { DEFAULTS, normalizeSettings, migratePreferences };
