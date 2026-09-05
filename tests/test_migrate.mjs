// 遷移工具的驗收測試（node:test，零框架）
// 執行：node tests/test_migrate.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitChunks } from '../lib/core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATE = path.join(ROOT, 'migrate.mjs');
const SAMPLE = path.join(ROOT, 'samples', 'example-mod');
// mock 文字對照需要「人工範例」文檔（官方文檔無重命名對照資料）
const EXAMPLE_ENV = path.join(ROOT, 'mcenv', 'example_fabric_1.20.1_to_26.2.md');
const NODE = process.execPath;
const JAVA = 'src/main/java/com/example/mod/ExampleMod.java';
const PROPS = 'gradle.properties';
const FMJ = 'src/main/resources/fabric.mod.json';
const RECIPE = 'src/main/resources/data/example-mod/recipes/example_recipe.json';
const LANG = 'src/main/resources/assets/example-mod/lang/en_us.json';

function freshMod() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-migrate-test-'));
  const mod = path.join(tmp, 'mod');
  fs.cpSync(SAMPLE, mod, { recursive: true });
  fs.rmSync(path.join(mod, '.mc-migrate'), { recursive: true, force: true });
  return mod;
}

function run(args, opts = {}) {
  return spawnSync(NODE, [MIGRATE, ...args], { encoding: 'utf8', ...opts });
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== '.mc-migrate' && e.name !== '.git') walk(p);
      } else {
        out[path.relative(root, p)] = read(p);
      }
    }
  };
  walk(root);
  return out;
}

