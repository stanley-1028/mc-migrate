# Minecraft 模組版本升級 AI 工具

依需求文檔實作的模組版本遷移工具（Node.js、零依賴），四大部件對應：

| 部件 | 位置 |
| --- | --- |
| MC 版本環境文檔 | `mcenv/*.md`（每版本一份，資料驅動，新增版本不改主程式） |
| Agent 升級工具 | `migrate.mjs`（規劃 → 遷移 → 建構驗證迭代 → 報告與 diff） |
| LLM API 接口 | 同一抽象支援 OpenAI/DeepSeek/Ollama/Gemini/OpenRouter/Anthropic，Key 由使用者自備 |
| Skills 體系 | `skills/*.md`（內建規則與外接 Skill 同一機制，放入即生效） |

## 快速開始

離線演示（不需 API Key，mock 模式套用環境文檔對照表）：

```powershell
node migrate.mjs samples/example-mod --provider mock
```

也可以跳過完整專案，直接遷移指定 Java 文件：

```powershell
node migrate.mjs --files 你的檔案/ItemClass.java 你的檔案/BlockClass.java --provider mock
```

使用真實模型（自備 Key，只存在本機環境變數）：

```powershell
$env:MC_MIGRATE_API_KEY = "sk-..."
node migrate.mjs <模組專案路徑> --provider deepseek
```

## 設定

複製 `migrate.example.json` 為 `migrate.json`（已被 `.gitignore` 排除，可放 Key）。支援 `//` 註解。模型名稱未指定時用供應商預設。

## 流程與產出

1. 載入環境文檔 + Skills → 掃描專案 → 規劃遷移（`--dry-run` 只出計畫不寫檔）。
2. 逐檔遷移，原檔先備份至 `.mc-migrate/backup/`，狀態逐步寫入 `state.json`（中斷可續跑，已完成檔案不重複處理）。
3. 專案有 `gradlew` 或設定 `--build-cmd` 時執行建構驗證；失敗會把錯誤回饋模型修正，達 `--max-iterations`（預設 5）上限後停止並在報告標示未解決。
4. 產出 `.mc-migrate/MIGRATION_REPORT.md`（含需人工確認清單）與 `migration.patch`（git 格式 diff）。

git 專案會自動在分支 `mc-migrate/<目標版本>` 執行；工作目錄不乾淨時中止（`--force` 可覆寫）。

## 擴充

- 新 MC 版本：按 `mcenv/TEMPLATE.md` 新增 `<來源>_to_<目標>.md`。「遷移對照」表格第三欄標註「需人工確認」的列，遷移後會以 `MC-MIGRATE-REVIEW` 註解標記並列入報告。
- 新規則：在 `skills/` 放入 Markdown Skill（名稱/用途/適用時機/內容/使用限制）即被 Agent 採用。

## 桌面版（Windows exe）

- 已打包：`app/dist/MC-Migrate.exe`（單檔 portable，約 65 MB，綠色現代簡約介面）。
- 重新打包：`cd app; npm install; npm run dist`。
- 介面與 CLI 共用同一核心（`lib/core.mjs`）；設定與 API Key 存在本機使用者資料夾，不隨專案提交。
- 冒煙測試（打包後 exe 實跑一次遷移）：`node app/smoke-test.mjs`。
- 注意：exe 未做程式碼簽章，首次執行 Windows SmartScreen 可能提示「更多資訊 → 仍要執行」。

## 測試

```powershell
node tests/test_migrate.mjs
```

## 限制（誠實聲明）

- mock 供應商＝環境文檔對照表的文字替換，用於離線演示與流程驗證；真實遷移品質取決於模型與環境文檔品質。
- 範本文檔中的「26.2」及其變更為虛構示例；實際使用請依官方 changelog 撰寫環境文檔。
- 建構驗證為可選步驟：需專案有 `gradlew` 或提供 `--build-cmd`；無則跳過並在報告註明。
- 大型專案逐檔呼叫 LLM，成本依檔案數線性成長；token 估算見報告。
- 中文輸出請在 UTF-8 終端（如 Windows Terminal）執行。
