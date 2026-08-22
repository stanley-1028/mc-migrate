// Minecraft 模組版本升級 AI 工具 — 核心（CLI 與 GUI 共用）
// 四大部件：環境文檔(mcenv/) 資料驅動、LLM 接口抽象、Skills 外置(skills/)、Agent 流程編排。
// ponytail: LLM 走 OpenAI 相容 HTTP（Anthropic 例外分支）；
//           mock 供應商 = 環境文檔「遷移對照」表的文字替換，供離線演示與流程測試。
// 事件：emit(type, text)，type ∈ log|warn|error|done；錯誤一律 throw（由呼叫端處理）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
// 資源預設位置：lib/core.mjs 的上層（CLI 為專案根，桌面版為 app/ 根）
const RES_DIR = path.resolve(TOOL_DIR, '..');
const FILE_EXTS = new Set(['.java', '.kt', '.json', '.toml', '.properties', '.gradle', '.mcmeta']);
const SKIP_DIRS = new Set(['build', '.gradle', '.idea', 'bin', 'out', '.git', '.mc-migrate', 'run', '.settings', 'node_modules']);
const NO_CHANGE = 'MC-MIGRATE-NO-CHANGE';
const REVIEW = 'MC-MIGRATE-REVIEW';
const STATE_DIR = '.mc-migrate';