test('mock 端到端遷移：程式碼/建構/配方依環境文檔變更，語意保留', () => {
  const mod = freshMod();
  const r = run([mod, '--provider', 'mock', '--env', EXAMPLE_ENV]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const java = read(path.join(mod, JAVA));
  assert.ok(java.includes('Item.of(new Item.Props())'), '物品建構器遷移');
  assert.ok(java.includes('Registry.registerItem('), '註冊表遷移');
  assert.ok(java.includes('ServerWorldEvents.WORLD_LOAD'), '事件更名');
  assert.ok(java.includes('MC-MIGRATE-REVIEW'), '不確定變更已標註');
  assert.ok(!java.includes('Registry.register(Registries.ITEM'), '舊 API 已移除');
  const props = read(path.join(mod, PROPS));
  assert.ok(props.includes('minecraft_version=26.2'), 'minecraft 版本');
  assert.ok(props.includes('yarn_mappings=26.2+build.1'), 'mappings 版本');
  const fmj = JSON.parse(read(path.join(mod, FMJ)));
  assert.equal(fmj.schemaVersion, 2, 'schemaVersion');
  assert.equal(fmj.depends.minecraft, '>=26.2', 'minecraft 依賴');
  assert.equal(fmj.depends.java, '>=21', 'java 依賴');
  const recipe = JSON.parse(read(path.join(mod, RECIPE)));
  assert.deepEqual(recipe.result, { item: 'minecraft:cobblestone' }, '配方格式遷移');
  assert.equal(read(path.join(mod, LANG)), read(path.join(SAMPLE, LANG)), '語言檔語意不變');
  const report = read(path.join(mod, '.mc-migrate', 'MIGRATION_REPORT.md'));
  assert.ok(report.includes('需人工確認') && report.includes('ServerWorldEvents'), '報告含風險清單');
  const patch = read(path.join(mod, '.mc-migrate', 'migration.patch'));
  assert.ok(patch.includes('registerItem'), 'patch 含實際差異');
  assert.ok(fs.existsSync(path.join(mod, '.mc-migrate', 'backup', JAVA)), '原檔已備份');
  const state = JSON.parse(read(path.join(mod, '.mc-migrate', 'state.json')));
  assert.equal(state.files[JAVA].status, 'done', '狀態已記錄');
});

test('--dry-run 不寫任何檔案', () => {
  const mod = freshMod();
  const before = snapshot(mod);
  const r = run([mod, '--provider', 'mock', '--dry-run', '--env', EXAMPLE_ENV]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('未寫入'), 'dry-run 提示');
  assert.deepEqual(snapshot(mod), before, '檔案未變更');
  assert.ok(!fs.existsSync(path.join(mod, '.mc-migrate')), '未建立工作目錄');
});

test('中斷續跑：已完成檔案不重複處理，新檔案接續遷移', () => {
  const mod = freshMod();
  assert.equal(run([mod, '--provider', 'mock', '--env', EXAMPLE_ENV]).status, 0);
  const after1 = snapshot(mod);
  const extraRel = 'src/main/java/com/example/mod/ExtraItem.java';
  const extra = path.join(mod, ...extraRel.split('/'));
  fs.mkdirSync(path.dirname(extra), { recursive: true });
  fs.writeFileSync(
    extra,
    'package com.example.mod;\n\nimport net.minecraft.item.Item;\nimport net.minecraft.registry.Registries;\nimport net.minecraft.registry.Registry;\nimport net.minecraft.util.Identifier;\n\npublic class ExtraItem {\n    public static void init() {\n        Registry.register(Registries.ITEM, new Identifier("example-mod", "extra_item"), new Item(new Item.Settings()));\n    }\n}\n',
    'utf8'
  );
  const r2 = run([mod, '--provider', 'mock', '--env', EXAMPLE_ENV]);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  const migrated = read(extra);
  assert.ok(migrated.includes('Registry.registerItem('), '新檔案接續遷移');
  assert.ok(migrated.includes('Item.of(new Item.Props())'), '新檔案接續遷移（建構器）');
  const after2 = snapshot(mod);
  for (const [rel, content] of Object.entries(after1)) {
    if (rel === extraRel) continue;
    assert.equal(after2[rel], content, `檔案 ${rel} 未被重複修改`);
  }
});

test('迭代修正：建構持續失敗，達上限後停止並在報告標示未解決', () => {
  const mod = freshMod();
  const checker = path.join(ROOT, 'tests', 'build_check.mjs');
  const cmd = `"${NODE}" "${checker}" .`;
  const r = run([mod, '--provider', 'mock', '--env', EXAMPLE_ENV, '--max-iterations', '2', '--build-cmd', cmd]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = read(path.join(mod, '.mc-migrate', 'MIGRATION_REPORT.md'));
  assert.ok(report.includes('未解決'), '報告標示未解決問題');
  assert.ok(report.includes('已達上限'), '迭代達上限並停止');
});

test('git 安全：在新分支執行；工作目錄不乾淨時中止', (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git 不可用');
    return;
  }
  const mod = freshMod();
  const g = (args) => spawnSync('git', args, { cwd: mod, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.name', 'test']);
  g(['config', 'user.email', 'test@test.invalid']);
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  const r = run([mod, '--provider', 'mock', '--env', EXAMPLE_ENV]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(g(['branch', '--show-current']).stdout.trim(), 'mc-migrate/26.2', '遷移在新分支執行');
  assert.ok(read(path.join(mod, JAVA)).includes('Registry.registerItem('), '分支上已完成遷移');

  const mod2 = freshMod();
  const g2 = (args) => spawnSync('git', args, { cwd: mod2, encoding: 'utf8' });
  g2(['init', '-q']);
  g2(['config', 'user.name', 'test']);
  g2(['config', 'user.email', 'test@test.invalid']);
  g2(['add', '-A']);
  g2(['commit', '-qm', 'init']);
  fs.appendFileSync(path.join(mod2, PROPS), '\n# dirty\n');
  const r2 = run([mod2, '--provider', 'mock']);
  assert.notEqual(r2.status, 0, '不乾淨時中止');
  assert.ok(r2.stderr.includes('不乾淨'), r2.stderr);
});

test('--files 直接遷移指定的 Java 文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-files-test-'));
  const a = path.join(dir, 'ItemClass.java');
  const b = path.join(dir, 'CleanClass.java');
  fs.writeFileSync(
    a,
    'package com.example;\n\nimport net.minecraft.item.Item;\n\npublic class ItemClass {\n    public static final Item X = new Item(new Item.Settings());\n}\n',
    'utf8'
  );
  const originalB = 'package com.example;\n\npublic class CleanClass {\n}\n';
  fs.writeFileSync(b, originalB, 'utf8');
  const r = run(['--files', a, b, '--env', EXAMPLE_ENV, '--provider', 'mock']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(read(a).includes('Item.of(new Item.Props())'), '指定檔案已遷移');
  assert.equal(read(b), originalB, '未受影響的檔案保持原樣');
  assert.ok(fs.existsSync(path.join(dir, '.mc-migrate', 'MIGRATION_REPORT.md')), '報告產出');
  assert.ok(fs.existsSync(path.join(dir, '.mc-migrate', 'backup', 'ItemClass.java')), '備份產出');
});

test('splitChunks：大檔分段且重組無損', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `// filler line ${i}`);
  const content = lines.join('\n');
  const chunks = splitChunks(content, 500);
  assert.ok(chunks.length > 1, '分成多段');
  assert.ok(chunks.every((c) => c.length <= 600), '每段不超過上限');
  assert.equal(chunks.join('\n'), content, '重組後與原檔一致');
  const hard = splitChunks('x'.repeat(3000), 500);
  assert.equal(hard.length, 6, '超長單行硬切');
});

