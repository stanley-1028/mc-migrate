// MC-Migrate 桌面版主程序
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigration } from './lib/core.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let running = false;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf8');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: '#f3f7f3',
    title: 'MC-Migrate',
    icon: path.join(APP_DIR, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(APP_DIR, 'ui', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.handle('settings:load', () => loadSettings());

ipcMain.handle('settings:save', (e, s) => saveSettings(s));

ipcMain.handle('folder:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('folder:open', async (e, p) => {
  if (p) await shell.openPath(p);
});

ipcMain.handle('run', async (e, params) => {
  if (running) return { ok: false, error: '已有遷移任務執行中' };
  running = true;
  try {
    saveSettings(params);
    const send = (type, text) => {
      if (win && !win.isDestroyed()) win.webContents.send('progress', { type, text });
    };
    const summary = await runMigration(params, send);
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    running = false;
  }
});

ipcMain.handle('artifact:save', async (e, { kind, filePath }) => {
  const name = kind === 'report' ? 'MIGRATION_REPORT.md' : 'migration.patch';
  const filters =
    kind === 'report'
      ? [{ name: 'Markdown', extensions: ['md'] }]
      : [{ name: 'Patch', extensions: ['patch'] }];
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters });
  if (r.canceled || !r.filePath) return null;
  fs.copyFileSync(filePath, r.filePath);
  return r.filePath;
});
