#!/usr/bin/env node
// Minecraft 模組版本升級 AI 工具 — CLI 入口（核心邏輯在 lib/core.mjs）
// 用法：node migrate.mjs <project> [選項]

import { parseArgs } from 'node:util';
import { runMigration } from './lib/core.mjs';

const USAGE = `Minecraft 模組版本升級 AI 工具
用法：node migrate.mjs <project> [選項]
  或：node migrate.mjs --files <java檔...> [選項]   （直接遷移指定檔案，不需完整專案）
  --from-ver <版本>     來源版本（預設 1.20.1）
  --target <版本>       目標版本（預設 26.2）
  --env <路徑>          環境文檔（預設 mcenv/<from>_to_<target>.md）
  --provider <名稱>     供應商：deepseek/openai/ollama/anthropic/gemini/openrouter/mock
  --model <名稱>        模型（覆蓋設定檔）
  --max-iterations <n>  建構失敗修正上限（預設 5）
  --dry-run             只出計畫與預估變更，不寫任何檔案
  --build-cmd <指令>    建構/驗證指令（預設：專案有 gradlew 才執行）
  --no-build            跳過建構驗證
  --force               git 工作目錄不乾淨時仍繼續
  --config <路徑>       設定檔（預設工具目錄 migrate.json）
  --skills-dir <路徑>   Skills 目錄（預設工具目錄 skills/）`;

function parseCli() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'from-ver': { type: 'string', default: '1.20.1' },
      target: { type: 'string', default: '26.2' },
      env: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'max-iterations': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'build-cmd': { type: 'string' },
      'no-build': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      config: { type: 'string' },
      'skills-dir': { type: 'string' },
      files: { type: 'string', multiple: true },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!positionals.length && !(values.files && values.files.length)) {
    console.log(USAGE);
    process.exit(1);
  }
  const maxIterations =
    values['max-iterations'] === undefined ? null : parseInt(values['max-iterations'], 10);
  if (maxIterations !== null && (!Number.isInteger(maxIterations) || maxIterations < 1)) {
    console.error('錯誤：--max-iterations 需為正整數');
    process.exit(1);
  }
  return { project: positionals[0] || null, ...values, maxIterations };
}

const opts = parseCli();
runMigration(
  {
    project: opts.project,
    files: opts.files && opts.files.length ? opts.files : null,
    fromVer: opts['from-ver'],
    target: opts.target,
    env: opts.env,
    provider: opts.provider,
    model: opts.model,
    maxIterations: opts.maxIterations,
    dryRun: opts['dry-run'],
    buildCmd: opts['build-cmd'],
    noBuild: opts['no-build'],
    force: opts.force,
    config: opts.config,
    skillsDir: opts['skills-dir'],
  },
  (type, text) => {
    if (type === 'warn' || type === 'error') console.error(text);
    else console.log(text);
  }
).then(
  () => {
    process.exitCode = 0;
  },
  (e) => {
    console.error(`錯誤：${(e && e.message) || e}`);
    process.exitCode = 1;
  }
);