test('大型檔案分段遷移：單一請求不超過上限（413 防護）', async () => {
  let maxBody = 0;
  let requests = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests++;
      maxBody = Math.max(maxBody, body.length);
      let user = '';
      try {
        const data = JSON.parse(body);
        user = data.messages.find((m) => m.role === 'user').content;
      } catch {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: user } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-chunk-test-'));
  const big = path.join(dir, 'BigClass.java');
  const content =
    Array.from({ length: 3000 }, (_, i) => `// filler line ${i}`).join('\n') +
    '\n    public static final Item X = new Item(new Item.Settings());\n';
  fs.writeFileSync(big, content, 'utf8');
  const cfg = path.join(dir, 'fake.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      provider: 'fake',
      providers: { fake: { base_url: `http://127.0.0.1:${port}/v1`, model: 'fake-model' } },
    }),
    'utf8'
  );
  const r = spawn(NODE, [MIGRATE, '--files', big, '--provider', 'fake', '--config', cfg], { encoding: 'utf8' });
  let output = '';
  r.stdout.on('data', (d) => (output += d));
  r.stderr.on('data', (d) => (output += d));
  const code = await new Promise((resolve) => r.on('exit', resolve));
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  assert.equal(code, 0, output);
  assert.ok(requests >= 4, `分段呼叫數（${requests}）`);
  assert.ok(maxBody < 40000, `單一請求大小 ${maxBody} bytes 未超上限`);
  assert.ok(output.includes('遷移段 1/'), '有分段進度輸出');
  assert.ok(fs.existsSync(path.join(dir, '.mc-migrate', 'MIGRATION_REPORT.md')), '報告產出');
});

test('files 模式拒絕二進位與超大檔案', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-guard-test-'));
  const cls = path.join(dir, 'mod.class');
  fs.writeFileSync(cls, 'x'.repeat(1000));
  const r1 = run(['--files', cls, '--provider', 'mock']);
  assert.notEqual(r1.status, 0, 'class 應被拒絕');
  assert.ok(/二進位|壓縮/.test(r1.stderr), r1.stderr);
  const big = path.join(dir, 'Huge.java');
  fs.writeFileSync(big, '// filler line\n'.repeat(600000)); // 約 8.4MB > 5MB 上限
  const r2 = run(['--files', big, '--provider', 'mock']);
  assert.notEqual(r2.status, 0, '超大檔應被拒絕');
  assert.ok(r2.stderr.includes('過大'), r2.stderr);
});

