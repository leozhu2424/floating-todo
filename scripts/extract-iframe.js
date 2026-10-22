/**
 * 从保存下来的课程页 HTML 里提取 iframe 地址（任务列表就在这个 iframe 里）。
 * 用法：node scripts/extract-iframe.js
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(process.env.APPDATA || '', 'FloatingTodo');
const files = fs
  .readdirSync(dir)
  .filter((x) => x.startsWith('empty-') || x.startsWith('dump-'))
  .sort();

if (!files.length) {
  console.log('没有找到 empty-*.html / dump-*.html');
  process.exit(0);
}

const file = files[files.length - 1];
const html = fs.readFileSync(path.join(dir, file), 'utf8');
console.log('文件:', file, '长度:', html.length);

const matches = [...html.matchAll(/<iframe[^>]*>/gi)].map((m) => m[0]);
if (!matches.length) {
  console.log('页面里没有 iframe');
  process.exit(0);
}

console.log('iframe 数量:', matches.length);
for (const tag of matches) {
  const srcMatch = tag.match(/src="([^"]+)"/i);
  const src = srcMatch ? srcMatch[1].replace(/&amp;/g, '&') : '(无 src)';
  console.log('');
  console.log('id  :', (tag.match(/id="([^"]+)"/i) || [])[1] || '-');
  console.log('src :', src);
}

// 顺便看看「任务」页签的 data-url
const tabMatch = html.match(/title="任务"[^>]*data-url="([^"]+)"/i);
if (tabMatch) console.log('\n任务页签 data-url:', tabMatch[1].replace(/&amp;/g, '&'));
