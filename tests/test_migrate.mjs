// 遷移工具的驗收測試（node:test，零框架）
// 執行：node tests/test_migrate.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATE = path.join(ROOT, 'migrate.mjs');
const SAMPLE = path.join(ROOT, 'samples', 'example-mod');
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
  const r = run([mod, '--provider', 'mock']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const java = read(path.join(mod, JAVA));
  assert.ok(java.includes('Item.of(new Item.Props())'), '物品建構器遷移');
  assert.ok(java.includes('Registry.registerItem('), '註冊表遷移');
  assert.ok(java.includes('ServerWorldEvents.WORLD_LOAD'), '事件更名');
  assert.ok(java.includes('MC-MIGRATE-REVIEW'), '不確定變更已標註');
  assert.ok(!java.includes('Registry.register(Registries.ITEM'), '舊 API 已移除');
  const props = read(path.join(mod, PROPS));
  assert.ok(props.includes('minecraft_version=26.3'), 'minecraft 版本');
  assert.ok(props.includes('yarn_mappings=26.3+build.1'), 'mappings 版本');
  const fmj = JSON.parse(read(path.join(mod, FMJ)));
  assert.equal(fmj.schemaVersion, 2, 'schemaVersion');
  assert.equal(fmj.depends.minecraft, '>=26.3', 'minecraft 依賴');
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
  const r = run([mod, '--provider', 'mock', '--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('未寫入'), 'dry-run 提示');
  assert.deepEqual(snapshot(mod), before, '檔案未變更');
  assert.ok(!fs.existsSync(path.join(mod, '.mc-migrate')), '未建立工作目錄');
});

test('中斷續跑：已完成檔案不重複處理，新檔案接續遷移', () => {
  const mod = freshMod();
  assert.equal(run([mod, '--provider', 'mock']).status, 0);
  const after1 = snapshot(mod);
  const extraRel = 'src/main/java/com/example/mod/ExtraItem.java';
  const extra = path.join(mod, ...extraRel.split('/'));
  fs.mkdirSync(path.dirname(extra), { recursive: true });
  fs.writeFileSync(
    extra,
    'package com.example.mod;\n\nimport net.minecraft.item.Item;\nimport net.minecraft.registry.Registries;\nimport net.minecraft.registry.Registry;\nimport net.minecraft.util.Identifier;\n\npublic class ExtraItem {\n    public static void init() {\n        Registry.register(Registries.ITEM, new Identifier("example-mod", "extra_item"), new Item(new Item.Settings()));\n    }\n}\n',
    'utf8'
  );
  const r2 = run([mod, '--provider', 'mock']);
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
  const r = run([mod, '--provider', 'mock', '--max-iterations', '2', '--build-cmd', cmd]);
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
  const r = run([mod, '--provider', 'mock']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(g(['branch', '--show-current']).stdout.trim(), 'mc-migrate/26.3', '遷移在新分支執行');
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

test('自備 Key 檢查：真實供應商無 Key 時給出明確指引', () => {
  const mod = freshMod();
  const r = run([mod, '--provider', 'deepseek'], { env: { ...process.env, MC_MIGRATE_API_KEY: '' } });
  assert.notEqual(r.status, 0, '無 Key 應失敗');
  assert.ok(r.stderr.includes('API Key'), r.stderr);
});
