// MC-Migrate 桌面版主程序
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runMigration, DEFAULT_PROVIDERS } from './lib/core.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'stanley-1028/mc-migrate';
let win = null;
let running = false;
let currentRun = null;

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

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
  // 不加 filters：某些 Windows 環境下篩選會導致檔案不顯示；類型/大小由核心檢查
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
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

// ---------- 自動更新（GitHub Release） ----------
ipcMain.handle('update:check', async () => {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'MC-Migrate', accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const latest = String(data.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    const asset = (data.assets || []).find((a) => /\.exe$/i.test(a.name || ''));
    if (!asset) return { ok: false, error: '最新 Release 沒有 exe 資產' };
    return {
      ok: true,
      current,
      latest,
      hasUpdate: cmpVersion(latest, current) > 0,
      url: asset.browser_download_url,
      size: asset.size,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('update:install', async (e, url) => {
  const original = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!original) return { ok: false, error: '開發模式不支援自動更新，請手動下載新版 exe' };
  try {
    const tmp = original + '.new';
    const res = await fetch(url, {
      signal: AbortSignal.timeout(900000),
      headers: { 'user-agent': 'MC-Migrate' },
    });
    if (!res.ok) return { ok: false, error: `下載失敗 HTTP ${res.status}` };
    const total = Number(res.headers.get('content-length') || 0);
    const out = fs.createWriteStream(tmp);
    let done = 0;
    let lastPct = -1;
    for await (const chunk of res.body) {
      done += chunk.length;
      out.write(chunk);
      const pct = total ? Math.floor((done / total) * 100) : -1;
      if (pct >= 0 && pct - lastPct >= 5 && win && !win.isDestroyed()) {
        win.webContents.send('update:progress', { done, total, pct });
        lastPct = pct;
      }
    }
    await new Promise((resolve, reject) => {
      out.on('close', resolve);
      out.on('error', reject);
      out.end();
    });
    const bat = original.replace(/\.exe$/i, '') + '_update.bat';
    fs.writeFileSync(
      bat,
      '@echo off\r\ntimeout /t 2 >nul\r\nmove /y "' + tmp + '" "' + original + '" >nul\r\nstart "" "' + original + '"\r\ndel "%~f0"\r\n'
    );
    spawn(bat, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    setTimeout(() => app.quit(), 800);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
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
