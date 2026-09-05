// 官方環境文檔產生器：以 Mojang 官方資料自動生成任意版本對的文檔
// 只納入官方保證真實的資料：
//   - 版本清單/類型/發布日/官方 changelog：https://piston-meta.mojang.com/mc/game/version_manifest_v2.json
//   - mapping 提供狀況（自 26.x 起 Mojang 停止發布）
// 誠實原則：官方無法機器取得的（跨版本重命名、註冊表、事件、資料格式），一律標註官方連結、
// 由人工補強，不編造任何變更內容。
// 用法：node gen-env.mjs <fromVer> <toVer> [--dir mcenv]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

async function getJson(url) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(90000),
    headers: { 'user-agent': 'MC-Migrate' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}：${url}`);
  return r.json();
}

function changelogUrl(ver) {
  return `https://www.minecraft.net/en-us/article/minecraft-java-edition-${ver.replace(/\./g, '-')}`;
}

// 供核心自動生成使用：dir 需可寫（打包版會傳使用者資料夾）
export async function generatePairDoc(fromVer, toVer, dir = 'mcenv') {
  const from = await fetchVersion(fromVer);
  const to = await fetchVersion(toVer);
  const lines = [
    `# Minecraft ${fromVer} → ${toVer} 版本環境文檔`,
    '',
    `> **資料來源**：Mojang 官方版本 manifest（${MANIFEST_URL}）、官方 changelog。本檔由 gen-env.mjs 自動生成，僅含官方可機器取得的資訊。`,
    `> **生成時間**：${new Date().toISOString()}`,
    '',
    '## 版本基本資訊',
    '',
    '| 項目 | 來源版本 | 目標版本 |',
    '| --- | --- | --- |',
    `| 版本號 | ${fromVer} | ${toVer} |`,
    `| 類型 | ${from.type} | ${to.type} |`,
    `| 發布日期 | ${from.releaseTime} | ${to.releaseTime} |`,
    `| 官方 changelog | [${fromVer}](${changelogUrl(fromVer)}) | [${toVer}](${changelogUrl(toVer)}) |`,
    `| 官方 mapping | ${from.mappings ? '有提供' : '無（Mojang 已停止發布）'} | ${to.mappings ? '有提供' : '無（Mojang 已停止發布）'} |`,
    '',
    '## Mapping 變更',
    '',
    '- 官方不提供跨版本的重命名對照（各版本 obf 名稱重新洗牌，無法定向比對）；請依官方 changelog、Minecraft Wiki 或社群 mapping 工具人工補強本節。',
    '',
    '## 註冊表變更',
    '',
    `- 官方無機器可讀的註冊表清單；請依 [官方 changelog](${changelogUrl(toVer)}) 與 [Minecraft Wiki](https://minecraft.wiki/) 補強本節。`,
    '',
    '## API 破壞性變更',
    '',
    `- 請依 [官方 changelog](${changelogUrl(toVer)}) 人工補強（行為/簽名變更）。`,
    '',
    '## 事件系統變更',
    '',
    '- 官方無事件系統文件；載入器事件請依 [FabricMC 文件](https://docs.fabricmc.net/) / [NeoForge 文件](https://docs.neoforged.net/) 補強。',
    '',
    '## 資料格式變更',
    '',
    `- 資料包/配方/進度格式請依 [官方 changelog](${changelogUrl(toVer)}) 與 [Minecraft Wiki 資料包頁](https://minecraft.wiki/w/Data_pack) 補強。`,
    '',
    '## 建構環境變更',
    '',
    '- Gradle/mappings/Java 版本要求依目標 Loader 文件：[FabricMC](https://docs.fabricmc.net/) / [NeoForge](https://docs.neoforged.net/)。',
    '',
    '## 已知遷移陷阱',
    '',
    `- 請依 [官方 changelog](${changelogUrl(toVer)}) 與社群回報人工補強。`,
    '',
    '## 遷移對照（官方）',
    '',
    '- 官方無重命名對照資料；請人工補強。mock 模式（文字對照）依賴本節，無資料時僅真實模型可用。',
    '',
  ];
  fs.mkdirSync(dir, { recursive: true });
  const docPath = path.join(dir, `${fromVer}_to_${toVer}.md`);
  fs.writeFileSync(docPath, lines.join('\n'));
  return { docPath };
}

async function fetchVersion(versionId) {
  const manifest = await getJson(MANIFEST_URL);
  const v = manifest.versions.find((x) => x.id === versionId);
  if (!v) throw new Error(`Mojang manifest 中找不到版本 ${versionId}`);
  const vj = await getJson(v.url);
  const mappings = vj.downloads && vj.downloads.client_mappings && vj.downloads.client_mappings.url ? true : false;
  return { type: v.type, releaseTime: v.releaseTime, mappings };
}

export async function listVersions() {
  const manifest = await getJson(MANIFEST_URL);
  return manifest.versions.map((v) => ({ id: v.id, type: v.type }));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--dir'));
  const dirIdx = process.argv.indexOf('--dir');
  const dir = dirIdx > -1 ? process.argv[dirIdx + 1] : path.join(os.homedir(), '.mc-migrate', 'mcenv');
  const [from, to] = args;
  if (!from || !to) {
    console.log('用法：node gen-env.mjs <fromVer> <toVer> [--dir <輸出目錄>]');
    process.exit(1);
  }
  generatePairDoc(from, to, dir)
    .then((r) => {
      console.log(`已生成官方文檔：${r.docPath}`);
    })
    .catch((e) => {
      console.error(`生成失敗：${(e && e.message) || e}`);
      process.exit(1);
    });
}
