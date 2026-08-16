// 打包後 exe 的端到端冒煙測試：
// 啟動 MC-Migrate.exe → CDP 連上真實 GUI → 以 Java 文件模式呼叫遷移 →
// 驗證步驟列 5/5、報告產出、程式碼已遷移、介面結構（無資料夾輸入、有模型下拉）。
// 用法：node app/smoke-test.mjs

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(ROOT, 'app', 'dist', 'MC-Migrate.exe');
const PORT = 9223;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gui-test-'));
const javaA = path.join(tmp, 'ItemClass.java');
const javaB = path.join(tmp, 'CleanClass.java');
fs.writeFileSync(
  javaA,
  'package com.example;\n\nimport net.minecraft.item.Item;\n\npublic class ItemClass {\n    public static final Item X = new Item(new Item.Settings());\n}\n',
  'utf8'
);
const originalB = 'package com.example;\n\npublic class CleanClass {\n}\n';
fs.writeFileSync(javaB, originalB, 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const exe = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(1000);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      page = targets.find((t) => t.type === 'page' && /index\.html/i.test(t.url || ''));
      if (page) console.log(`取得 GUI 端點（第 ${i + 1} 秒）`);
    } catch {}
  }
  if (!page) {
    console.error('FAIL：無法取得 GUI 端點');
    spawnSync('taskkill', ['/PID', String(exe.pid), '/T', '/F']);
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('WebSocket 連線失敗'));
  });
  let id = 0;
  const evalJs = (expression, awaitPromise = false) =>
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
      ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }));
    });

  // 等介面就緒（init 完成，footer 出現版本號）再開始
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const r = await evalJs(`document.getElementById('footerText').textContent`);
    if (r.result && r.result.value && r.result.value.includes('v1.')) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  if (!ready) {
    console.error('FAIL：介面未就緒');
    ws.close();
    spawnSync('taskkill', ['/PID', String(exe.pid), '/T', '/F']);
    process.exit(1);
  }

  const filesJs = JSON.stringify([javaA, javaB]);
  const runRes = await evalJs(
    `window.api.run({ files: ${filesJs}, provider: 'mock', target: '26.2' }).then(r => r.ok ? 'ok' : 'ERR:' + r.error)`,
    true
  );
  console.log(`遷移呼叫結果：${runRes.result && runRes.result.value}`);

  let stepsDone = 0;
  for (let i = 0; i < 60; i++) {
    const r = await evalJs(`document.querySelectorAll('.step.done').length`);
    stepsDone = r.result && r.result.value;
    if (stepsDone === 5) break;
    await sleep(1000);
  }

  const ui = await evalJs(
    `JSON.stringify({
      hasModelSelect: !!document.getElementById('model'),
      noProjectInput: document.getElementById('project') === null,
      hasDropZone: !!document.getElementById('dropZone'),
      hasUpdateButton: !!document.getElementById('checkUpdate'),
      footer: document.getElementById('footerText') ? document.getElementById('footerText').textContent : null
    })`
  );
  const verDiag = await evalJs(
    `window.api.getVersion().then(v => 'V=' + v, e => 'ERR:' + e.message)`,
    true
  );
  console.log(`getVersion 結果：${verDiag.result && verDiag.result.value}`);
  const updDiag = await evalJs(
    `window.api.updateCheck().then(r => JSON.stringify({ ok: r.ok, latest: r.latest, current: r.current, has: r.hasUpdate, err: r.error }))`,
    true
  );
  console.log(`更新檢查結果：${updDiag.result && updDiag.result.value}`);

  ws.close();
  spawnSync('taskkill', ['/PID', String(exe.pid), '/T', '/F']);

  const reportExists = fs.existsSync(path.join(tmp, '.mc-migrate', 'MIGRATION_REPORT.md'));
  const migrated = readOr(javaA, '').includes('Item.of(new Item.Props())');
  const cleanKept = readOr(javaB, '') === originalB;
  const ok =
    runRes.result && runRes.result.value === 'ok' &&
    stepsDone === 5 &&
    reportExists &&
    migrated &&
    cleanKept &&
    ui.result && JSON.parse(ui.result.value).hasModelSelect &&
    ui.result && JSON.parse(ui.result.value).noProjectInput &&
    ui.result && JSON.parse(ui.result.value).hasDropZone &&
    ui.result && JSON.parse(ui.result.value).hasUpdateButton &&
    updDiag.result && JSON.parse(updDiag.result.value).ok === true &&
    /^\d+\.\d+\.\d+$/.test(JSON.parse(updDiag.result.value).latest || '');

  console.log(`步驟列完成：${stepsDone}/5`);
  console.log(`報告產出：${reportExists}`);
  console.log(`程式碼已遷移：${migrated}｜無關檔案保持原樣：${cleanKept}`);
  console.log(`介面結構：${ui.result && ui.result.value}`);
  console.log(ok ? 'PASS：打包後的 GUI 可完成遷移' : 'FAIL：GUI 遷移未成功');
  process.exit(ok ? 0 : 1);
}

function readOr(p, fallback) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : fallback;
}

main().catch((e) => {
  console.error('FAIL：', e);
  spawnSync('taskkill', ['/IM', 'MC-Migrate.exe', '/T', '/F']);
  process.exit(1);
});
