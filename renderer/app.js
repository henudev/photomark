/* All filesystem access stays in Electron's main process. */
const api = window.photomark;
const $ = id => document.getElementById(id);
let state = {}, defaults = {}, files = [], index = 0, position = 'bottom-right', running = false, original = false;
let previewSequence = 0, previewTimer, toastTimer, saveTimer, previewBusy = false, pendingPreview = false;
let locationPreview = null;
const settingsKeys = ['timeSource', 'manualDate', 'dateFormat', 'locationMode', 'location', 'fontScale', 'margin', 'opacity', 'color', 'shadow', 'background', 'format', 'preserveMetadata', 'recursive'];
function message(text) { $('toast').textContent = cleanError(text); $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 5500); }
function cleanError(error) { return String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
function settings() {
  const result = { position };
  for (const key of settingsKeys) {
    const el = $(key);
    result[key] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
  }
  return result;
}
function applySettings(values) {
  const s = { ...defaults, ...values }; position = s.position;
  for (const key of settingsKeys) { if ($(key).type === 'checkbox') $(key).checked = s[key]; else $(key).value = s[key]; }
  const known = [...$('date-preset').options].some(x => x.value === s.dateFormat);
  $('date-preset').value = known ? s.dateFormat : 'custom';
  updateControls();
}
function updateControls() {
  $('manual-date-field').classList.toggle('hidden', $('timeSource').value !== 'manual');
  updateLocationControls();
  $('dateFormat').classList.toggle('hidden', $('date-preset').value !== 'custom');
  $('date-format-controls').classList.toggle('custom', $('date-preset').value === 'custom');
  $('format-help').classList.toggle('hidden', $('date-preset').value !== 'custom');
  for (const key of ['fontScale', 'margin', 'opacity']) $(`${key}-value`).textContent = `${$(key).value}%`;
  document.querySelectorAll('[data-position]').forEach(button => { const active = button.dataset.position === position; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', active); });
  const format = $('format').value;
  document.querySelectorAll('[name="export-format"]').forEach(input => input.checked = input.value === format);
  $('legacy-format-note').classList.toggle('hidden', format !== 'tiff');
  $('quality-note').textContent = format === 'jpeg'
    ? 'JPG 保留原始尺寸，质量 100、4:4:4；文件通常较小，但仍是有损压缩。'
    : format === 'tiff' ? '兼容旧版 TIFF LZW 无损任务；新任务可选择 PNG 或 JPG。'
    : 'PNG 无损保存水印合成后的画面，保留原始尺寸，文件通常较大。';
}
function updateLocationControls(info) {
  const mode = $('locationMode').value;
  const file = files[index]?.path;
  if (info) locationPreview = { info, mode, file };
  const current = locationPreview?.mode === mode && locationPreview?.file === file ? locationPreview.info : null;
  const manual = mode === 'manual';
  const missing = mode === 'auto' && current?.locationMissing;
  $('location-manual-field').classList.toggle('hidden', !manual && !missing);
  $('location-input-label').textContent = manual ? '手动地点' : '手动补充地点（可选）';
  $('location-scope').textContent = manual ? '应用于本批全部照片。' : '仅用于本批未提取到位置的照片，不覆盖其他照片已有的位置。';
  $('location-status').classList.toggle('hidden', mode === 'none');
  $('location-status').classList.toggle('location-warning', Boolean(current?.locationMissing));
  $('location-tab-indicator').classList.toggle('hidden', !current?.locationMissing);
  $('location-status').textContent = manual ? '本批全部照片使用手动填写的地点。' : !current
    ? files.length ? '正在从照片提取位置信息…' : '选择照片后自动提取位置信息。'
    : current.locationMissing ? current.locationFallback ? `未提取到位置信息，已使用手动补充：${current.location}`
      : mode === 'auto' ? '未提取到位置信息，可在下方手动输入；未填写时省略地点。' : '未提取到 EXIF GPS 坐标；可切换自动模式后手动补充。'
    : `已提取${current.locationSource}：${current.location}`;
  $('location-status').title = $('location-status').textContent;
}
function showPaths() {
  for (const key of ['source', 'output']) { $(`${key}-path`).textContent = state[key] || (key === 'source' ? '选择存放照片的文件夹' : '选择源目录后自动填写'); $(`${key}-path`).title = state[key] || ''; $(`${key}-path`).classList.toggle('empty', !state[key]); }
  $('open-output').disabled = !state.output;
}
function changed() {
  updateControls();
  clearTimeout(saveTimer); saveTimer = setTimeout(() => api.saveSettings(settings()).catch(message), 400);
  schedulePreview();
}
function schedulePreview() {
  previewSequence++; clearTimeout(previewTimer);
  previewTimer = setTimeout(() => updatePreview(), 230);
}
async function updatePreview() {
  if (!files.length) return;
  if (previewBusy) { pendingPreview = true; return; }
  const sequence = previewSequence; previewBusy = true;
  $('empty-state').classList.add('hidden'); $('preview-loading').classList.remove('hidden'); $('preview-error').classList.add('hidden');
  const file = files[index];
  updateLocationControls();
  $('photo-name').textContent = file.name; $('photo-name').title = file.relative;
  $('photo-index').textContent = `${index + 1} / ${files.length}`;
  $('previous').disabled = index === 0; $('next').disabled = index === files.length - 1;
  $('compare').disabled = false; $('zoom').disabled = false; $('compare').textContent = original ? '返回水印效果' : '查看原图';
  try {
    const result = await api.preview(file.path, settings(), original);
    if (sequence !== previewSequence) return;
    $('preview-image').src = result.url; $('preview-image').classList.remove('hidden');
    const info = result.info;
    updateLocationControls(info);
    $('photo-meta').textContent = `${info.width.toLocaleString()} × ${info.height.toLocaleString()} px · ${info.format.toUpperCase()}${info.hasIcc ? ' · ICC 色彩配置' : ''}`;
    $('resolution').textContent = `${info.width} × ${info.height} px`;
    $('time-info').textContent = `时间来源：${info.timeSource}${info.fallback ? '（已自动回退）' : ''}`;
    $('stage-label').textContent = original ? '原图对照 · 未添加水印' : '预览缩略图 · 导出保持原始尺寸';
    $('source-note').classList.toggle('warning', info.fallback || info.locationMissing);
    const notices = [];
    if (info.locationMissing) notices.push(info.locationFallback ? `未提取到位置信息，使用手动补充：${info.location}` : '未提取到位置信息，可手动补充；未填写时省略地点');
    else if (info.location) notices.push(`地点：${info.location}（${info.locationSource}）`);
    if (info.fallback) notices.push(`首选时间缺失，使用${info.timeSource}`);
    else notices.push(info.dateText || '日期已关闭');
    $('source-note').textContent = notices.join(' · ');
    $('source-note').title = $('source-note').textContent;
  } catch (error) {
    if (sequence === previewSequence) { $('preview-image').classList.add('hidden'); $('preview-error').textContent = cleanError(error); $('preview-error').classList.remove('hidden'); $('photo-meta').textContent = '此文件暂不能生成预览，批处理会单独记录错误'; }
  } finally {
    previewBusy = false;
    if (sequence === previewSequence) $('preview-loading').classList.add('hidden');
    if (pendingPreview || sequence !== previewSequence) { pendingPreview = false; updatePreview(); }
  }
}
async function loadPhotos() {
  if (!state.source) return;
  $('scan-summary').textContent = '正在扫描照片…';
  try {
    const result = await api.scan(state.source, $('recursive').checked);
    files = result.files; index = 0; previewSequence++;
    $('scan-summary').textContent = `找到 ${files.length} 张照片${result.unsupported ? ` · ${result.unsupported} 个 HEIC / RAW 不支持` : ''}`;
    $('start').disabled = !files.length;
    $('progress-count').textContent = `共 ${files.length} 张照片 · 等待处理`;
    $('batch-status').textContent = state.lastJob?.source === state.source ? '检测到上次使用的目录。使用相同设置开始时，将核对记录并继续未完成的照片。' : '预览确认后开始处理，原照片不会被覆盖。';
    if (files.length) schedulePreview();
    else { $('empty-state').classList.remove('hidden'); $('preview-image').classList.add('hidden'); $('preview-error').classList.add('hidden'); $('preview-loading').classList.add('hidden'); $('compare').disabled = true; $('previous').disabled = true; $('next').disabled = true; $('photo-index').textContent = '0 / 0'; $('photo-name').textContent = '没有找到支持的照片'; $('photo-meta').textContent = '支持 JPG、PNG、WebP、单页 8 位 TIFF'; }
  } catch (error) { files = []; $('start').disabled = true; $('scan-summary').textContent = '目录无法读取'; message(error); }
}
async function choose(kind) {
  try { const result = await api.chooseDirectory(kind); if (!result) return; state = { ...state, ...result }; showPaths(); if (kind === 'source') { $('progress').value = 0; $('start').textContent = '开始批量处理 →'; $('errors').classList.add('hidden'); await loadPhotos(); } }
  catch (error) { message(error); }
}
function setRunning(value) {
  running = value;
  $('settings-body').querySelectorAll('input,select,button').forEach(el => el.disabled = value);
  for (const id of ['recursive', 'choose-source', 'choose-output', 'reset', 'restore-job', 'format']) $(id).disabled = value;
  $('start').disabled = value || !files.length;
  $('pause').classList.toggle('hidden', !value);
  $('pause').disabled = false;
}
function progress(value) {
  if (!value) return;
  setRunning(value.running);
  const completed = value.done + value.failed;
  $('progress').max = Math.max(1, value.total); $('progress').value = completed;
  $('progress-count').textContent = `成功 ${value.done} / ${value.total}${value.failed ? ` · 失败 ${value.failed}` : ''}`;
  $('batch-title').textContent = value.running ? value.paused ? '正在完成当前照片，随后暂停…' : '正在为照片留下印记' : value.paused ? '任务已暂停，进度已保存' : value.failed ? '处理结束，部分照片需要重试' : '处理完成，回忆已留印';
  $('batch-status').textContent = value.running ? value.currentFile || '正在核对任务记录…' : value.paused ? '点击继续处理，会核对并跳过已完成的照片。关闭应用后仍可恢复。' : value.failed ? '修复下方问题后重试；已完成的照片不会重复处理。' : `已生成 ${value.done} 张照片。可打开输出目录查看作品。`;
  if (value.missingLocations) $('batch-status').textContent += ` ${value.missingLocations} 张未提取到地点：${value.manualLocations} 张使用手动补充，${value.missingLocations - value.manualLocations} 张省略地点。`;
  $('batch-status').title = $('batch-status').textContent;
  $('start').textContent = value.paused ? '继续处理 →' : value.failed ? '重试失败项目 ↻' : '核对并继续 →';
  $('errors').classList.toggle('hidden', !value.errors?.length);
  $('errors-summary').textContent = `${value.failed} 个失败项目 · 查看`;
  $('errors-list').replaceChildren(...(value.errors || []).map(item => { const li = document.createElement('li'); li.textContent = `${item.file}：${item.error}`; return li; }));
}
for (const key of settingsKeys.filter(key => key !== 'recursive')) $(key).addEventListener(['range', 'text', 'color'].includes($(key).type) ? 'input' : 'change', changed);
document.querySelectorAll('[name="export-format"]').forEach(input => input.addEventListener('change', () => {
  if (input.checked) { $('format').value = input.value; changed(); }
}));
$('recursive').addEventListener('change', () => { changed(); loadPhotos(); });
$('date-preset').addEventListener('change', () => { if ($('date-preset').value !== 'custom') $('dateFormat').value = $('date-preset').value; changed(); });
document.querySelectorAll('[data-position]').forEach(button => button.addEventListener('click', () => { position = button.dataset.position; changed(); }));
$('reset').addEventListener('click', () => { const recursive = $('recursive').checked; applySettings({ ...defaults, recursive }); changed(); });
$('choose-source').addEventListener('click', () => choose('source'));
$('empty-choose').addEventListener('click', () => choose('source'));
$('choose-output').addEventListener('click', () => choose('output'));
$('previous').addEventListener('click', () => { if (index > 0) { index--; schedulePreview(); } });
$('next').addEventListener('click', () => { if (index < files.length - 1) { index++; schedulePreview(); } });
$('compare').addEventListener('click', () => { original = !original; schedulePreview(); });
$('open-output').addEventListener('click', () => api.openOutput().catch(message));
$('export-errors').addEventListener('click', () => api.exportErrors().then(file => { if (file) message('失败清单已导出'); }).catch(message));
$('errors').addEventListener('click', () => $('errors-dialog').showModal());
$('errors-close').addEventListener('click', () => $('errors-dialog').close());
function selectTab(name, focus = false) {
  document.querySelectorAll('[data-tab]').forEach(button => {
    const active = button.dataset.tab === name;
    button.classList.toggle('active', active); button.setAttribute('aria-selected', active); button.tabIndex = active ? 0 : -1;
    $(`panel-${button.dataset.tab}`).classList.toggle('hidden', !active);
    if (active && focus) button.focus();
  });
}
document.querySelectorAll('[data-tab]').forEach(button => {
  button.addEventListener('click', () => selectTab(button.dataset.tab));
  button.addEventListener('keydown', event => {
    const names = ['date', 'location', 'style', 'export'];
    const at = names.indexOf(button.dataset.tab);
    const next = event.key === 'ArrowRight' ? (at + 1) % names.length : event.key === 'ArrowLeft' ? (at + names.length - 1) % names.length : event.key === 'Home' ? 0 : event.key === 'End' ? names.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); selectTab(names[next], true); }
  });
});
$('start').addEventListener('click', async () => {
  if (running || !files.length) return;
  setRunning(true);
  $('batch-title').textContent = '正在准备批量处理…';
  $('batch-status').textContent = `输出格式：${{ png: 'PNG', jpeg: 'JPG', tiff: 'TIFF' }[$('format').value]} · 正在扫描并核对处理进度`;
  try { state.lastJob = { source: state.source, output: state.output, settings: settings() }; $('restore-job').classList.remove('hidden'); await api.start(state.source, state.output, settings()); }
  catch (error) { setRunning(false); message(error); $('batch-title').textContent = '任务未能启动'; $('batch-status').textContent = cleanError(error); }
});
$('pause').addEventListener('click', () => { $('pause').disabled = true; $('batch-title').textContent = '正在完成当前照片，随后暂停…'; api.pause().catch(message); });
$('restore-job').addEventListener('click', async () => { if (!state.lastJob) return; try { const restored = await api.restoreJob(); state = { ...state, ...restored }; applySettings(restored.settings); showPaths(); changed(); await loadPhotos(); message('已恢复上次任务的目录与设置，点击开始即可续处理'); } catch (error) { message(error); } });
$('zoom').addEventListener('click', async () => {
  if (!files.length) return;
  $('zoom-dialog').showModal(); $('zoom-info').textContent = '正在生成原始分辨率预览…'; $('zoom-image').removeAttribute('src');
  $('zoom-stage').classList.remove('actual-size'); $('zoom-fit').textContent = '以 1:1 查看';
  try { const result = await api.preview(files[index].path, settings(), original, true); $('zoom-image').src = result.url; $('zoom-info').textContent = `${result.info.width} × ${result.info.height} px · ${original ? '原图' : '水印效果'}`; }
  catch (error) { $('zoom-info').textContent = cleanError(error); }
});
$('zoom-close').addEventListener('click', () => $('zoom-dialog').close());
$('zoom-fit').addEventListener('click', () => { const actual = $('zoom-stage').classList.toggle('actual-size'); $('zoom-fit').textContent = actual ? '适应窗口' : '以 1:1 查看'; });
api.onProgress(progress);
api.onClosing(() => { $('batch-title').textContent = '正在保存进度，随后关闭…'; });
(async () => {
  const initial = await api.init(); defaults = initial.defaults; state = initial.state;
  document.querySelector('.version').textContent = `v${initial.version}`;
  $('platform-label').textContent = initial.platform === 'darwin' ? 'macOS' : initial.platform === 'win32' ? 'Windows x86-64' : initial.platform;
  applySettings(state.settings); showPaths();
  $('restore-job').classList.toggle('hidden', !state.lastJob);
  await loadPhotos();
})().catch(message);