test('大型原始碼檔（未超上限）可正常遷移', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-large-ok-test-'));
  const f = path.join(dir, 'Large.java');
  fs.writeFileSync(
    f,
    '// filler\n'.repeat(30000) + '    public static final Item X = new Item(new Item.Settings());\n'
  );
  const r = run(['--files', f, '--env', EXAMPLE_ENV, '--provider', 'mock']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(read(f).includes('Item.of(new Item.Props())'), '大檔已遷移');
});

test('jar 模式：解壓、遷移文字內容、重新打包，.class 不動', (t) => {
  if (spawnSync('tar', ['--version']).status !== 0) {
    t.skip('無 tar 可用');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-jar-test-'));
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'com', 'example'), { recursive: true });
  fs.writeFileSync(
    path.join(src, 'fabric.mod.json'),
    JSON.stringify({ schemaVersion: 1, id: 'm', depends: { minecraft: '~1.20.1' } }, null, 2)
  );
  fs.writeFileSync(
    path.join(src, 'com', 'example', 'ItemClass.java'),
    'package com.example;\nimport net.minecraft.item.Item;\npublic class ItemClass {\n    public static final Item X = new Item(new Item.Settings());\n}\n'
  );
  fs.writeFileSync(
    path.join(src, 'com', 'example', 'ItemClass.class'),
    'CLASSBLOB new Item(new Item.Settings()) Registry.register(Registries.ITEM,'
  );
  const jar = path.join(dir, 'mod.jar');
  const mk = spawnSync('tar', ['--format', 'zip', '-cf', jar, '-C', src, '.'], { encoding: 'utf8' });
  assert.equal(mk.status, 0, mk.stderr);
  const r = run(['--files', jar, '--env', EXAMPLE_ENV, '--provider', 'mock']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const outJar = path.join(dir, 'mod-26.2.jar');
  assert.ok(fs.existsSync(outJar), '新 jar 產出');
  const extractDir = jar + '.src';
  assert.equal(JSON.parse(read(path.join(extractDir, 'fabric.mod.json'))).schemaVersion, 2, 'jar 內 fabric.mod.json 已遷移');
  assert.ok(read(path.join(extractDir, 'com', 'example', 'ItemClass.java')).includes('Item.of(new Item.Props())'), 'jar 內原始碼已遷移');
  assert.ok(read(path.join(extractDir, 'com', 'example', 'ItemClass.class')).includes('new Item(new Item.Settings())'), '.class 未被更動');
  const verify = path.join(dir, 'verify');
  fs.mkdirSync(verify);
  const ex2 = spawnSync('tar', ['-xf', outJar, '-C', verify], { encoding: 'utf8' });
  assert.equal(ex2.status, 0, ex2.stderr);
  assert.equal(JSON.parse(read(path.join(verify, 'fabric.mod.json'))).schemaVersion, 2, '新 jar 內容已更新');
  const entries = spawnSync('tar', ['-tf', outJar], { encoding: 'utf8' }).stdout.replace(/\r?\n/g, ' ').trim();
  assert.ok(entries.includes('fabric.mod.json') && !entries.includes('./'), `條目無 ./ 前綴：${entries}`);
  assert.ok(!entries.includes('.mc-migrate'), '工具產物未打包進 jar');
});

test('跨載入器：mock 被擋下並提示使用真實模型', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-loader-mock-test-'));
  const f = path.join(dir, 'Mod.java');
  fs.writeFileSync(f, 'import net.minecraftforge.fml.common.Mod;\n@Mod("m")\npublic class Mod {}\n');
  const r = run(['--files', f, '--provider', 'mock', '--loader-to', 'neoforge']);
  assert.notEqual(r.status, 0, 'mock 跨載入器應失敗');
  assert.ok(r.stderr.includes('跨載入器'), r.stderr);
});

