/**
 * 用真实的保存页面跑一遍采集器，打印它到底解析出了什么（含 done 标记）。
 * 用法：node_modules\electron\dist\electron.exe scripts\collect-saved.js [文件路径]
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const { SOURCE } = require('../src/shared/chaoxing-collector');

const dir = path.join(process.env.APPDATA || '', 'FloatingTodo');

function pickFile() {
  if (process.argv[2]) return process.argv[2];
  const files = fs
    .readdirSync(dir)
    .filter((x) => x.startsWith('page-') && x.endsWith('.html'))
    .map((x) => path.join(dir, x))
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  return files[0];
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const file = pickFile();
  if (!file || !fs.existsSync(file)) {
    console.error('找不到页面文件');
    app.exit(1);
    return;
  }
  console.log('页面:', path.basename(file), fs.statSync(file).size, '字节');
  console.log('');

  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: { partition: 'persist:collector-test2', contextIsolation: true }
  });

  await win.loadFile(file);
  const items = await win.webContents.executeJavaScript(SOURCE, true);

  console.log(`采集到 ${items.length} 条：`);
  for (const it of items) {
    console.log(
      `  ${it.done ? '[已完成]' : '[    ]'} ${String(it.title).padEnd(28)} 课程=${it.course || '-'}`
    );
  }

  console.log('');
  const twist = items.filter((x) => String(x.title).includes('扭摆'));
  console.log('关于「扭摆」:', twist.length ? JSON.stringify(twist, null, 2) : '采集结果里没有它');

  win.destroy();
  app.exit(0);
});