export const DEFAULT_PROVIDERS = {
  openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  ollama: { base_url: 'http://localhost:11434/v1', model: 'llama3.1' },
  openrouter: { base_url: 'https://openrouter.ai/api/v1', model: '' },
  gemini: { base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-1.5-flash' },
  anthropic: { base_url: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-20241022', kind: 'anthropic' },
  mock: { kind: 'mock' },
};

let emit = () => {};

function fail(msg) {
  throw new Error(msg);
}

const readText = (p) => fs.readFileSync(p, 'utf8');
function writeText(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s, 'utf8');
}
const tokens = (n) => Math.ceil(n / 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 設定（LLM-1/LLM-2） ----------
function loadConfig(p) {
  const cfg = {
    provider: 'deepseek',
    model: '',
    api_key: '',
    max_iterations: 5,
    token_budget_chars: 16000,
    max_chunk_chars: 12000,
    max_file_chars: 5000000,
    build_cmd: '',
    providers: structuredClone(DEFAULT_PROVIDERS),
  };
  const cfgPath = p.config ? path.resolve(p.config) : path.join(RES_DIR, 'migrate.json');
  if (fs.existsSync(cfgPath)) {
    const text = readText(cfgPath)
      .replace(/^\uFEFF/, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    let data = {};
    try {
      data = JSON.parse(text);
    } catch (e) {
      fail(`設定檔 ${cfgPath} 解析失敗：${e.message}`);
    }
    Object.assign(cfg, data);
    cfg.providers = { ...DEFAULT_PROVIDERS, ...(data.providers || {}) };
  }
  if (p.provider) cfg.provider = p.provider;
  if (p.model) cfg.model = p.model;
  if (p.apiKey) cfg.api_key = p.apiKey;
  if (p.maxIterations != null) cfg.max_iterations = p.maxIterations;
  if (p.maxFileChars) cfg.max_file_chars = p.maxFileChars;
  if (p.buildCmd) cfg.build_cmd = p.buildCmd;
  if (p.noBuild) cfg.no_build = true;
  cfg.api_key = cfg.api_key || process.env.MC_MIGRATE_API_KEY || '';
  return cfg;
}

// ---------- 環境文檔（ENV-1/ENV-2/ENV-3） ----------
function parseEnvDoc(text) {
  const sections = new Map();
  let cur = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('## ')) {
      cur = line.slice(3).trim();
      sections.set(cur, []);
    } else if (cur) {
      sections.get(cur).push(line);
    }
  }
  const rows = [];
  for (const [head, body] of sections) {
    if (!/對照|映射|Mapping/.test(head)) continue;
    for (const line of body) {
      if (!line.startsWith('|')) continue;
      const cells = line.slice(1, -1).split('|').map((c) => c.trim().replace(/^`|`$/g, ''));
      if (!cells[0] || cells[0] === '舊' || cells[0].includes('---')) continue;
      rows.push({ old: cells[0], neu: cells[1] || '', note: cells[2] || '', src: head });
    }
  }
  rows.sort((a, b) => b.old.length - a.old.length);
  return { sections, rows };
}

const SECTION_KEYS = {
  '.java': ['Mapping 變更', '註冊表變更', 'API 破壞性變更', '事件系統變更'],
  '.kt': ['Mapping 變更', '註冊表變更', 'API 破壞性變更', '事件系統變更'],
  '.json': ['資料格式變更', '版本基本資訊'],
  '.gradle': ['建構環境變更'],
  '.properties': ['建構環境變更'],
  '.toml': ['建構環境變更'],
};

// LLM-4：依檔案類型只送相關章節，超出預算時由後往前裁剪（遷移對照表最後才裁）。
function relevantSections(sections, rel, budget) {
  const keys = [...(SECTION_KEYS[path.extname(rel)] || []), '已知遷移陷阱', '遷移對照'];
  const names = [...new Set(keys)].filter((k) => [...sections.keys()].some((h) => h.includes(k)));
  const pick = (list) =>
    [...sections.entries()]
      .filter(([h]) => list.some((k) => h.includes(k)))
      .map(([h, body]) => `## ${h}\n${body.join('\n')}`)
      .join('\n\n');
  let text = pick(names);
  const drop = names.filter((k) => k !== '遷移對照');
  while (text.length > budget && drop.length) {
    drop.pop();
    text = pick([...drop, '遷移對照']);
  }
  return text;
}

// ---------- Skills（SKILL-1/2/3：內建與外接同一機制） ----------
function loadSkills(dir) {
  if (!fs.existsSync(dir)) return '';
  const parts = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.md')) continue;
    const content = readText(path.join(dir, f));
    const m = content.match(/^#\s+(.+)$/m);
    parts.push(`### Skill：${m ? m[1] : f}\n\n${content}`);
  }
  return parts.join('\n\n---\n\n');
}

// ---------- LLM API 接口（LLM-1/LLM-3） ----------
function sanitize(s, key) {
  return key ? s.split(key).join('***') : s;
}

async function chat(cfg, system, user, maxTokens = 4096) {
  const prov = cfg.providers[cfg.provider] || {};
  const kind = prov.kind || 'openai';
  const base = prov.base_url || '';
  const model = cfg.model || prov.model || '';
  const key = cfg.api_key;
  if (kind === 'mock') fail('mock 供應商不經 API 呼叫（內部錯誤）');
  if (!model) fail(`供應商 ${cfg.provider} 未設定 model（migrate.json → providers.${cfg.provider}.model）`);
  const isLocal = /localhost|127\.0\.0\.1/.test(base);
  if (!isLocal && !key) {
    fail('需要 API Key：請在「模型」區塊填入 API Key，或設定環境變數 MC_MIGRATE_API_KEY。離線演示可選 mock 供應商。');
  }
  let url, headers, payload, extract;
  if (kind === 'anthropic') {
    url = base.replace(/\/$/, '') + '/messages';
    headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    payload = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
    extract = (d) => d.content[0].text;
  } else {
    url = base.replace(/\/$/, '') + '/chat/completions';
    headers = { 'content-type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    payload = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.2 };
    extract = (d) => d.choices[0].message.content;
  }
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(120000) });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        await sleep(2 ** attempt * 1000);
        continue;
      }
      if (!res.ok) {
        const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        lastErr = `HTTP ${res.status}: ${plain.slice(0, 300)}`;
        break;
      }
      return extract(JSON.parse(text));
    } catch (e) {
      lastErr = String((e && e.message) || e);
      if (attempt < 3) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
    }
  }
  fail(`LLM API 呼叫失敗（已重試）：${sanitize(lastErr, key)}`);
}

function parseEditResponse(resp) {
  let t = resp.trim();
  if (t.includes(NO_CHANGE) && t.length < 60) return null;
  t = t.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
  return t;
}

function buildSystem(skillsText, sel, fromVer, target, loaderTo) {
  return [
    `你是 Minecraft 模組版本遷移工程師，負責將模組從 Minecraft ${fromVer} 遷移到 ${target}。`,
    '=== Skills（行為規則）===',
    skillsText || '（無）',
    loaderTo
      ? `注意：本次是「跨載入器遷移」至 ${loaderTo}：註冊系統、事件、入口點、建構腳本等須改寫為目標載入器寫法；不確定處以「${REVIEW}: 原因」標註，不得靜默猜測。`
      : null,
    `=== ${target} 版本環境文檔 ===`,
    sel,
    '輸出要求：',
    '1. 僅輸出遷移後的「完整檔案內容」（可用 fenced code block 包住），不要輸出任何解釋。',
    `2. 若此檔案無需變更，僅輸出 ${NO_CHANGE}。`,
    `3. 不確定的變更，在變更處以註解標記「${REVIEW}: 原因」。`,
  ]
    .filter((l) => l !== null)
    .join('\n\n');
}