test('跨載入器：偵測來源、解析路徑文檔並以 LLM 遷移（fake）', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests++;
      let user = '';
      try {
        const data = JSON.parse(body);
        user = data.messages.find((m) => m.role === 'user').content;
      } catch {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: user } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-loader-fake-test-'));
  const f = path.join(dir, 'Mod.java');
  fs.writeFileSync(f, 'import net.minecraftforge.fml.common.Mod;\n@Mod("m")\npublic class Mod {}\n');
  const cfg = path.join(dir, 'fake.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      provider: 'fake',
      providers: { fake: { base_url: `http://127.0.0.1:${port}/v1`, model: 'fake-model' } },
    })
  );
  const child = spawn(NODE, [MIGRATE, '--files', f, '--provider', 'fake', '--config', cfg, '--loader-to', 'neoforge'], { encoding: 'utf8' });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  assert.equal(code, 0, output);
  assert.ok(requests >= 1, `LLM 呼叫數（${requests}）`);
  assert.ok(output.includes('forge_1.20.1_to_neoforge_26.2.md'), '解析到跨載入器路徑文檔');
});

test('跨載入器：由深層檔案向上偵測 build.gradle 中的載入器', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-loader-up-test-'));
  fs.mkdirSync(path.join(dir, 'src', 'main', 'java', 'com', 'example'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'build.gradle'),
    'plugins {\n    id "fabric-loom" version "1.5-SNAPSHOT"\n}\n'
  );
  const f = path.join(dir, 'src', 'main', 'java', 'com', 'example', 'Plain.java');
  fs.writeFileSync(f, 'public class Plain { public static final int X = 1; }\n');
  const r = run(['--files', f, '--provider', 'mock', '--loader-to', 'neoforge']);
  assert.notEqual(r.status, 0, 'mock 跨載入器應失敗');
  assert.ok(r.stderr.includes('跨載入器'), 'mock 阻擋優先');
  const cfg = path.join(dir, 'fake.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({ provider: 'fake', providers: { fake: { base_url: 'http://127.0.0.1:9/v1', model: 'm' } } })
  );
  const r2 = run(['--files', f, '--provider', 'fake', '--config', cfg, '--loader-to', 'neoforge']);
  assert.notEqual(r2.status, 0, '無 fabric→neoforge 文檔應失敗');
  assert.ok(r2.stderr.includes('fabric_1.20.1_to_neoforge_26.2.md'), '向上偵測到 fabric（文檔路徑正確）');
});

test('跨載入器：偵測失敗給出指引，手動指定來源後成功', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests++;
      let user = '';
      try {
        const data = JSON.parse(body);
        user = data.messages.find((m) => m.role === 'user').content;
      } catch {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: user } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-loader-from-test-'));
  const f = path.join(dir, 'Plain.java');
  fs.writeFileSync(f, 'public class Plain { public static final int X = 1; }\n');
  const cfg = path.join(dir, 'fake.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      provider: 'fake',
      providers: { fake: { base_url: `http://127.0.0.1:${port}/v1`, model: 'fake-model' } },
    })
  );
  const runAsync = (args) => {
    const child = spawn(NODE, [MIGRATE, ...args], { encoding: 'utf8' });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    return new Promise((resolve) => child.on('exit', (code) => resolve({ code, output })));
  };
  const r1 = await runAsync(['--files', f, '--provider', 'fake', '--config', cfg, '--loader-to', 'neoforge']);
  assert.notEqual(r1.code, 0, '無載入器痕跡應失敗');
  assert.ok(r1.output.includes('無法偵測來源載入器'), r1.output);
  assert.equal(requests, 0, '偵測失敗不應呼叫 LLM');
  const r2 = await runAsync(['--files', f, '--provider', 'fake', '--config', cfg, '--loader-to', 'neoforge', '--loader-from', 'forge']);
  assert.equal(r2.code, 0, r2.output);
  assert.ok(r2.output.includes('forge_1.20.1_to_neoforge_26.2.md'), '手動指定來源後解析到路徑文檔');
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
});

test('自備 Key 檢查：真實供應商無 Key 時給出明確指引', () => {
  const mod = freshMod();
  const r = run([mod, '--provider', 'deepseek'], { env: { ...process.env, MC_MIGRATE_API_KEY: '' } });
  assert.notEqual(r.status, 0, '無 Key 應失敗');
  assert.ok(r.stderr.includes('API Key'), r.stderr);
});
