/**
 * 打包成免安装的绿色版 Windows 程序。
 *
 * 产物：dist/FloatingTodo/FloatingTodo.exe（双击即用，无需安装 Node/Electron）
 *
 * 为什么不用 electron-builder / @electron/packager：
 * 它们在本机这台环境下会卡在联网拉取 winCodeSign / NSIS / electron zip，
 * 而我们本地已经有完整的 node_modules/electron/dist，直接复用最省事也最可控。
 *
 * 用法：npm run pack
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const USAGE_TEXT = `悬浮待办 · 使用说明
================================

【怎么启动】
双击 FloatingTodo.exe。屏幕右侧会出现一颗五彩球，那就是它。
首次启动会弹一个引导页，看完点「开始使用」。

【怎么用】
· 单击球           展开 / 收起待办面板
· 按住球拖动       拖到任意位置，松手就记住
· 输入框直接打字   按回车添加；写「明天10点交报告」会自动识别时间
· 点左边的圆圈     标记完成
· 双击标题         就地修改
· 悬停条目         右侧出现「设时间 / 优先级 / 删除」
· Ctrl+Shift+T     在任何程序里唤出面板（设置里可改）
· 托盘图标         单击显示/隐藏球，右键可退出、开机自启、打开数据目录

【数据在哪】
%APPDATA%\\FloatingTodo
完全存在本机，不联网、不上传、无需账号。
想搬到别的电脑：复制这个文件夹即可。

【学习通同步（可选）】
设置（面板右下角齿轮）→ 学习通（自动同步）→ 点「登录学习通」
用手机学习通 App 扫码，登录成功后窗口自动关闭。
之后会自动把「有截止时间的作业 / 考试」变成待办，并在学习通上完成后自动打勾。

注意：不同学校的入口不一样。如果同步不到东西，
在设置里填上你自己学校的「作业列表页」地址即可（高级用法，可忽略）。

【第一次运行被 Windows 拦了？】
提示「Windows 已保护你的电脑」→ 点「更多信息」→ 点「仍要运行」。
这是因为程序没有买数字签名证书，不是有毒。

【想卸载】
直接删掉这个文件夹即可，再到 %APPDATA%\\FloatingTodo 删掉数据（不删就是保留待办）。
`;

const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outRoot = path.join(root, 'dist');
const outDir = path.join(outRoot, 'FloatingTodo');
const appDir = path.join(outDir, 'resources', 'app');

function sleep(ms) {
  // 主线程同步等一会儿（Atomics.wait 不需要额外依赖）
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;

  // 程序还开着的时候 dist 里的 exe/dll 被占用，rmSync 会 EPERM。
  // 重试几次；仍然失败就给一句人话提示，而不是抛一堆栈。
  let lastErr = null;
  for (let i = 0; i < 12; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'ENOTEMPTY') throw err;
      sleep(300);
    }
  }

  console.error('');
  console.error('删不掉 dist 目录，因为程序正在运行：');
  console.error('  ' + p);
  console.error('请先关掉 FloatingTodo.exe（右键托盘图标 → 退出），再重新执行 npm run pack。');
  if (lastErr) console.error('原始错误：' + lastErr.message);
  process.exit(1);
}

function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (filter && !filter(entry.name, src)) continue;
    if (entry.isDirectory()) copyDir(src, dst, filter);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

function main() {
  if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
    console.error('找不到 node_modules/electron/dist/electron.exe，请先执行 npm install');
    process.exit(1);
  }

  console.log('清理旧的产物…');
  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('复制 Electron 运行时（约 200MB，稍等）…');
  copyDir(electronDist, outDir);

  // 主程序改名
  const oldExe = path.join(outDir, 'electron.exe');
  const newExe = path.join(outDir, 'FloatingTodo.exe');
  if (fs.existsSync(newExe)) fs.rmSync(newExe);
  fs.renameSync(oldExe, newExe);

  console.log('写入应用代码…');
  fs.mkdirSync(appDir, { recursive: true });

  copyDir(path.join(root, 'src'), path.join(appDir, 'src'));
  // assets 里 ico-src 只是打包素材，不带走
  copyDir(path.join(root, 'assets'), path.join(appDir, 'assets'), (name) => name !== 'ico-src');

  // 说明文档 + 许可证一起带走：MIT 要求分发时附上许可证原文
  for (const f of ['README.md', '需求文档.md', '产品简述-正式版.md', 'LICENSE']) {
    const src = path.join(root, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(appDir, f));
  }

  // 精简版 package.json：只留 Electron 运行时需要读的字段
  const appPkg = {
    name: pkg.name,
    productName: pkg.productName || 'FloatingTodo',
    version: pkg.version,
    description: pkg.description,
    main: pkg.main,
    private: true,
    license: pkg.license || 'MIT'
  };
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(appPkg, null, 2), 'utf8');

  // 放一份给「别人」看的说明在 exe 旁边
  fs.writeFileSync(path.join(outDir, '使用说明.txt'), USAGE_TEXT, 'utf8');

  const sizeMb = dirSize(outDir) / 1024 / 1024;
  console.log('');
  console.log('打包完成 ✔');
  console.log('  可执行文件: ' + newExe);
  console.log('  整包大小  : ' + sizeMb.toFixed(1) + ' MB');
  console.log('  数据目录  : %APPDATA%\\FloatingTodo');
  console.log('');
  console.log('提示：想做成便携版（数据跟着文件夹走），把 FLOATING_TODO_HOME 指向包内目录即可。');
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

main();