async function planLlm(cfg, skillsText, sections, files, loaderTo) {
  const summary = [...sections.entries()]
    .map(([h, body]) => `## ${h}\n${body.slice(0, 40).join('\n')}`)
    .join('\n\n');
  const system = `你是 Minecraft 模組版本遷移規劃師。${skillsText}\n\n${loaderTo ? `本次為跨載入器遷移（→ ${loaderTo}），請連同建構腳本與入口點檔案一併納入修改清單。` : ''}任務：審視以下專案檔案清單與環境文檔摘要，判斷哪些檔案需要修改。只輸出 JSON：{"files": ["相對路徑", ...], "risks": "風險說明"}。`;
  const user = `專案檔案清單：\n${files.join('\n')}\n\n環境文檔摘要：\n${summary}`;
  const resp = await chat(cfg, system, user);
  try {
    const m = resp.match(/\{[\s\S]*\}/);
    const data = JSON.parse(m[0]);
    return { files: (data.files || files).filter((f) => files.includes(f)), risks: data.risks || '' };
  } catch {
    return { files, risks: '' };
  }
}

// 大檔分段（ponytail: 單一請求大小上限，避免 413；按行分段，超長單行才硬切字元）
export function splitChunks(content, max) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const line of content.split('\n')) {
    if (line.length > max) {
      if (cur.length) {
        chunks.push(cur.join('\n'));
        cur = [];
        len = 0;
      }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    if (len > 0 && len + line.length + 1 > max) {
      chunks.push(cur.join('\n'));
      cur = [];
      len = 0;
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

async function editOne(cfg, system, rel, content, errorLog, stats, isChunk) {
  stats.inChars += system.length + content.length + rel.length;
  const user =
    `檔案：${rel}\n\n\`\`\`\n${content}\n\`\`\`` +
    (errorLog ? `\n\n建構/驗證錯誤（請修正）：\n${errorLog.slice(-4000)}` : '');
  const resp = await chat(cfg, system, user);
  stats.outChars += resp.length;
  const neu = parseEditResponse(resp);
  if (neu !== null && !isChunk && /\.json$/.test(rel)) {
    try {
      JSON.parse(neu);
    } catch {
      emit('warn', `模型為 ${rel} 產生的 JSON 無效，該檔保持原樣（需人工處理）。`);
      return null;
    }
  }
  return neu;
}

async function editLlm(cfg, skillsText, sections, rel, content, errorLog, fromVer, target, stats, abort, loaderTo) {
  const sel = relevantSections(sections, rel, cfg.token_budget_chars);
  const system = buildSystem(skillsText, sel, fromVer, target, loaderTo);
  if (content.length <= cfg.max_chunk_chars) {
    return await editOne(cfg, system, rel, content, errorLog, stats, false);
  }
  const chunks = splitChunks(content, cfg.max_chunk_chars);
  emit('warn', `${rel} 較大（${content.length} 字元），將分 ${chunks.length} 段遷移，需較多時間與 token…`);
  const outs = [];
  for (let i = 0; i < chunks.length; i++) {
    if (abort && abort.aborted) throw new Error('已取消遷移');
    emit('log', `  遷移段 ${i + 1}/${chunks.length}…`);
    const sys = `${system}\n\n注意：這是一個大檔的第 ${i + 1}/${chunks.length} 段，只輸出這一段的完整遷移後內容。`;
    const neu = await editOne(cfg, sys, `${rel}（段 ${i + 1}/${chunks.length}）`, chunks[i], errorLog, stats, true);
    outs.push(neu === null ? chunks[i] : neu);
  }
  return outs.join('\n');
}

// ---------- mock 遷移（離線演示：套用遷移對照表） ----------
function mockEdit(rows, rel, content) {
  let neu = content;
  const applied = [];
  for (const r of rows) {
    if (!neu.includes(r.old)) continue;
    let count = 0;
    let start = 0;
    let idx;
    while ((idx = neu.indexOf(r.old, start)) !== -1) {
      count++;
      const after = neu.slice(idx + r.old.length);
      if (r.neu.endsWith('(') && after.startsWith(' ')) {
        // 舊寫法 `X(Registries.ITEM, value)` → 新寫法 `X(value)`：吞掉逗號後的空白
        neu = neu.slice(0, idx) + r.neu + neu.slice(idx + r.old.length + 1);
      } else {
        neu = neu.slice(0, idx) + r.neu + neu.slice(idx + r.old.length);
      }
      start = idx + r.neu.length;
    }
    applied.push({ ...r, count });
  }
  const flagged = applied.filter((a) => a.note.includes('需人工確認'));
  if (flagged.length && /\.(java|kt)$/.test(rel)) {
    const marked = new Set();
    const out = [];
    for (const line of neu.split('\n')) {
      for (const a of flagged) {
        if (!marked.has(a.old) && line.includes(a.neu)) {
          marked.add(a.old);
          out.push(`// ${REVIEW}: ${a.note}`);
          break;
        }
      }
      out.push(line);
    }
    neu = out.join('\n');
  }
  return { neu, applied };
}

// ---------- 專案掃描與 git 安全（AGENT-6） ----------
function scanProject(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(p);
      } else if (FILE_EXTS.has(path.extname(e.name))) {
        out.push(path.relative(root, p).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return out;
}

function gitCheck(project, target, force) {
  if (!fs.existsSync(path.join(project, '.git'))) return null;
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).stdout.trim();
  if (dirty && !force) fail('git 工作目錄不乾淨：請先提交變更，或勾選「強制繼續」直接修改工作區檔案。');
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd: project, encoding: 'utf8' }).stdout.trim();
  const newBranch = `mc-migrate/${target}`;
  if (branch === newBranch) return newBranch;
  const r = spawnSync('git', ['checkout', '-b', newBranch], { cwd: project, encoding: 'utf8' });
  if (r.status !== 0) fail(`建立分支 ${newBranch} 失敗：${r.stderr}`);
  return newBranch;
}

// ---------- 狀態 / 備份（AGENT-5） ----------
function statePath(project) {
  return path.join(project, STATE_DIR, 'state.json');
}

function loadState(project, fromVer, target) {
  const p = statePath(project);
  if (!fs.existsSync(p)) return { files: {} };
  try {
    const s = JSON.parse(readText(p));
    if (s.from !== fromVer || s.target !== target) {
      emit('warn', `既有狀態為 ${s.from}→${s.target}，與本次 ${fromVer}→${target} 不符，忽略重新開始。`);
      return { files: {} };
    }
    return s;
  } catch {
    emit('warn', 'state.json 損毀，忽略狀態重新開始。');
    return { files: {} };
  }
}

function writeState(project, state, fromVer, target) {
  writeText(statePath(project), JSON.stringify({ from: fromVer, target, files: state.files }, null, 2));
}

function backupFile(project, rel, content) {
  const p = path.join(project, STATE_DIR, 'backup', rel);
  if (!fs.existsSync(p)) writeText(p, content);
}

// ---------- 建構驗證（AGENT-3） ----------
function runBuild(project, cfg) {
  if (cfg.no_build) return ['skip', '已勾選跳過建構驗證'];
  let cmd = cfg.build_cmd || '';
  if (!cmd) {
    for (const name of ['gradlew.bat', 'gradlew']) {
      if (fs.existsSync(path.join(project, name))) {
        cmd = process.platform === 'win32' ? 'gradlew.bat build' : './gradlew build';
        break;
      }
    }
    if (!cmd) return ['skip', '專案無 gradlew 且未設定建構指令，跳過編譯驗證'];
  }
  const r = spawnSync(cmd, { cwd: project, shell: true, encoding: 'utf8', timeout: 600000 });
  const log = ((r.stdout || '') + (r.stderr || '')).slice(-4000);
  if (r.error) return ['fail', String(r.error)];
  return [r.status === 0 ? 'ok' : 'fail', log];
}

// ---------- 報告與 patch（AGENT-2） ----------
function collectReview(project, changedRels, changes) {
  const items = new Set();
  for (const rel of changedRels) {
    if (changes[rel]) {
      for (const a of changes[rel]) {
        if (a.note.includes('需人工確認')) items.add(`${rel}：\`${a.old}\` → \`${a.neu}\`（${a.note}）`);
      }
    }
    for (const line of readText(path.join(project, rel)).split('\n')) {
      if (line.includes(REVIEW)) items.add(`${rel}：${line.trim()}`);
    }
  }
  return [...items];
}

function diffStat(project, rel) {
  const r = spawnSync(
    'git',
    ['diff', '--no-index', '--numstat', '--', `${STATE_DIR}/backup/${rel}`, rel],
    { cwd: project, encoding: 'utf8' }
  );
  const parts = r.stdout.trim().split(/\s+/);
  return { add: parseInt(parts[0], 10) || 0, del: parseInt(parts[1], 10) || 0 };
}

function writePatch(project, rels) {
  let patch = '';
  for (const rel of rels) {
    const r = spawnSync(
      'git',
      ['diff', '--no-index', '--src-prefix=a/', '--dst-prefix=b/', '--', `${STATE_DIR}/backup/${rel}`, rel],
      { cwd: project, encoding: 'utf8' }
    );
    patch += (r.stdout || '') + '\n';
  }
  writeText(path.join(project, STATE_DIR, 'migration.patch'), patch);
}

function writeReport(project, x) {
  const lines = [];
  lines.push(`# 遷移報告：${path.basename(project)}`, '');
  lines.push(`- 遷移路徑：${x.fromVer} → ${x.target}`);
  lines.push(`- 目標載入器：${x.loaderTo || '不變'}`);
  lines.push(`- 時間：${new Date().toISOString()}`);
  lines.push(`- 供應商/模型：${x.cfg.provider} / ${x.cfg.model || '（供應商預設）'}`);
  lines.push(`- 環境文檔：${path.basename(x.envPath)}`);
  lines.push(`- 掃描 ${x.files.length}｜計畫 ${x.planned.length}｜實際變更 ${Object.keys(x.changes).length}｜跳過（已完成）${x.skipped}`);
  lines.push(`- 迭代修正：${x.iterations} 次${x.buildFailed ? `（已達上限 ${x.cfg.max_iterations}，仍有未解決問題）` : ''}`);
  lines.push(`- 建構驗證：${x.buildStatus === 'ok' ? '通過' : x.buildStatus === 'skip' ? '跳過' : '失敗'}`);
  lines.push(`- Token 估算：約 ${tokens(x.stats.inChars)} 輸入 + ${tokens(x.stats.outChars)} 輸出`, '');
  lines.push('## 修改檔案清單與統計', '');
  lines.push('| 檔案 | 新增行 | 刪除行 |', '| --- | --- | --- |');
  for (const rel of Object.keys(x.changes)) {
    const s = diffStat(project, rel);
    lines.push(`| ${rel} | ${s.add} | ${s.del} |`);
  }
  lines.push('', '## 變更說明', '');
  for (const rel of Object.keys(x.changes)) {
    lines.push(`### ${rel}`);
    if (x.changes[rel] && x.changes[rel].length) {
      for (const a of x.changes[rel]) lines.push(`- \`${a.old}\` → \`${a.neu}\` ×${a.count}（${a.note || '環境文檔對照'}）`);
    } else {
      lines.push('- 由 LLM 修改，詳見 patch。');
    }
    lines.push('');
  }
  lines.push('## 需人工確認', '');
  if (x.review.length) lines.push(...x.review.map((r) => `- ${r}`));
  else lines.push('- 無');
  lines.push('', '## 未解決問題', '');
  if (x.buildFailed) {
    lines.push(`- 建構驗證未通過（迭代上限 ${x.cfg.max_iterations} 次）：`, '```', (x.buildLog || '').slice(-2000), '```');
  } else if (x.buildStatus === 'skip') {
    lines.push(`- 編譯驗證跳過：${x.buildLog}`);
  } else {
    lines.push('- 無');
  }
  lines.push('', '## 產出檔案');
  lines.push(`- 補丁：\`${STATE_DIR}/migration.patch\``);
  lines.push(`- 備份：\`${STATE_DIR}/backup/\``);
  lines.push(`- 狀態：\`${STATE_DIR}/state.json\`（支援中斷續跑）`);
  writeText(path.join(project, STATE_DIR, 'MIGRATION_REPORT.md'), lines.join('\n'));
}

// ---------- 主流程（AGENT-1） ----------
// p: { project?, files?, fromVer, target, env, provider, model, apiKey, maxIterations, dryRun, buildCmd, noBuild, force, config, skillsDir, abort? }
// p.files：直接指定要遷移的檔案（絕對路徑陣列），不需完整專案；與 p.project 二選一。
// p.abort：AbortSignal（GUI 取消用），中斷時拋出「已取消遷移」。

const BINARY_EXTS = new Set([
  '.class', '.zip', '.7z', '.rar', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.ogg', '.mp3', '.wav', '.exe', '.dll', '.bin', '.dat', '.db', '.ico', '.ttf',
]);

function commonRoot(filePaths) {
  let parts = path.dirname(filePaths[0]).split(path.sep);
  for (const f of filePaths.slice(1)) {
    const p = path.dirname(f).split(path.sep);
    const n = Math.min(parts.length, p.length);
    let i = 0;
    while (i < n && parts[i] === p[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join(path.sep) || path.dirname(filePaths[0]);
}

// jar 容器模式：解壓 → 遷移文字內容（原始碼/資源 JSON）→ 重新打包。
// .class 位元碼無法遷移，報告會明確提醒需重新編譯。
async function migrateJar(p, onEmit) {
  emit = typeof onEmit === 'function' ? onEmit : () => {};
  const jar = path.resolve(p.files[0]);
  const extractDir = `${jar}.src`;
  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  emit('log', `jar 模式：解壓 ${path.basename(jar)} → ${extractDir}`);
  const ex = spawnSync('tar', ['-xf', jar, '-C', extractDir], { encoding: 'utf8' });
  if (ex.status !== 0) {
    fail(`解壓失敗：${(ex.stderr || '').trim().slice(0, 300) || '找不到 tar（Windows 10 以上內建）'}`);
  }
  const files = scanProject(extractDir);
  if (!files.length) fail('jar 內沒有可遷移的文字內容（僅 .class 位元碼無法遷移，請改用原始碼）');
  const inner = {
    ...p,
    project: extractDir,
    files: files.map((f) => path.join(extractDir, f)),
    force: true,
    noBuild: true,
  };
  const summary = await runMigration(inner, onEmit);
  const outJar = jar.replace(/\.(jar|zip)$/i, `-${p.target}.jar`);
  if (p.dryRun) {
    emit('log', `dry-run：完成後會重新打包為 ${path.basename(outJar)}`);
    fs.rmSync(extractDir, { recursive: true, force: true });
    emit('done', summary);
    return summary;
  }
  emit('log', `打包新 jar：${outJar}`);
  const pk = spawnSync('tar', ['--format', 'zip', '-cf', outJar, '-C', extractDir, '.'], { encoding: 'utf8' });
  if (pk.status !== 0) fail(`打包失敗：${(pk.stderr || '').trim().slice(0, 300)}`);
  emit('warn', 'jar 內的 .class 位元碼無法直接遷移；本次只遷移原始碼與資源文字檔，需以原始碼重新編譯後 .class 才會反映變更。');
  emit('log', `新 jar：${outJar}（解壓目錄保留於 ${extractDir} 供檢視）`);
  emit('done', summary);
  return summary;
}

// 讀檔案開頭（跨載入器偵測用，避免整檔讀取）
function readHead(f, n = 8192) {
  try {
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, read);
  } catch {
    return '';
  }
}

function detectLoader(texts) {
  const t = texts.join('\n');
  if (/net\.neoforged|neoforged\.gradle|neoforge/.test(t)) return 'neoforge';
  if (/net\.fabricmc|fabric-loom|fabric\.api/.test(t)) return 'fabric';
  if (/net\.minecraftforge|forgegradle|minecraftforge/.test(t)) return 'forge';
  return '';
}

export async function runMigration(p, onEmit) {
  emit = typeof onEmit === 'function' ? onEmit : () => {};
  const cfg = loadConfig(p);
  const fromVer = p.fromVer;
  const target = p.target;
  const loaderTo = p.loaderTo || '';
  if (loaderTo && cfg.provider === 'mock') {
    fail('跨載入器遷移需使用真實模型（mock 僅支援同載入器的版本升級）');
  }

  // jar 容器模式
  const jarInputs = (p.files || []).filter((f) => /\.(jar|zip)$/i.test(f));
  if (jarInputs.length) {
    if (jarInputs.length !== (p.files || []).length) fail('jar 檔請單獨遷移（一次一個）');
    return migrateJar(p, onEmit);
  }

  // 專案來源：明確指定檔案，或整個專案資料夾
  const explicitFiles = Array.isArray(p.files) && p.files.length > 0;
  const fileContents = new Map();
  if (explicitFiles) {
    for (const f of p.files) {
      if (!fs.existsSync(f)) fail(`檔案不存在：${f}`);
      const ext = path.extname(f).toLowerCase();
      if (BINARY_EXTS.has(ext)) {
        fail(`${path.basename(f)} 是二進位/壓縮檔（${ext}），本工具只處理原始碼文字檔（.java / .kt / .json / .gradle 等）`);
      }
      const content = readText(f);
      if (content.length > cfg.max_file_chars) {
        fail(`${path.basename(f)} 過大（${content.length} 字元，上限 ${cfg.max_file_chars}），不適合送給 LLM；請確認選到的是原始碼而非二進位檔`);
      }
      if (content.includes('\0')) fail(`${path.basename(f)} 疑似二進位檔，請選擇文字原始碼檔案`);
      fileContents.set(path.resolve(f), content);
    }
  }
  const checkAbort = () => {
    if (p.abort && p.abort.aborted) throw new Error('已取消遷移');
  };
  const project = path.resolve(explicitFiles ? commonRoot(p.files.map((f) => path.resolve(f))) : p.project || '');
  if (!explicitFiles && (!fs.existsSync(project) || !fs.statSync(project).isDirectory())) fail(`專案目錄不存在：${project}`);

  // 2. 分析來源（提前計算，供載入器偵測與文檔解析）
  const files = explicitFiles
    ? p.files.map((f) => path.relative(project, path.resolve(f)).split(path.sep).join('/'))
    : scanProject(project);

  // 跨載入器：偵測來源載入器 → 解析對應路徑文檔
  // 偵測範圍＝整個專案（含建構檔與其他原始碼），不限於使用者選的檔案
  const fromLoader = p.loaderFrom
    ? p.loaderFrom
    : loaderTo
      ? detectLoader(files.map((f) => readHead(path.join(project, f))))
      : '';
  if (loaderTo && !fromLoader) {
    fail('無法偵測來源載入器：所選檔案與其所在資料夾沒有可辨識的 import／建構檔（net.minecraftforge / net.fabricmc / net.neoforged）。請在「來源載入器」手動指定，或選取整個模組專案的檔案，或用 --env 指定環境文檔');
  }
  const envPath = p.env
    ? path.resolve(p.env)
    : path.join(RES_DIR, 'mcenv', loaderTo ? `${fromLoader}_${fromVer}_to_${loaderTo}_${target}.md` : `${fromVer}_to_${target}.md`);
  if (!fs.existsSync(envPath)) {
    const dir = path.join(RES_DIR, 'mcenv');
    const existing = fs.existsSync(dir) ? fs.readdirSync(dir).join('、') : '無';
    fail(`找不到環境文檔 ${envPath}（mcenv/ 現有：${existing}）`);
  }
  const { sections, rows } = parseEnvDoc(readText(envPath));
  const envText = readText(envPath);
  const skillsDir = p.skillsDir ? path.resolve(p.skillsDir) : path.join(RES_DIR, 'skills');
  const skillsText = loadSkills(skillsDir);
  const mock = cfg.provider === 'mock';

  // 1. 載入環境
  emit('log', `載入環境文檔：${path.basename(envPath)}｜Skills ${skillsText ? skillsText.split('### Skill').length - 1 : 0} 個｜供應商：${cfg.provider}${loaderTo ? `｜目標載入器：${loaderTo}（來源：${fromLoader}）` : ''}`);
  emit('step', { step: 1, status: 'active' });
  // AGENT-6：git 安全
  const branch = gitCheck(project, target, p.force);
  if (branch) emit('log', `git：於分支 ${branch} 執行`);

  emit('log', explicitFiles ? `指定檔案：${files.length} 個` : `掃描專案：${files.length} 個候選檔案`);
  emit('step', { step: 1, status: 'done' });
  emit('step', { step: 2, status: 'active' });

  // 3. 規劃遷移
  let planned;
  let risks = '';
  if (explicitFiles) {
    planned = files;
  } else if (mock) {
    planned = files.filter((f) => rows.some((r) => readText(path.join(project, f)).includes(r.old)));
  } else {
    const pl = await planLlm(cfg, skillsText, sections, files, p.loaderTo);
    planned = pl.files;
    risks = pl.risks;
    if (!planned.length) planned = files;
  }
  emit('log', `遷移計畫：${planned.length} 個檔案待處理`);
  emit('step', { step: 2, status: 'done' });

  if (p.dryRun) {
    if (mock) {
      let total = 0;
      const lines = [];
      let inChars = envText.length;
      for (const f of planned) {
        const content = readText(path.join(project, f));
        inChars += content.length;
        const { applied } = mockEdit(rows, f, content);
        const n = applied.reduce((s, a) => s + a.count, 0);
        total += n;
        if (n) lines.push(`  ${f}（${n} 處變更）`);
      }
      emit('log', '預估變更（dry-run，未寫入任何檔案）：');
      emit('log', lines.join('\n') || '  （無）');
      emit('log', `合計 ${total} 處變更｜token 輸入約 ${tokens(inChars)}`);
    } else {
      emit('log', 'dry-run 遷移計畫（未寫入任何檔案）：');
      emit('log', planned.map((f) => `  ${f}`).join('\n') || '  （無）');
      if (risks) emit('log', `預估風險：${risks}`);
    }
    return {
      dryRun: true,
      project,
      fromVer,
      target,
      provider: cfg.provider,
      changed: 0,
      skipped: 0,
      iterations: 0,
      buildStatus: 'skip',
      buildFailed: false,
      reviewCount: 0,
    };
  }

  writeText(
    path.join(project, STATE_DIR, 'plan.md'),
    [
      `# 遷移計畫：${fromVer} → ${target}`,
      '',
      ...planned.map((f) => `- ${f}`),
      ...(risks ? ['', `## 風險\n\n${risks}`] : []),
      '',
    ].join('\n')
  );

  // 4. 執行遷移（AGENT-5：逐步寫狀態，支援中斷續跑）
  const state = loadState(project, fromVer, target);
  const toDo = planned.filter((f) => !(state.files[f] && state.files[f].status === 'done'));
  const skipped = planned.length - toDo.length;
  if (skipped) emit('log', `續跑：${skipped} 個檔案已完成，跳過`);
  const changes = {};
  const stats = { inChars: envText.length + skillsText.length, outChars: 0 };
  emit('step', { step: 3, status: 'active' });
  for (const rel of toDo) {
    checkAbort();
    const content = explicitFiles
      ? fileContents.get(path.resolve(project, rel))
      : readText(path.join(project, rel));
    let neu = null;
    let applied = null;
    if (mock) {
      stats.inChars += content.length;
      ({ neu, applied } = mockEdit(rows, rel, content));
    } else {
      neu = await editLlm(cfg, skillsText, sections, rel, content, null, fromVer, target, stats, p.abort, p.loaderTo);
    }
    if (neu === null || neu === content) continue;
    if (mock) stats.outChars += neu.length;
    backupFile(project, rel, content);
    writeText(path.join(project, rel), neu);
    changes[rel] = applied;
    state.files[rel] = { status: 'done' };
    writeState(project, state, fromVer, target);
    emit('log', `  已遷移：${rel}`);
  }

  emit('step', { step: 3, status: 'done' });

  // 5. 建構驗證 + 迭代修正（AGENT-3）
  emit('step', { step: 4, status: 'active' });
  let iterations = 0;
  let [buildStatus, buildLog] = runBuild(project, cfg);
  while (buildStatus === 'fail' && iterations < cfg.max_iterations) {
    checkAbort();
    iterations++;
    emit('log', `建構/驗證失敗，第 ${iterations}/${cfg.max_iterations} 次修正…`);
    for (const rel of Object.keys(changes)) {
      const content = readText(path.join(project, rel));
      let neu = null;
      if (mock) neu = mockEdit(rows, rel, content).neu;
      else neu = await editLlm(cfg, skillsText, sections, rel, content, buildLog, fromVer, target, stats, p.abort, p.loaderTo);
      if (neu !== null && neu !== content) writeText(path.join(project, rel), neu);
    }
    [buildStatus, buildLog] = runBuild(project, cfg);
  }
  const buildFailed = buildStatus === 'fail';
  emit('step', { step: 4, status: buildFailed ? 'failed' : 'done' });

  // 6. 產出報告
  emit('step', { step: 5, status: 'active' });
  const review = collectReview(project, Object.keys(changes), changes);
  writeReport(project, { fromVer, target, loaderTo: p.loaderTo || '', cfg, envPath, files, planned, skipped, changes, iterations, buildFailed, buildStatus, buildLog, review, stats });
  writePatch(project, Object.keys(changes));
  writeState(project, state, fromVer, target);

  const summary = {
    dryRun: false,
    project,
    fromVer,
    target,
    provider: cfg.provider,
    changed: Object.keys(changes).length,
    skipped,
    iterations,
    buildStatus,
    buildFailed,
    reviewCount: review.length,
    reportPath: path.join(project, STATE_DIR, 'MIGRATION_REPORT.md'),
    patchPath: path.join(project, STATE_DIR, 'migration.patch'),
    planPath: path.join(project, STATE_DIR, 'plan.md'),
  };
  emit('log', `完成：變更 ${summary.changed} 個檔案｜跳過 ${skipped}（已完成）｜迭代 ${iterations} 次｜建構驗證：${buildStatus === 'ok' ? '通過' : buildStatus === 'skip' ? '跳過' : '失敗'}`);
  emit('log', `報告：${summary.reportPath}`);
  emit('log', `補丁：${summary.patchPath}`);
  if (review.length) emit('log', `需人工確認 ${review.length} 項（見報告「需人工確認」）`);
  if (buildFailed) emit('warn', '建構驗證未通過，詳見報告「未解決問題」。');
  emit('step', { step: 5, status: 'done' });
  emit('done', summary);
  return summary;
}
