/**
 * 在保存下来的页面里找一个作业行，打印它周围的真实结构。
 * 用法：node scripts/find-row.js 扭摆
 */
const fs = require('fs');
const path = require('path');

const kw = process.argv[2] || '扭摆';
const dir = path.join(process.env.APPDATA || '', 'FloatingTodo');

const files = fs
  .readdirSync(dir)
  .filter((x) => x.startsWith('page-'))
  .sort();

if (!files.length) {
  console.log('没有 page-*.html');
  process.exit(0);
}

for (const f of files) {
  const html = fs.readFileSync(path.join(dir, f), 'utf8');
  const at = html.indexOf(kw);
  if (at < 0) continue;

  console.log('==============================');
  console.log('文件:', f, ' 长度:', html.length);
  console.log('关键词位置:', at);
  console.log('');

  // 打印关键词前面 1200 字、后面 600 字
  const s = Math.max(0, at - 1200);
  const e = Math.min(html.length, at + 600);
  console.log(html.slice(s, e).replace(/\s+/g, ' '));
  console.log('');
  break;
}
