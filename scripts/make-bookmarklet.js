/**
 * 生成「书签脚本」安装页：userscript/书签-同步学习通.html
 *
 * 从 %APPDATA%\FloatingTodo\todos.json 读当前端口和令牌，注入到
 * userscript/bookmarklet-src.js，产出一个可以拖到书签栏的链接。
 *
 * 用法：node scripts/make-bookmarklet.js
 * 注意：生成出来的 HTML 里带着你的接入令牌，别发给别人。
 */
const fs = require('fs');
const path = require('path');

const dataFile = path.join(process.env.APPDATA || '', 'FloatingTodo', 'todos.json');
if (!fs.existsSync(dataFile)) {
  console.error('找不到 ' + dataFile);
  console.error('先把悬浮待办启动一次，让它生成令牌。');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const port = state.settings.ingestPort || 45870;
const token = state.settings.ingestToken;

if (!token) {
  console.error('还没有令牌。先启动一次程序（本机接入服务会自动生成令牌）。');
  process.exit(1);
}
if (state.settings.ingestEnabled === false) {
  console.warn('提醒：设置里「接收浏览器脚本推送的作业」是关着的，生成的书签点了也不会有结果。');
}

const srcFile = path.join(__dirname, '..', 'userscript', 'bookmarklet-src.js');
let code = fs.readFileSync(srcFile, 'utf8');

// 去掉最前面的说明性块注释（书签里不需要，太占长度）
code = code.replace(/^\/\*\*[\s\S]*?\*\/\s*/, '');

// 注入配置
code = code.replace(/__ENDPOINT__/g, `http://127.0.0.1:${port}`);
code = code.replace(/__TOKEN__/g, token);

// 保守压缩：折叠换行和缩进为单个空格（源码里没有用到行尾 ASI 风险的写法）
code = code
  .replace(/\r/g, '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .join(' ');

// 去掉语句之间多余的空格，但保留必要的
code = code.replace(/\s{2,}/g, ' ');

const bookmarklet = 'javascript:' + code;

// HTML 属性转义
const hrefAttr = bookmarklet.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>添加书签脚本 · 同步学习通</title>
<style>
  body { margin: 0; padding: 32px 28px; font: 15px/1.75 "Microsoft YaHei UI", "Segoe UI", sans-serif; color: #1f1f1f; background: #fafbfc; }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 21px; margin: 0 0 6px; }
  .sub { color: #5f6368; font-size: 13px; margin-bottom: 26px; }
  .card { background: #fff; border: 1px solid rgba(0,0,0,.07); border-radius: 14px; padding: 22px 24px; box-shadow: 0 6px 22px rgba(0,0,0,.06); }
  .step { display: flex; gap: 12px; margin-bottom: 18px; }
  .num { flex: none; width: 24px; height: 24px; border-radius: 50%; background: #4285f4; color: #fff; font-size: 13px; font-weight: 700; display: grid; place-items: center; }
  .step div.body { flex: 1; }
  .drag {
    display: inline-block; margin: 10px 0 4px; padding: 11px 22px; border-radius: 10px;
    background: linear-gradient(90deg,#4285f4,#9b72cb 28%,#d96570 52%,#f9ab00 76%,#34a853);
    color: #fff; font-weight: 700; font-size: 15px; text-decoration: none; cursor: grab;
    box-shadow: 0 4px 14px rgba(66,133,244,.4);
  }
  .drag:active { cursor: grabbing; }
  code { background: rgba(0,0,0,.06); padding: 2px 6px; border-radius: 5px; font-size: 13px; }
  .tip { background: #fff8e1; border: 1px solid #ffe082; border-radius: 10px; padding: 12px 14px; font-size: 13px; color: #6d4c00; margin-top: 18px; }
  .danger { background: #fdecea; border: 1px solid #f5c6c2; color: #a3271d; }
  .meta { font-size: 12px; color: #9aa0a6; margin-top: 14px; word-break: break-all; }
</style>
</head>
<body>
<div class="wrap">
  <h1>把「同步学习通」加到书签栏</h1>
  <div class="sub">不用装任何扩展，Chrome / Edge / Firefox 都能用。代价是每次要自己点一下。</div>

  <div class="card">
    <div class="step">
      <div class="num">1</div>
      <div class="body">
        如果书签栏没显示，先按 <code>Ctrl + Shift + B</code> 把它打开。
      </div>
    </div>

    <div class="step">
      <div class="num">2</div>
      <div class="body">
        <b>把下面这个彩色按钮拖到书签栏</b>（按住不放，拖到浏览器的书签栏上松手）：
        <br>
        <a class="drag" href="${hrefAttr}" onclick="event.preventDefault(); alert('请把这个按钮拖到书签栏，不要直接点击。'); return false;">📚 同步学习通</a>
      </div>
    </div>

    <div class="step">
      <div class="num">3</div>
      <div class="body">
        打开学习通的<b>作业 / 考试列表页</b>（能看到截止时间的那一页）。
      </div>
    </div>

    <div class="step">
      <div class="num">4</div>
      <div class="body">
        点书签栏上的 <b>📚 同步学习通</b>，会弹出一个结果框告诉你抓到了几条、新增几条。
      </div>
    </div>

    <div class="tip">
      拖不动？点下面的按钮复制代码，然后：书签管理器 → 新建书签 → 名称随便写，
      「网址」一栏 <code>Ctrl+V</code> 粘进去保存。
      <br><br>
      <button id="copyBtn" style="border:1px solid rgba(0,0,0,.12);background:#fff;border-radius:8px;padding:7px 14px;font:inherit;font-size:13px;cursor:pointer;">复制书签代码</button>
      <span id="copyMsg" style="font-size:13px;color:#188038;margin-left:8px;"></span>
      <br><br>
      <textarea id="bmCode" readonly rows="4" style="width:100%;box-sizing:border-box;font:12px/1.5 Consolas,monospace;padding:8px;border:1px solid rgba(0,0,0,.12);border-radius:8px;color:#5f6368;">${hrefAttr.replace(/&amp;/g, '&').replace(/&quot;/g, '"')}</textarea>
    </div>

    <div class="tip">
      连不上时先看：屏幕右上角那颗五彩球还在不在（程序要开着）。<br>
      如果提示「没找到带截止时间的作业」，把那一页另存为 HTML 发给开发者调规则。
    </div>

    <div class="tip danger">
      这个文件里带着你的本机接入令牌，别发给别人、别传到网上。
    </div>

    <div class="meta">
      接入地址：http://127.0.0.1:${port}<br>
      令牌：${token.slice(0, 8)}…（共 ${token.length} 位）<br>
      书签脚本长度：${bookmarklet.length} 字符
    </div>
  </div>
</div>
<script>
  (function () {
    var btn = document.getElementById('copyBtn');
    var box = document.getElementById('bmCode');
    var msg = document.getElementById('copyMsg');
    btn.addEventListener('click', function () {
      box.focus();
      box.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e) {
        ok = false;
      }
      if (!ok && navigator.clipboard) {
        navigator.clipboard.writeText(box.value).then(function () {
          msg.textContent = '已复制 ✔';
        });
        return;
      }
      msg.textContent = ok ? '已复制 ✔' : '请手动 Ctrl+C';
    });
  })();
</script>
</body>
</html>
`;

const outFile = path.join(__dirname, '..', 'userscript', '书签-同步学习通.html');
fs.writeFileSync(outFile, html, 'utf8');

console.log('已生成：' + outFile);
console.log(`  接入地址 http://127.0.0.1:${port}`);
console.log(`  令牌 ${token.slice(0, 8)}…（${token.length} 位）`);
console.log(`  书签脚本 ${bookmarklet.length} 字符`);
console.log('');
console.log('用浏览器打开这个 HTML，把彩色按钮拖到书签栏即可。');
