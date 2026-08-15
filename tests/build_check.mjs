// 模擬建構檢查器（供迭代修正測試用）：
// 只要任何 .java 仍含 MC-MIGRATE-REVIEW 標記就失敗，模擬「有風險標註即建構失敗」的驗證器。
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const bad = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name === 'build' || e.name === '.mc-migrate') continue;
      walk(p);
    } else if (e.name.endsWith('.java') && fs.readFileSync(p, 'utf8').includes('MC-MIGRATE-REVIEW')) {
      bad.push(p);
    }
  }
};
walk(root);
if (bad.length) {
  console.error(`建構檢查失敗：仍有 ${bad.length} 個未解決的 MC-MIGRATE-REVIEW 標記`);
  process.exit(1);
}
console.log('建構檢查通過');
