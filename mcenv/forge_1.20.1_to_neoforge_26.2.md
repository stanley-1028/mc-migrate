# Forge 1.20.1 → NeoForge 26.2 跨載入器遷移文檔

> **狀態**：範本文檔（示範用途）。「26.2」為虛構版本號，內容取材自官方 NeoForge 遷移指南的常見路徑，實際使用請以官方文件為準。
> **資料來源**：NeoForge 官方遷移指南、NeoForged 文檔（示範欄位）。
> **最後更新**：2026-08-15

## 版本基本資訊

| 項目 | 值 |
| --- | --- |
| 版本號 | 26.2 |
| 類型 | 正式版 |
| 發布日期 | 2026-06-01（示範） |
| 目標 Mod Loader | NeoForge（neoforge ≥ 26.0） |
| Java 要求 | Java 21 |
| 推薦工具鏈 | Gradle 8.x、net.neoforged.gradle.userdev 插件 |

## Mapping 變更

- NeoForge 與 Forge 一樣基於官方 mapping（mojmap），多數 vanilla 類別名稱一致；本路徑主要差異在載入器 API 套件，而非 vanilla mapping。

## 註冊表變更

- `DeferredRegister` / `RegistryObject` 保留（套件遷至 `net.neoforged.neoforge.registries`）。
- `IEventBus` 概念保留，來源改由 `ModLoadingContext.get().getModEventBus()` 取得。

## API 破壞性變更

- 套件重命名：`net.minecraftforge.fml.*` → `net.neoforged.fml.*`（多數類別，逐檔修正 import）。
- `FMLJavaModLoadingContext.get()` → `ModLoadingContext.get()`（NeoForge 改為靜態方法）。
- `ForgeConfigSpec` → `net.neoforged.neoforge.common.ModConfigSpec`（類別更名）。
- Capability 系統 → Attachment 系統：`ICapabilityProvider`、`AttachCapabilitiesEvent` 等移除，需以 `AttachmentType` + `IAttachmentHolder` 重寫（最常見的大改動）。
- `ItemStackHandler` → `net.neoforged.neoforge.items.ItemStackHandler`（套件變更）。

## 事件系統變更

- `@SubscribeEvent`、`@Mod.EventBusSubscriber` 保留（註解套件改為 `net.neoforged.bus.api`）。
- 事件類別多數由 `net.minecraftforge.event.*` 遷至 `net.neoforged.neoforge.event.*`。
- 部分事件移除或改為數據驅動（如自訂流體/桶），需人工確認。

## 資料格式變更

- 模組描述檔：`META-INF/mods.toml`（Forge）→ `META-INF/neoforge.mods.toml`（NeoForge）。
- `neoforge.mods.toml` 結構與 Forge 相近：`modLoader = "javafml"` 保留；`loaderVersion = "[26,)"`；`license` 欄位；`[[dependencies.<modid>]]` 區塊格式沿用。
- 無 fabric.mod.json 概念（若同時支援 Fabric 需另維護）。

## 建構環境變更

- `build.gradle` 插件：`id 'net.minecraftforge.gradle'` → `id 'net.neoforged.gradle.userdev'`。
- 依賴區塊改為 userdev 寫法（`implementation fg.deobf(...)` 保留）。
- `gradle.properties`：ForgeGradle 版本鍵改為 neo 插件版本；`org.gradle.jvmargs` 建議加大。
- Java 17 → 21（`sourceCompatibility/targetCompatibility` 與 `options.release`）。

## 已知遷移陷阱

- 只改版本號不改套件會 runtime crash：`net.minecraftforge` import 需全數清查。
- Capability → Attachment 是行為級重寫，遷移後務必人工驗證。
- 渲染管線（如 `RenderLevelStageEvent`）在 26.x 有調整，相關模組需人工確認。
- mixin 沿用；`MixinExtras` 建議加入（示範）。

## 遷移對照（Forge 1.20.1 → NeoForge 26.2）

本節為本路徑直接變更對照表（供 Agent 參考，非 mock 文字替換；跨載入器一律使用真實模型）。

| 舊 | 新 | 說明 |
| --- | --- | --- |
| `import net.minecraftforge.fml.common.Mod;` | `import net.neoforged.fml.common.Mod;` | 套件重命名 |
| `import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;` | `import net.neoforged.fml.ModLoadingContext;` | 載入上下文 |
| `FMLJavaModLoadingContext.get().getModEventBus()` | `ModLoadingContext.get().getModEventBus()` | 改為靜態方法 |
| `import net.minecraftforge.common.ForgeConfigSpec;` | `import net.neoforged.neoforge.common.ModConfigSpec;` | 設定類別更名 |
| `import net.minecraftforge.eventbus.api.SubscribeEvent;` | `import net.neoforged.bus.api.SubscribeEvent;` | 事件註解套件 |
| `import net.minecraftforge.items.ItemStackHandler;` | `import net.neoforged.neoforge.items.ItemStackHandler;` | 套件變更 |
| `net.minecraftforge.gradle` | `net.neoforged.gradle.userdev` | 建構插件 |
| `import net.minecraftforge.common.capabilities.ICapabilityProvider;` | `import net.neoforged.neoforge.attachment.AttachmentType;` | Capability→Attachment（需人工確認：行為級重寫） |
| `META-INF/mods.toml` | `META-INF/neoforge.mods.toml` | 模組描述檔 |
| `loaderVersion="[40,)"` | `loaderVersion="[26,)"` | 載入器版本範圍 |
