function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}
function areaName(value, byteOrder) {
  if (typeof value === 'string') return cleanText(value);
  if (!(value instanceof Uint8Array) || value.length <= 8) return '';
  const bytes = Buffer.from(value);
  const encoding = bytes.subarray(0, 8).toString('ascii').replaceAll('\0', '');
  const data = bytes.subarray(8);
  try {
    if (encoding === 'ASCII' && data.every(byte => byte < 128)) return cleanText(data.toString('ascii'));
    if (encoding === 'UNICODE') {
      const bigEndian = data[0] === 0xfe && data[1] === 0xff;
      const littleEndian = data[0] === 0xff && data[1] === 0xfe;
      const decoder = new TextDecoder(bigEndian || (!littleEndian && byteOrder === 'MM') ? 'utf-16be' : 'utf-16le', { fatal: true });
      return cleanText(decoder.decode(data));
    }
  } catch { /* Unsupported or invalid text is treated as missing, never shown as garbage. */ }
  return '';
}
function namedLocation(tags, byteOrder) {
  const area = areaName(tags?.gps?.GPSAreaInformation, byteOrder);
  if (area) return { text: area, source: 'EXIF 地点名称' };
  const created = tags?.Iptc4xmpExt?.LocationCreated;
  const group = (Array.isArray(created) ? created[0] : created) || {};
  const iptc = tags?.iptc || {}, photoshop = tags?.photoshop || {}, core = tags?.Iptc4xmpCore || {};
  // Use capture-location fields, not captions, image descriptions or LocationShown.
  const parts = [
    group.ProvinceState || photoshop.State || iptc.ProvinceState || iptc['Province-State'],
    group.City || photoshop.City || iptc.City,
    group.Sublocation || group.SubLocation || core.Location || iptc.Sublocation || iptc.SubLocation,
  ].map(cleanText).filter(Boolean);
  const text = [...new Set(parts)].join(' · ').slice(0, 100);
  return text ? { text, source: '照片内嵌地点名称（XMP/IPTC）' } : null;
}
function coordinates(tags) {
  const latitude = tags?.gps?.latitude, longitude = tags?.gps?.longitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return '';
  return `${latitude.toFixed(5)}°, ${longitude.toFixed(5)}°`;
}
function resolveLocation(tags, settings, byteOrder = 'II') {
  const result = { location: '', locationSource: '不显示', locationMissing: false, locationFallback: false, locationStatus: 'off' };
  if (settings.locationMode === 'none') return result;
  const manual = settings.location?.trim() || '';
  if (settings.locationMode === 'manual') return { ...result, location: manual, locationSource: '手动指定', locationStatus: 'manual' };
  const named = settings.locationMode === 'auto' ? namedLocation(tags, byteOrder) : null;
  const gps = coordinates(tags);
  if (named || gps) return { ...result, location: named?.text || gps, locationSource: named?.source || 'EXIF GPS 坐标', locationStatus: 'detected' };
  const fallback = settings.locationMode === 'auto' && Boolean(manual);
  return { ...result, location: fallback ? manual : '', locationSource: fallback ? '手动补充' : '未提取到',
    locationMissing: true, locationFallback: fallback, locationStatus: fallback ? 'fallback' : 'missing' };
}
module.exports = { resolveLocation };
