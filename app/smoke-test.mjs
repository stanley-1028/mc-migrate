// 打包後 exe 的端到端冒煙測試：
// 啟動 MC-Migrate.exe → 用 CDP 在真實 GUI 填入專案路徑並點「開始遷移」→ 驗證產出。
// 用法：node app/smoke-test.mjs

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(ROOT, 'app', 'dist', 'MC-Migrate.exe');
const SAMPLE = path.join(ROOT, 'samples', 'example-mod');
const PORT = 9223;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gui-test-'));
const mod = path.join(tmp, 'mod');
fs.cpSync(SAMPLE, mod, { recursive: true });
fs.rmSync(path.join(mod, '.mc-migrate'), { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const exe = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(1000);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      page = targets.find((t) => t.type === 'page');
    } catch {}
  }
  if (!page) {
    console.error('FAIL：無法取得 GUI 除錯端點');
    spawnSync('taskkill', ['/PID', String(exe.pid), '/T', '/F']);
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const evalJs = (expression) =>
    new Promise((resolve) => {
      const msgId = ++id;
      const onMsg = (ev) => {
        const data = JSON.parse(ev.data);
        if (data.id === msgId) {
          ws.removeEventListener('message', onMsg);
          resolve(data.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });

  const modPath = mod.replace(/\\/g, '\\\\');
  await evalJs(`
    document.getElementById('project').value = '${modPath}';
    document.getElementById('provider').value = 'mock';
    document.getElementById('run').click();
    'ok'
  `);

  let status = '';
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const r = await evalJs(`document.getElementById('status-text').textContent`);
    status = r.result && r.result.value;
    if (status !== '執行中…' && status) break;
  }

  ws.close();
  spawnSync('taskkill', ['/PID', String(exe.pid), '/T', '/F']);

  const reportExists = fs.existsSync(path.join(mod, '.mc-migrate', 'MIGRATION_REPORT.md'));
  const java = fs.existsSync(path.join(mod, 'src', 'main', 'java', 'com', 'example', 'mod', 'ExampleMod.java'))
    ? fs.readFileSync(path.join(mod, 'src', 'main', 'java', 'com', 'example', 'mod', 'ExampleMod.java'), 'utf8')
    : '';
  const ok = status === '完成' && reportExists && java.includes('Registry.registerItem(');

  console.log(`GUI 狀態：${status}`);
  console.log(`報告產出：${reportExists}`);
  console.log(`程式碼已遷移：${java.includes('Registry.registerItem(')}`);
  console.log(ok ? 'PASS：打包後的 GUI 可完成遷移' : 'FAIL：GUI 遷移未成功');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL：', e);
  spawnSync('taskkill', ['/IM', 'MC-Migrate.exe', '/T', '/F']);
  process.exit(1);
});
