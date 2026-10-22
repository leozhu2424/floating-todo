/**
 * 分析「任务列表」页里每一行的类型/状态，用来决定怎么过滤签到这类噪音。
 * 用法：node scripts/analyze-rows.js
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(process.env.APPDATA || '', 'FloatingTodo');
const files = fs.readdirSync(dir).filter((x) => x.startsWith('empty-')).sort();
if (!files.length) {
  console.log('没有 empty-*.html，先让程序在抓不到内容时保存一次页面');
  process.exit(0);
}

const file = files[files.length - 1];
const html = fs.readFileSync(path.join(dir, file), 'utf8');
console.log('文件:', file, '长度:', html.length);

function pick(src, re) {
  const m = src.match(re);
  return m ? m[1] : '-';
}

const liRe = /<li[^>]*activeid="(\d+)"[^>]*>/gi;
let m;
let count = 0;

console.log('');
while ((m = liRe.exec(html)) !== null && count < 15) {
  const start = m.index;
  const seg = html.slice(start, start + 4000);
  const endIdx = seg.indexOf('</li>');
  const liHtml = endIdx > 0 ? seg.slice(0, endIdx) : seg;

  const typeLabel = pick(liHtml, /aria-label="([^"]+)"/);
  const title = pick(liHtml, /<p[^>]*>([^<]*)<\/p>/);
  const time = pick(liHtml, /<div class="time[^"]*">[\s\S]*?<span>([^<]*)</);
  const status = pick(liHtml, /(已结束|已完成|进行中|未开始)/);
  const attrs = pick(html.slice(start, start + 200), /<li([^>]*)>/);

  console.log(`id=${m[1]}  类型=${typeLabel}  状态=${status}  时间=${time}`);
  console.log(`    标题: ${title.trim().slice(0, 70)}`);
  if (count === 0) console.log(`    属性: ${attrs.trim().slice(0, 200)}`);
  count++;
}
