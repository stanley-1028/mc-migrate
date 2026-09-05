// 打包前置：把共用的核心與資料目錄同步進 app/（單一來源：專案根 lib/mcenv/skills）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APP, '..');

for (const name of ['lib', 'mcenv', 'skills']) {
  fs.rmSync(path.join(APP, name), { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, name), path.join(APP, name), { recursive: true });
  console.log(`已同步 app/${name}/`);
}
fs.copyFileSync(path.join(ROOT, 'gen-env.mjs'), path.join(APP, 'gen-env.mjs'));
console.log('已同步 app/gen-env.mjs');
