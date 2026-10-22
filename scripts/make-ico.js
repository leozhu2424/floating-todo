/**
 * 把 assets/ico-src/icon-*.png 打包成多尺寸 Windows 图标 assets/app.ico
 *
 * ICO 允许每个尺寸条目直接内嵌 PNG（Vista+ 支持），所以不需要任何第三方库：
 *   ICONDIR  (6 字节) + N × ICONDIRENTRY (16 字节) + N 段 PNG 数据
 *
 * 用法：node scripts/make-ico.js
 */
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'assets', 'ico-src');
const OUT = path.join(__dirname, '..', 'assets', 'app.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const images = [];
for (const size of SIZES) {
  const file = path.join(SRC_DIR, `icon-${size}.png`);
  if (!fs.existsSync(file)) {
    console.warn(`skip missing ${file}`);
    continue;
  }
  const bytes = fs.readFileSync(file);
  // 校验确实是 PNG
  const isPng = bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isPng) {
    console.warn(`skip non-png ${file}`);
    continue;
  }
  images.push({ size, bytes });
}

if (images.length === 0) {
  console.error('no PNG sources found, run assets/make-icons.ps1 first');
  process.exit(1);
}

images.sort((a, b) => a.size - b.size);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(images.length, 4);

const entries = [];
let offset = 6 + images.length * 16;

for (const img of images) {
  const e = Buffer.alloc(16);
  // 256 在 ICO 里用 0 表示
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // width
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // height
  e.writeUInt8(0, 2); // 调色板颜色数
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(img.bytes.length, 8); // 数据长度
  e.writeUInt32LE(offset, 12); // 数据偏移
  entries.push(e);
  offset += img.bytes.length;
}

const out = Buffer.concat([header, ...entries, ...images.map((i) => i.bytes)]);
fs.writeFileSync(OUT, out);
console.log(`wrote ${OUT} (${images.length} sizes: ${images.map((i) => i.size).join('/')}, ${(out.length / 1024).toFixed(1)} KB)`);
