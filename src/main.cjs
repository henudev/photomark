const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Batch, scan } = require('./batch.cjs');
const { render } = require('./image.cjs');
const { DEFAULTS, normalizeSettings, migratePreferences } = require('./settings.cjs');
const { atomicJson, readJson } = require('./storage.cjs');
if (process.env.PHOTOMARK_TEST_USER_DATA) app.setPath('userData', process.env.PHOTOMARK_TEST_USER_DATA);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
let window, state = {}, configPath;
const batch = new Batch();
const allowedFiles = new Set();
let previewTail = Promise.resolve();
batch.on('progress', value => { if (window && !window.isDestroyed()) window.webContents.send('batch:progress', value); });
async function saveState(patch) { state = { ...state, ...patch }; await atomicJson(configPath, state); return state; }
async function scanAllowed(source, recursive) {
  const result = await scan(source, recursive);
  allowedFiles.clear(); result.files.forEach(file => allowedFiles.add(file.path));
  return result;
}
function installHandlers() {
  ipcMain.handle('app:init', () => ({ defaults: DEFAULTS, state, platform: process.platform, version: app.getVersion() }));
  ipcMain.handle('directory:choose', async (_, kind) => {
    if (batch.running) throw new Error('请先暂停当前任务');
    const result = await dialog.showOpenDialog(window, { title: kind === 'source' ? '选择照片源目录' : '选择输出目录', properties: ['openDirectory', ...(kind === 'output' ? ['createDirectory'] : [])] });
    if (result.canceled) return null;
    const selected = result.filePaths[0];
    if (kind === 'source') await saveState({ source: selected, output: `${selected}_水印` });
    else await saveState({ output: selected });
    return { source: state.source, output: state.output };
  });
  ipcMain.handle('directory:scan', (_, source, recursive) => scanAllowed(source, recursive));
  ipcMain.handle('settings:save', (_, settings) => saveState({ settings: normalizeSettings(settings) }));
  ipcMain.handle('job:restore', async () => {
    if (batch.running || !state.lastJob) throw new Error('没有可恢复的任务');
    await saveState(state.lastJob);
    return { source: state.source, output: state.output, settings: state.settings };
  });
  ipcMain.handle('image:preview', (_, file, settings, original, fullResolution) => {
    if (!allowedFiles.has(file)) throw new Error('请先选择照片目录');
    const task = previewTail.catch(() => {}).then(async () => {
      const { buffer, info } = await render(file, settings, { preview: true, original: Boolean(original), fullResolution: Boolean(fullResolution) });
      return { url: `data:image/png;base64,${buffer.toString('base64')}`, info };
    });
    previewTail = task.then(() => undefined, () => undefined);
    return task;
  });
  ipcMain.handle('batch:start', async (_, source, output, settings) => {
    if (batch.running) throw new Error('任务正在运行');
    if (!source || !output) throw new Error('请选择源目录与目标目录');
    const normalized = normalizeSettings(settings);
    await saveState({ source, output, settings: normalized, lastJob: { source, output, settings: normalized } });
    return batch.run(source, output, normalized);
  });
  ipcMain.handle('batch:pause', () => { batch.pause(); return batch.snapshot(); });
  ipcMain.handle('directory:open', async () => {
    if (!state.output) return;
    const error = await shell.openPath(state.output);
    if (error) throw new Error(error);
  });
  ipcMain.handle('errors:export', async () => {
    const errors = batch.snapshot()?.errors || [];
    const result = await dialog.showSaveDialog(window, { defaultPath: 'PhotoMark-失败清单.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (result.canceled) return;
    const cell = value => '"' + String(value).replace(/^[=+@-]/, "'$&").replaceAll('"', '""') + '"';
    await fs.writeFile(result.filePath, '\ufeff文件,错误\r\n' + errors.map(x => `${cell(x.file)},${cell(x.error)}`).join('\r\n'));
    return result.filePath;
  });
}
async function start() {
  configPath = path.join(app.getPath('userData'), 'preferences.json');
  let startupWarning = '';
  try { state = await readJson(configPath, {}); } catch (error) { startupWarning = error.message; state = {}; }
  const migrated = migratePreferences(state);
  if (migrated !== state) { state = migrated; await atomicJson(configPath, state); }
  if (process.argv.includes('--demo')) state = { ...state, source: path.join(__dirname, '../demo-photos'), output: path.join(__dirname, '../demo-output'), settings: { ...DEFAULTS, location: '杭州 · 西湖', timeSource: 'filename' } };
  installHandlers();
  window = new BrowserWindow({ width: 1350, height: 920, minWidth: 1040, minHeight: 740, title: 'PhotoMark · 照片水印', backgroundColor: '#f5f6f8',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(path.join(__dirname, '../renderer/index.html'));
  if (startupWarning) dialog.showMessageBox(window, { type: 'warning', message: '上次偏好设置无法读取，已使用默认值', detail: startupWarning });
  window.on('close', event => {
    if (!batch.running) return;
    event.preventDefault(); batch.pause();
    window.webContents.send('app:closing');
    batch.once('progress', function finish(value) {
      if (value?.running) { batch.once('progress', finish); return; }
      window.destroy(); app.quit();
    });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'PhotoMark', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }] },
  ]));
}
if (gotLock) {
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('PhotoMark 启动失败', error.stack || error.message); app.quit(); });
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
}
