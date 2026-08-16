// MC-Migrate 桌面版主程序
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigration, DEFAULT_PROVIDERS } from './lib/core.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let running = false;
let currentRun = null;

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

ipcMain.handle('file:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '原始碼（Java / Kotlin）', extensions: ['java', 'kt'] },
      { name: '所有檔案', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('models:list', async (e, { provider, apiKey }) => {
  const prov = DEFAULT_PROVIDERS[provider] || {};
  const base = (prov.base_url || '').replace(/\/$/, '');
  const kind = prov.kind || 'openai';
  if (!base || kind === 'mock') return { ok: false, error: '此供應商不支援模型清單' };
  const headers = {};
  if (kind === 'anthropic') headers['x-api-key'] = apiKey;
  else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.data || []).map((m) => m.id).filter(Boolean).slice(0, 200);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('folder:open', async (e, p) => {
  if (p) await shell.openPath(p);
});

ipcMain.handle('run', async (e, params) => {
  if (running) return { ok: false, error: '已有遷移任務執行中' };
  running = true;
  const controller = new AbortController();
  currentRun = controller;
  try {
    params.fromVer = '1.20.1';
    saveSettings(params);
    const send = (type, text) => {
      if (win && !win.isDestroyed()) win.webContents.send('progress', { type, text });
    };
    const summary = await runMigration({ ...params, abort: controller.signal }, send);
    return { ok: true, summary };
  } catch (err) {
    const msg = String((err && err.message) || err);
    return { ok: false, error: msg, cancelled: /已取消/.test(msg) };
  } finally {
    running = false;
    currentRun = null;
  }
});

ipcMain.handle('run:cancel', () => {
  if (currentRun) currentRun.abort();
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
