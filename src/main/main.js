'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
  shell,
  dialog,
  globalShortcut,
  clipboard,
  session
} = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// 悬浮球/面板都是「透明 + 置顶 + 无边框」窗口。Chromium 默认会算「窗口有没有被
// 别的窗口挡住」，一旦它认为被挡住了就不再重绘；而 Windows 上透明窗口的鼠标
// 命中区域是按上一次绘制的结果算的 —— 结果就是球明明看得见，却点不动
// （历史上那个「用着用着就点不开」的 bug）。关掉遮挡计算，让它一直正常绘制。
// ---------------------------------------------------------------------------
try {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
} catch (_) {
  /* ignore */
}

// ---------------------------------------------------------------------------
// 路径：允许用 FLOATING_TODO_HOME 把数据/缓存全部重定向（便于沙箱内测试与便携版）
// ---------------------------------------------------------------------------
const HOME = process.env.FLOATING_TODO_HOME || null;
if (HOME) {
  fs.mkdirSync(HOME, { recursive: true });
  app.setPath('userData', path.join(HOME, 'userData'));
  app.setPath('cache', path.join(HOME, 'cache'));
  try {
    app.setPath('sessionData', path.join(HOME, 'userData'));
  } catch (_) {
    /* 旧版本可能没有 sessionData */
  }
  app.setPath('crashDumps', path.join(HOME, 'crashDumps'));
}

const { Store, APP_FOLDER } = require('./store');
const { Reminder } = require('./reminder');
const { IngestServer } = require('./ingest');
const { SOURCE: CX_COLLECT_SOURCE } = require('../shared/chaoxing-collector');
const { randomBytes } = require('crypto');

const DATA_DIR = HOME ? path.join(HOME, 'data') : path.join(app.getPath('appData'), APP_FOLDER);

// 球体外留白：只留 6px 给光晕和内圈。
// 以前是 18px，靠 setIgnoreMouseEvents 让外圈点击穿透，但运行约 2.4 小时后会出现
// 「窗口系统层面可点击、渲染层却收不到任何鼠标事件」的死状态（点不动）。
// 现在把窗口压到最小且永不切换穿透，牺牲一点点透明区，换取绝对可靠。
const BALL_PAD = 6;
const PANEL_PAD = 20; // 卡片外留白，用于投影
const PANEL_GAP = 10; // 卡片与球的间距

let store = null;
let ballWin = null;
let panelWin = null;
let tray = null;
let reminder = null;
let ingest = null;

// ---------------------------------------------------------------------------
// 内置学习通同步：用一个隐藏窗口保持登录态，不依赖浏览器和油猴脚本
// ---------------------------------------------------------------------------
const CX_PARTITION = 'persist:chaoxing';
// 主来源走通用域名：它的登录页支持手机扫码（学校实例 mooc1.s.ecust.edu.cn
// 会跳到学校 SSO，反而麻烦）。两个域名会话是分开的，所以各自都可能需要单独登录，
// 抓取时会跳过「要登录」的来源，不会因为一个失败就全废。
const CX_WORK_URL = 'https://mooc1-api.chaoxing.com/work/stu-work';
// 学校自建学习通实例的地址**因校而异**，不能写死某一所学校的域名。
// 用户在设置里填（或从已有页面里自动识别）之后才启用「学校入口」，
// 没配就只用通用入口，不会因为默认写死华理的地址而在别人电脑上乱跳。
const CX_SCHOOL_WORK_PATH = '/work/stu-work';
// 学习通对非常规 UA 可能另做处理，这里伪装成普通 Chrome
const CX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

let cxFetchWin = null;
let cxLoginWin = null;
let cxTimer = null;
let cxLoginPoll = null;
let cxBusy = false;
let cxLoginLoadedOnce = false;

const cxState = {
  status: 'idle', // idle | syncing | ok | need-login | error | disabled
  loggedIn: false,
  partialLogin: 0, // 有多少个来源因为登录过期被跳过
  lastAt: null, // 最近一次「成功」同步
  lastAttemptAt: null,
  lastResult: null,
  message: '',
  schoolUrl: '', // 学校实例作业总表（用户填的或自动识别出来的，空=不启用）
  schoolSuggested: '' // 纯自动识别的结果，给界面做提示
};

let dragTimer = null;
let dragOffset = { x: 0, y: 0 };
let dragOrigin = null;
let dragActive = false;
let panelHiddenByBlurAt = 0;
let panelShownAt = 0;
let backdropWin = null;
let lastDayKey = '';
let isQuitting = false;
let ballVisible = true;
let lastHotkeyOk = true;

// 诊断开关：强制球窗口接收鼠标事件（用于排查点击穿透链路）
const FORCE_BALL_INTERACTIVE = process.env.FLOATING_TODO_FORCE_INTERACTIVE === '1';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function clamp(v, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(v, min), max);
}

function logToFile(...args) {
  try {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
    fs.appendFileSync(path.join(DATA_DIR, 'app.log'), line);
  } catch (_) {
    /* 日志失败不影响运行 */
  }
}

/** 把渲染进程的 console / 加载失败 / 崩溃都落到 app.log，方便无 DevTools 时排查 */
function wireConsole(win, tag) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;

  wc.on('console-message', (...args) => {
    const detail = args[1];
    if (detail && typeof detail === 'object' && detail.message !== undefined) {
      logToFile(`[${tag}:${detail.level || 'log'}] ${detail.message}`);
    } else {
      logToFile(`[${tag}:${args[1]}] ${args[2]}`);
    }
  });

  wc.on('did-fail-load', (_e, code, desc, url) => {
    logToFile(`[${tag}] did-fail-load ${code} ${desc} ${url}`);
  });

  let crashReloads = 0;
  wc.on('did-finish-load', () => {
    crashReloads = 0;
  });
  wc.on('render-process-gone', (_e, details) => {
    logToFile(`[${tag}] render-process-gone ${JSON.stringify(details)}`);
    if (isQuitting) return;
    // 渲染进程崩了窗口就成了「白的、点不动」的尸体：直接重载，
    // 否则用户看到的就是「球/面板点不开」，而且怎么点都没反应。
    // 但要防死循环：一分钟内崩三次就放弃，别把 CPU 烧了。
    if (crashReloads >= 3) {
      logToFile(`[${tag}] crash loop, give up reloading`);
      return;
    }
    crashReloads += 1;
    try {
      if (!win || win.isDestroyed()) return;
      if (!wc.isDestroyed()) wc.reload();
      logToFile(`[${tag}] reloaded after crash (#${crashReloads})`);
    } catch (err) {
      logToFile(`[${tag}] reload failed ${(err && err.message) || err}`);
    }
  });

  wc.on('preload-error', (_e, preloadPath, error) => {
    logToFile(`[${tag}] preload-error ${preloadPath} ${error && error.message}`);
  });
}

// ---------------------------------------------------------------------------
// 鼠标穿透：主进程轮询光标位置
//
// 为什么不用 setIgnoreMouseEvents(true, {forward:true})：
// 在 transparent:true + focusable:false 的窗口上，forward 并不会把 mousemove
// 送到渲染层（实测收不到），于是 hover 永远不触发、窗口永远忽略点击，
// 球就「点不动」。改成主进程直接读光标坐标，命中圆才打开鼠标事件，最稳。
// ---------------------------------------------------------------------------
let hoverTimer = null;
let lastHover = null;
let lastSizeKey = '';
let lastAssertAt = 0;

function ballHitTest() {
  if (!ballWin || ballWin.isDestroyed() || !ballWin.isVisible()) return null;
  const { size } = ballMetrics();
  const b = ballWin.getBounds();

  // 必须用「窗口中心」而不是 pad + size/2：
  // 球在页面里是 grid 居中的，只要窗口尺寸和预期不一致（DPI 变化、被系统重算过等），
  // 用固定偏移算出来的圆心就会偏离球心，导致 hover 判不中 → 窗口一直穿透 → 球点不动。
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const p = screen.getCursorScreenPoint();
  const r = Math.max(12, size / 2 + 2);
  return Math.hypot(p.x - cx, p.y - cy) <= r;
}

function setBallHover(inside) {
  if (lastHover === inside) return;
  lastHover = inside;
  if (ballWin && !ballWin.isDestroyed()) {
    // 只同步 hover 视觉，不再切换鼠标穿透（窗口永远接收鼠标事件）
    try {
      ballWin.webContents.send('ball:set-hover', inside);
    } catch (_) {
      /* ignore */
    }
  }
}

function startHoverPoll() {
  stopHoverPoll();
  hoverTimer = setInterval(() => {
    if (isQuitting) return;
    // 拖动中窗口跟着光标走，别去动鼠标事件状态，否则会打断拖动
    if (dragActive) return;
    if (!ballWin || ballWin.isDestroyed() || !ballWin.isVisible()) {
      lastHover = null;
      return;
    }

    // 窗口尺寸一旦被系统改掉，记一笔并在偏差较大时拉回来
    const b = ballWin.getBounds();
    const { win } = ballMetrics();
    if (Math.abs(b.width - win) > 8 || Math.abs(b.height - win) > 8) {
      ballWin.setBounds({ x: b.x, y: b.y, width: win, height: win });
      logToFile(`[ball] size drift ${b.width}x${b.height} -> ${win}x${win} at ${b.x},${b.y}`);
    }
    const sizeKey = `${b.width}x${b.height}`;
    if (sizeKey !== lastSizeKey) {
      lastSizeKey = sizeKey;
      logToFile(`[ball] window size ${sizeKey} (expect ${win}x${win}) at ${b.x},${b.y}`);
    }

    const inside = ballHitTest();
    if (inside !== null) setBallHover(inside);
  }, 40);
}

function stopHoverPoll() {
  if (hoverTimer) clearInterval(hoverTimer);
  hoverTimer = null;
}

/**
 * 跨天检查：重复任务「下一次」被藏起来了（见 visibleTodos），
 * 到了新的一天要主动刷新一次，否则界面要等下一次数据变化才更新。
 */
function startDayWatcher() {
  lastDayKey = new Date().toDateString();
  setInterval(() => {
    if (isQuitting) return;
    const key = new Date().toDateString();
    if (key === lastDayKey) return;
    lastDayKey = key;
    logToFile('[day] 日期变了，刷新界面');
    broadcastState();
  }, 30 * 1000);
}

function ballMetrics() {
  const size = (store && store.state.settings.ballSize) || 44;
  return { size, pad: BALL_PAD, win: size + BALL_PAD * 2 };
}

function panelMetrics() {
  const cardW = (store && store.state.settings.panelWidth) || 320;
  const cardH = (store && store.state.settings.panelHeight) || 420;
  return { cardW, cardH, winW: cardW + PANEL_PAD * 2, winH: cardH + PANEL_PAD * 2 };
}

/** 把球窗口夹回可视区域；找不到落点就回主屏右侧居中 */
function clampToDisplays(x, y, winSize) {
  const probe = { x: Math.round(x), y: Math.round(y), width: winSize, height: winSize };
  const display = screen.getDisplayMatching(probe);
  const wa = display.workArea;
  return {
    x: clamp(Math.round(x), wa.x, wa.x + wa.width - winSize),
    y: clamp(Math.round(y), wa.y, wa.y + wa.height - winSize)
  };
}

function fallbackBallPosition(winSize) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - winSize - 12,
    y: workArea.y + Math.round((workArea.height - winSize) / 2)
  };
}

// ---------------------------------------------------------------------------
// 悬浮球窗口
// ---------------------------------------------------------------------------
function createBallWindow() {
  const { size, pad, win } = ballMetrics();

  const saved = store.state.ball;
  let pos =
    Number.isFinite(saved.x) && Number.isFinite(saved.y)
      ? clampToDisplays(saved.x, saved.y, win)
      : fallbackBallPosition(win);

  ballWin = new BrowserWindow({
    width: win,
    height: win,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    show: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  ballWin.setAlwaysOnTop(true, 'screen-saver');
  ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 注意：这里不调用 setIgnoreMouseEvents。窗口必须永远接收鼠标事件，
  // 否则会进入「系统层面可点击、渲染层收不到」的死状态（详见 BALL_PAD 处的注释）。
  lastHover = null;

  wireConsole(ballWin, 'ball');

  ballWin.loadFile(path.join(__dirname, '../renderer/ball/index.html'), {
    query: { size: String(size), pad: String(pad) }
  });

  ballWin.webContents.once('did-finish-load', () => {
    logToFile('ball did-finish-load');
    if (ballVisible && ballWin && !ballWin.isDestroyed() && !ballWin.isVisible()) {
      ballWin.showInactive();
      // 记录下来：窗口真实尺寸一旦和预期不符，球心判定就会偏（曾经的 bug）
      logToFile(`[ball] real bounds=${JSON.stringify(ballWin.getBounds())} expect=${win}x${win}`);
    }
  });

  ballWin.once('ready-to-show', () => {
    if (!ballWin || ballWin.isDestroyed()) return;
    logToFile('ball ready-to-show');
    if (ballVisible) ballWin.showInactive();
  });

  ballWin.on('closed', () => {
    ballWin = null;
  });

  logToFile(`ball created size=${size} at ${pos.x},${pos.y}`);
}

function destroyBallWindow() {
  if (ballWin && !ballWin.isDestroyed()) {
    ballWin.destroy();
    ballWin = null;
  }
}

/** 改动球尺寸后重建窗口，保持球心位置不变 */
function rebuildBallWindow() {
  let center = null;
  if (ballWin && !ballWin.isDestroyed()) {
    const b = ballWin.getBounds();
    center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  destroyBallWindow();
  createBallWindow();

  if (center && ballWin && !ballWin.isDestroyed()) {
    const { win } = ballMetrics();
    const next = clampToDisplays(center.x - win / 2, center.y - win / 2, win);
    ballWin.setPosition(next.x, next.y);
    store.saveBallPosition(next.x, next.y, String(screen.getDisplayMatching(ballWin.getBounds()).id));
  }

  if (ballWin) {
    ballWin.webContents.once('did-finish-load', () => pushStateTo(ballWin));
  }
}

function stopDrag() {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
}

function startDrag() {
  stopDrag();
  dragTimer = setInterval(() => {
    if (!ballWin || ballWin.isDestroyed()) {
      stopDrag();
      return;
    }
    const p = screen.getCursorScreenPoint();
    // 用 setBounds 顺带把尺寸钉死：只调 setPosition 时，窗口尺寸会被 DPI 取整
    // 一点点撑大（实测 80→84→85…），撑大了球心判定就会偏。
    const { win } = ballMetrics();
    ballWin.setBounds({
      x: Math.round(p.x - dragOffset.x),
      y: Math.round(p.y - dragOffset.y),
      width: win,
      height: win
    });
    if (panelWin && panelWin.isVisible()) positionPanel();
  }, 16);
}

function persistBallPosition() {
  if (!ballWin || ballWin.isDestroyed()) return;
  const [x, y] = ballWin.getPosition();
  const display = screen.getDisplayMatching(ballWin.getBounds());
  store.saveBallPosition(x, y, String(display.id));
  store.saveNow();
}

// ---------------------------------------------------------------------------
// 靠边吸附：松手时离屏幕边缘够近就贴上去
// ---------------------------------------------------------------------------
const SNAP_DIST = 18; // DIP：离边缘 18px 以内就吸附
let ballAnimTimer = null;

function animateBallTo(tx, ty, done) {
  if (!ballWin || ballWin.isDestroyed()) return;
  if (ballAnimTimer) {
    clearInterval(ballAnimTimer);
    ballAnimTimer = null;
  }

  const { win } = ballMetrics();
  const from = ballWin.getBounds();
  const noAnim = store.state.settings.animation === false;
  const dur = 120;
  const start = Date.now();

  if (noAnim || (from.x === tx && from.y === ty)) {
    ballWin.setBounds({ x: tx, y: ty, width: win, height: win });
    if (panelWin && panelWin.isVisible()) positionPanel();
    if (done) done();
    return;
  }

  ballAnimTimer = setInterval(() => {
    if (!ballWin || ballWin.isDestroyed()) {
      clearInterval(ballAnimTimer);
      ballAnimTimer = null;
      return;
    }
    const t = Math.min(1, (Date.now() - start) / dur);
    const e = 1 - Math.pow(1 - t, 3); // ease-out
    ballWin.setBounds({
      x: Math.round(from.x + (tx - from.x) * e),
      y: Math.round(from.y + (ty - from.y) * e),
      width: win,
      height: win
    });
    if (panelWin && panelWin.isVisible()) positionPanel();
    if (t >= 1) {
      clearInterval(ballAnimTimer);
      ballAnimTimer = null;
      if (done) done();
    }
  }, 16);
}

/** 离最近的屏幕边缘够近就吸附过去；返回 true 表示吸了 */
/**
 * 拖动时窗口是完全跟着光标走的，光标贴到屏幕边上时球会被推出屏幕外。
 * 松手后先把它拉回工作区内，再做吸附判断（顺便让「到边的距离」不会是负数）。
 */
function clampBallToWorkArea() {
  if (!ballWin || ballWin.isDestroyed()) return;
  const { win } = ballMetrics();
  const b = ballWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const x = clamp(b.x, wa.x, wa.x + wa.width - win);
  const y = clamp(b.y, wa.y, wa.y + wa.height - win);
  if (x === b.x && y === b.y) return;
  ballWin.setBounds({ x, y, width: win, height: win });
  if (panelWin && panelWin.isVisible()) positionPanel();
  logToFile(`[ball] clamped ${b.x},${b.y} -> ${x},${y}`);
}

function snapBallToEdge() {
  if (!ballWin || ballWin.isDestroyed()) return false;

  // 不管吸不吸附，先保证球完整留在屏幕内
  clampBallToWorkArea();
  if (store.state.settings.snapToEdge === false) return false;

  const { win } = ballMetrics();
  const b = ballWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;

  // 两个方向各自判断：拖到角落时能同时贴住横竖两条边
  const sides = [];
  let x = b.x;
  let y = b.y;

  if (b.x - wa.x <= SNAP_DIST) {
    x = wa.x;
    sides.push('left');
  } else if (wa.x + wa.width - (b.x + b.width) <= SNAP_DIST) {
    x = wa.x + wa.width - win;
    sides.push('right');
  }

  if (b.y - wa.y <= SNAP_DIST) {
    y = wa.y;
    sides.push('top');
  } else if (wa.y + wa.height - (b.y + b.height) <= SNAP_DIST) {
    y = wa.y + wa.height - win;
    sides.push('bottom');
  }

  if (!sides.length || (x === b.x && y === b.y)) return false;

  logToFile(`[ball] snap ${sides.join('+')} -> ${x},${y}`);
  animateBallTo(x, y, () => persistBallPosition());
  return true;
}

function toggleBallVisibility() {
  if (!ballWin || ballWin.isDestroyed()) {
    ballVisible = true;
    createBallWindow();
    return;
  }
  if (ballVisible) {
    ballVisible = false;
    ballWin.hide();
  } else {
    ballVisible = true;
    ballWin.showInactive();
  }
  updateTrayMenu();
}

// ---------------------------------------------------------------------------
// 面板窗口
// ---------------------------------------------------------------------------
function createPanelWindow() {
  const { winW, winH } = panelMetrics();

  panelWin = new BrowserWindow({
    width: winW,
    height: winH,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  panelWin.setAlwaysOnTop(true, 'screen-saver');
  wireConsole(panelWin, 'panel');

  // 开发用：直接打开设置抽屉，方便截图核对
  if (process.env.FLOATING_TODO_OPEN_SHEET === '1') {
    panelWin.loadFile(path.join(__dirname, '../renderer/panel/index.html'), { query: { sheet: '1' } });
  } else {
    panelWin.loadFile(path.join(__dirname, '../renderer/panel/index.html'));
  }

  // 失焦只记日志：面板关不关由「挡板」和「点球」决定，不靠焦点判断。
  // （这台机器上系统经常把前台抢回去，一失焦就收起会导致面板一闪就没。）
  panelWin.on('blur', () => {
    if (isQuitting) return;
    if (!panelWin || panelWin.isDestroyed() || !panelWin.isVisible()) return;
    logToFile(`[panel] blur after ${Date.now() - panelShownAt}ms (ignored, 由挡板负责收起)`);
  });

  panelWin.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hidePanel();
  });

  panelWin.on('closed', () => {
    panelWin = null;
  });

  logToFile('panel created');
}

function positionPanel() {
  if (!ballWin || ballWin.isDestroyed() || !panelWin || panelWin.isDestroyed()) return;

  const { size, pad } = ballMetrics();
  const { cardW, cardH, winW, winH } = panelMetrics();
  const bb = ballWin.getBounds();
  const display = screen.getDisplayMatching(bb);
  const wa = display.workArea;

  const ballCX = bb.x + pad + size / 2;
  const openRight = ballCX < wa.x + wa.width / 2;

  let cardX = openRight ? bb.x + pad + size + PANEL_GAP : bb.x + pad - PANEL_GAP - cardW;
  let cardY = bb.y + pad + size / 2 - cardH / 2;

  cardX = clamp(cardX, wa.x + 6, wa.x + wa.width - cardW - 6);
  cardY = clamp(cardY, wa.y + 6, wa.y + wa.height - cardH - 6);

  panelWin.setBounds({
    x: Math.round(cardX - PANEL_PAD),
    y: Math.round(cardY - PANEL_PAD),
    width: winW,
    height: winH
  });
}

/**
 * 把面板抢到前台。
 *
 * 球窗口是 focusable:false（点它不抢你正在打字的焦点），副作用是 Windows
 * 不会把我们的进程当「前台进程」，于是 panel.focus() 请求可能被系统驳回：
 * 面板弹出来拿到一瞬间焦点，1~2 秒后前台又被还给原来的窗口 → 面板 blur →
 * 被收起。表现就是「点了球，面板闪一下没了 / 怎么点都点不开」。
 * app.focus({steal:true}) 是 Electron 给 Windows 提供的强制前台接口。
 */
function stealPanelFocus() {
  if (!panelWin || panelWin.isDestroyed()) return false;
  try {
    app.focus({ steal: true });
  } catch (_) {
    /* 非 Windows 平台没有这个参数，忽略 */
  }
  try {
    if (!panelWin.isVisible()) panelWin.show();
    panelWin.moveTop();
    panelWin.focus();
  } catch (_) {
    /* ignore */
  }
  try {
    return panelWin.isFocused();
  } catch (_) {
    return false;
  }
}

/**
 * 「挡板」：面板打开时在屏幕上铺一层全屏透明窗口，专门接住「点面板外面」这一下。
 *
 * 为什么需要它：原来判断「用户点了别处」只能靠窗口失焦事件，但这台机器上面板
 * 弹出来经常抢不到焦点，没有焦点就永远不会失焦 —— 于是「点外面关不掉」。
 * 挡板不依赖焦点，层级压在面板和悬浮球下面（pop-up-menu < screen-saver），
 * 所以在面板/球上的点击照常生效，其它任何位置的点击都会被它接到 → 收起面板。
 */
function createBackdropWindow() {
  if (backdropWin && !backdropWin.isDestroyed()) return backdropWin;

  backdropWin = new BrowserWindow({
    width: 100,
    height: 100,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/backdrop.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  backdropWin.setAlwaysOnTop(true, 'pop-up-menu');
  backdropWin.loadURL('about:blank').catch(() => {});

  backdropWin.on('closed', () => {
    backdropWin = null;
  });

  return backdropWin;
}

function showBackdrop() {
  const win = createBackdropWindow();
  if (!win || win.isDestroyed()) return;
  try {
    const display = ballWin && !ballWin.isDestroyed()
      ? screen.getDisplayMatching(ballWin.getBounds())
      : screen.getPrimaryDisplay();
    const b = display.bounds;
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    win.showInactive();
    logToFile(
      `[backdrop] shown ${b.width}x${b.height} at ${b.x},${b.y} visible=${win.isVisible()}`
    );
    // 挡板是后显示的，把球和面板重新提到最上面：
    // 球要能点（点球=收起），面板要能点（不能被子挡板吃掉）
    if (ballWin && !ballWin.isDestroyed()) ballWin.moveTop();
    if (panelWin && !panelWin.isDestroyed()) panelWin.moveTop();
  } catch (err) {
    logToFile('[backdrop] show failed ' + ((err && err.message) || err));
  }
}

function hideBackdrop() {
  if (!backdropWin || backdropWin.isDestroyed()) return;
  try {
    // 用销毁而不是 hide：透明全屏窗口 hide 之后，这台机器上悬浮球会
    // 变成「看得见但点不动」（点击穿透），销毁重建最干净。
    backdropWin.destroy();
    backdropWin = null;
    logToFile('[backdrop] destroyed');
  } catch (err) {
    logToFile('[backdrop] destroy failed ' + ((err && err.message) || err));
  }
}

function showPanel() {
  if (!panelWin || panelWin.isDestroyed()) createPanelWindow();

  const finish = () => {
    if (!panelWin || panelWin.isDestroyed()) return;
    positionPanel();
    panelWin.show();
    panelShownAt = Date.now();
    const got = stealPanelFocus();
    // 挡板负责接住「点面板外面」，这是唯一可靠的关闭路径
    showBackdrop();
    panelWin.webContents.send('panel:shown');
    logToFile(`panel shown (focused=${got})`);
  };

  if (panelWin.webContents.isLoading()) {
    panelWin.webContents.once('did-finish-load', () => {
      pushStateTo(panelWin);
      finish();
    });
  } else {
    finish();
  }
}

function hidePanel(reason = '') {
  hideBackdrop();
  if (!panelWin || panelWin.isDestroyed()) return;
  if (!panelWin.isVisible()) return;
  panelWin.hide();
  // 让下一轮轮询立刻重新判定一次球的输入状态
  lastHover = null;
  lastAssertAt = 0;
  logToFile(`panel hidden${reason ? ' (' + reason + ')' : ''}`);
}

function togglePanel() {
  if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) {
    hidePanel();
    return;
  }
  // 刚因为「点了球」而失焦收起 → 不要立刻又弹开
  if (Date.now() - panelHiddenByBlurAt < 320) return;
  showPanel();
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function trayIcon() {
  const p = path.join(__dirname, '../../assets/tray.png');
  const img = nativeImage.createFromPath(p);
  if (!img.isEmpty()) return img;
  return nativeImage.createEmpty();
}

function updateTrayMenu() {
  if (!tray) return;

  const login = app.getLoginItemSettings();
  const template = [
    {
      label: '打开待办',
      accelerator: 'CmdOrCtrl+Shift+T',
      click: () => showPanel()
    },
    {
      label: ballVisible ? '隐藏悬浮球' : '显示悬浮球',
      click: () => toggleBallVisibility()
    },
    {
      // 兜底：万一球又点不动了，不用重启程序，点这里重建一次窗口
      label: '重置悬浮球（点不动时用）',
      click: () => {
        logToFile('[ball] manual reset from tray');
        rebuildBallWindow();
      }
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!(login && login.openAtLogin),
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: [] });
        store.saveSettings({ autoLaunch: item.checked });
        updateTrayMenu();
      }
    },
    {
      label: '打开数据目录',
      click: () => shell.openPath(DATA_DIR)
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip('悬浮待办');
}

function createTray() {
  tray = new Tray(trayIcon());
  updateTrayMenu();
  tray.on('click', () => toggleBallVisibility());
  tray.on('right-click', () => tray.popUpContextMenu());
}

// ---------------------------------------------------------------------------
// 状态广播
// ---------------------------------------------------------------------------
/**
 * 推给界面的待办（球上的数字、面板的列表都看这一份）。
 *
 * 「每天/每周」这类重复任务，打完勾会顺手生成下一次的副本，
 * 于是今天的清单里会永远躺着「明天」「后天」那两条，很吵。
 * 这里把「还没到那一天的重复任务下一次」先藏起来 —— 到那天它自己就出现了。
 */
function visibleTodos() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();

  return store.state.todos.filter((t) => {
    if (!t || t.done || !t.repeat || !t.dueAt) return true;
    const ts = Date.parse(t.dueAt);
    if (!Number.isFinite(ts)) return true;
    return ts < nextMidnight;
  });
}

function snapshot() {
  let autoLaunch = false;
  try {
    autoLaunch = !!app.getLoginItemSettings().openAtLogin;
  } catch (_) {
    /* ignore */
  }
  return {
    todos: visibleTodos(),
    settings: store.state.settings,
    autoLaunch,
    ingest: ingest ? ingest.info() : null,
    chaoxing: { ...cxState },
    recovered: store.recoveredFromBackup,
    corruptFile: store.corruptFile,
    dataDir: DATA_DIR
  };
}

/** 按当前设置重新拉起本机接入服务（端口被占用会自动往后试） */
async function restartIngest() {
  if (!ingest) return;
  ingest.stop();

  const s = store.state.settings;
  if (!s.ingestEnabled) {
    logToFile('[ingest] disabled by settings');
    broadcastState();
    return;
  }
  if (!s.ingestToken) {
    logToFile('[ingest] no token, skip start');
    broadcastState();
    return;
  }

  const res = await ingest.start({ port: s.ingestPort, token: s.ingestToken });
  if (!res.ok) {
    logToFile('[ingest] start failed: ' + res.error);
  } else if (res.port !== s.ingestPort) {
    logToFile(`[ingest] port ${s.ingestPort} busy, using ${res.port}`);
    store.saveSettings({ ingestPort: res.port });
  }
  broadcastState();
}

// ---------------------------------------------------------------------------
// 学习通：窗口管理
// ---------------------------------------------------------------------------
/**
 * 给学习通窗口加防护。
 *
 * 学习通页面里带「打开 App」之类的链接/脚本，会跳 jsbridge:// 这种自定义协议。
 * 隐藏窗口一加载这些页面，Electron 就把它交给 Windows → 弹「需要使用新应用以打开
 * 此 jsbridge 链接」。自动同步每 30 分钟跑一次，所以会不定时地弹。
 *
 * 这里把非 http(s) 的跳转、非 http(s) 的 window.open、外链点击挡掉。
 * 注意：http(s)/about:blank 的 window.open 必须放行，否则学校 SSO 的
 * 「选单位 → 统一认证」和表单 target=_blank 提交会“点了没反应”。
 */
/**
 * 把学习通会话里的「会话级 cookie」改写成带有效期的持久 cookie。
 *
 * 为什么要这么做：
 * Electron（Chromium）只把**有到期时间**的 cookie 写进磁盘，没有到期时间的
 * 只存在内存里，程序一退出就清空。学习通登录后发的 _uid / UID / uf / vc3 /
 * p_auth_token / retainlogin 全是会话级，所以「关掉程序 = 掉登录」。
 *
 * 这里把它们的过期时间补上（默认 7 天），相当于替用户勾了「7天内自动登录」。
 */
async function persistCxCookies(days = 7, tag = '') {
  try {
    const ses = session.fromPartition(CX_PARTITION);
    const list = await ses.cookies.get({});
    const exp = Math.floor(Date.now() / 1000) + days * 86400;
    let converted = 0;
    let failed = 0;

    for (const c of list) {
      if (c.expirationDate) continue; // 已经有有效期的不用动
      try {
        const host = String(c.domain || '').replace(/^\./, '');
        if (!host) continue;
        await ses.cookies.set({
          url: (c.secure ? 'https://' : 'http://') + host + (c.path || '/'),
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          expirationDate: exp
        });
        converted += 1;
      } catch (_) {
        failed += 1;
      }
    }

    await ses.cookies.flushStore();
    if (converted || failed) {
      logToFile(`[cookies] ${tag} 会话级 cookie 转持久: 成功 ${converted}，失败 ${failed}，有效期 ${days} 天`);
    }
  } catch (err) {
    logToFile('[cookies] persist 失败 ' + ((err && err.message) || err));
  }
}

/**
 * 调试：导出学习通会话里的 cookie 及有效期。
 * 用来判断「为什么登录这么快过期」「那个 7 天自动登录有没有生效」。
 * 只有设了环境变量 FLOATING_TODO_DUMP_COOKIES=1 才执行。
 */
async function dumpCxCookies(tag) {
  if (!process.env.FLOATING_TODO_DUMP_COOKIES) return;
  try {
    const ses = session.fromPartition(CX_PARTITION);
    const list = await ses.cookies.get({});
    const nowSec = Date.now() / 1000;
    logToFile(`[cookies:${tag}] 共 ${list.length} 个`);
    for (const c of list) {
      const exp = c.expirationDate ? (c.expirationDate - nowSec) / 86400 : null;
      let expText = exp === null ? '会话级(关闭即失效)' : `${exp.toFixed(2)} 天后过期`;

      // p_auth_token 这类是 JWT，真正的过期时间在 payload 里，比 cookie 的有效期更可信
      const val = String(c.value || '');
      if (val.split('.').length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(val.split('.')[1], 'base64').toString('utf8'));
          if (payload && payload.exp) {
            const left = (payload.exp - nowSec) / 86400;
            expText += `  [JWT 内部过期: ${left.toFixed(2)} 天后]`;
          }
        } catch (_) {
          /* ignore */
        }
      }

      logToFile(`  ${c.domain}  ${c.name}  ${expText}`);
    }
  } catch (err) {
    logToFile('[cookies] 导出失败 ' + ((err && err.message) || err));
  }
}

function hardenLearningWindow(win) {
  if (!win || win.isDestroyed()) return;

  const isAllowed = (url) => /^(https?|file|about|data|blob|chrome-extension):/i.test(String(url || ''));

  const block = (event, url, label) => {
    if (isAllowed(url)) return;
    try {
      event.preventDefault();
    } catch (_) {
      /* ignore */
    }
    logToFile(`[chaoxing] blocked ${label}: ${String(url).slice(0, 100)}`);
  };

  win.webContents.on('will-navigate', (event, url) => block(event, url, 'navigate'));
  win.webContents.on('will-redirect', (event, url) => block(event, url, 'redirect'));

  // 能拦住 iframe 内部的跳转（学习通任务列表就在跨域 iframe 里）
  try {
    win.webContents.on('will-frame-navigate', (event) => block(event, event.url, 'frame-navigate'));
  } catch (_) {
    /* 旧版本 Electron 没有这个事件 */
  }

  // 弹窗不再一律拒绝：学校的「选单位 → 统一认证」靠 window.open 弹窗，
  // 全拦了就会出现“点登录没反应”。http(s) / about:blank 放行成真窗口，
  // 只拦 jsbridge:// intent:// 这类会弹系统对话框的 scheme。
  win.webContents.setWindowOpenHandler(({ url }) => {
    const u = String(url || '');
    if (!u || /^(https?:|about:blank)/i.test(u)) {
      logToFile('[chaoxing] allow window.open: ' + (u || '(blank)'));
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1020,
          height: 780,
          autoHideMenuBar: true,
          webPreferences: {
            partition: CX_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
            userAgent: CX_UA
          }
        }
      };
    }
    logToFile('[chaoxing] blocked window.open: ' + u.slice(0, 100));
    return { action: 'deny' };
  });

  // 弹出来的子窗口也加上同样的保护（jsbridge 之类）
  win.webContents.on('did-create-window', (child) => {
    if (child && !child.isDestroyed()) hardenLearningWindow(child);
  });

  // 再补一层：页面脚本直接 location.href = 'jsbridge://...' 也拦掉。
  // 注意不要覆盖 window.open —— 学校登录页靠它跳转统一认证。
  win.webContents.on('dom-ready', () => {
    win.webContents
      .executeJavaScript(
        `(function () {
          if (window.__FT_CLICK_GUARD__) return;
          window.__FT_CLICK_GUARD__ = true;
          document.addEventListener('click', function (e) {
            var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
            if (!a) return;
            var href = (a.getAttribute('href') || '').trim();
            // 只拦明确带危险 scheme 的链接，空链接/相对路径/JS 一律放过
            if (!/^(jsbridge|intent|market|tel|sms|weixin|alipays?):/i.test(href)) return;
            e.preventDefault();
            e.stopPropagation();
          }, true);
        })();`,
        true
      )
      .catch(() => {});
  });
}

function cxGetWindow(kind) {
  const isLogin = kind === 'login';
  let win = isLogin ? cxLoginWin : cxFetchWin;
  if (win && !win.isDestroyed()) return win;

  win = new BrowserWindow({
    width: isLogin ? 1020 : 900,
    height: isLogin ? 780 : 700,
    show: false,
    title: isLogin ? '学习通 · 登录（登录好会自动关闭）' : '学习通',
    autoHideMenuBar: true,
    skipTaskbar: !isLogin,
    webPreferences: {
      partition: CX_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      userAgent: CX_UA
    }
  });

  if (isLogin) {
    cxLoginWin = win;
    win.on('closed', () => {
      cxLoginWin = null;
      stopCxLoginPoll();
    });
  } else {
    cxFetchWin = win;
    win.on('closed', () => {
      cxFetchWin = null;
    });
  }

  hardenLearningWindow(win);
  return win;
}

/** 要抓取的页面列表：作业总表 + 用户自己加的额外页面（可带 #course=课程名） */
function cxSources() {
  const extra = Array.isArray(store.state.settings.cxExtraUrls) ? store.state.settings.cxExtraUrls : [];
  const raw = [CX_WORK_URL].concat(extra);
  const list = [];
  const seen = new Set();

  for (const entry of raw) {
    let s = String(entry == null ? '' : entry).trim();
    if (!s) continue;

    // 支持 "url#course=大学英语III"：课程级页面本身不带课程名，靠这个补上
    let course = '';
    const at = s.indexOf('#course=');
    if (at >= 0) {
      course = decodeURIComponent(s.slice(at + 8));
      s = s.slice(0, at);
    }

    if (!/^https?:\/\//i.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    list.push({ url: s, course });
  }

  return list;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 在页面里执行一段 JS，带超时（页面卡住时不会把流程挂死） */
function execJs(win, code, timeoutMs = 8000) {
  const p = win.webContents.executeJavaScript(code, true).catch((err) => {
    logToFile('[chaoxing] execJs error ' + ((err && err.message) || err));
    return null;
  });
  return Promise.race([p, sleep(timeoutMs).then(() => null)]);
}

/**
 * 打开页面并等它就绪。
 *
 * 不能直接 await win.loadURL()：学习通有些页面带长连接/iframe，
 * did-finish-load 永远不触发，会把整个同步（或 dump）永久挂住。
 * 这里以 dom-ready 或超时为准，谁先到算谁。
 */
function loadPage(win, url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(why);
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    win.webContents.once('dom-ready', () => finish('dom-ready'));
    win.loadURL(url).then(
      () => finish('loaded'),
      (err) => finish('error:' + ((err && err.message) || err))
    );
  });
}

/**
 * 打开一个页面并采集。
 * 有些页面是前端渲染的，loadURL 回来时列表可能还没出来，
 * 所以空结果时再等一会儿重试两次，避免「偶发抓到 0 条」。
 */
/**
 * 在所有 frame 里跑采集器。
 *
 * 学习通的课程「任务」页把任务列表放在一个跨域 iframe 里
 * （mobilelearn.s.ecust.edu.cn/page/active/stuActiveList?...），
 * 只在顶层文档里查 DOM 永远是 0 条。Electron 的 WebFrameMain 可以
 * 跨域执行脚本，所以逐个 frame 跑一遍再合并。
 */
async function collectFromAllFrames(win, fallbackCourse) {
  let frames = [];
  try {
    frames = win.webContents.mainFrame.framesInSubtree || [];
  } catch (_) {
    frames = [];
  }
  if (!frames.length) {
    try {
      frames = [win.webContents.mainFrame];
    } catch (_) {
      return [];
    }
  }

  const merged = [];
  for (const frame of frames) {
    try {
      // 调试：把每个 frame 的 HTML 都存一份
      if (process.env.FLOATING_TODO_SAVE_ALL) {
        try {
          const fh = await Promise.race([
            frame.executeJavaScript('document.documentElement.outerHTML', true),
            sleep(8000).then(() => null)
          ]);
          if (typeof fh === 'string' && fh.length > 100) {
            const out = path.join(DATA_DIR, `frame-${Date.now()}-${merged.length}.html`);
            fs.writeFileSync(out, fh, 'utf8');
            logToFile(`[dump] frame saved ${out} len=${fh.length} url=${String(frame.url).slice(0, 80)}`);
          }
        } catch (_) {
          /* ignore */
        }
      }

      // 课程级页面本身不带课程名，先把兜底课程名塞进去
      if (fallbackCourse) {
        await Promise.race([
          frame.executeJavaScript(
            'window.__FT_FALLBACK_COURSE__ = ' + JSON.stringify(fallbackCourse) + '; 1',
            true
          ),
          sleep(3000).then(() => null)
        ]);
      }

      const raw = await Promise.race([
        frame.executeJavaScript(CX_COLLECT_SOURCE, true),
        sleep(8000).then(() => null)
      ]);
      if (Array.isArray(raw) && raw.length) {
        logToFile(`[chaoxing] frame ${String(frame.url).slice(0, 80)} -> ${raw.length} 条`);
        merged.push(...raw);
      }
    } catch (err) {
      // 有些 frame 可能是空的/已销毁，忽略
    }
  }
  return merged;
}

async function collectFromPage(win, url, fallbackCourse) {
  const how = await loadPage(win, url);
  logToFile(`[chaoxing] load ${how} ${url.slice(0, 90)}`);

  let sawLogin = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1500);

    const info = await execJs(
      win,
      '({url: location.href, text: (document.body ? document.body.innerText : "").slice(0, 1500)})'
    );
    if (!info) continue;

    const isLogin =
      /passport|login|sso/i.test(info.url) ||
      /扫码登录|账号登录|手机号登录|验证码登录|请先登录|重新登录|统一身份认证|校园统一身份/.test(info.text);
    if (isLogin) {
      sawLogin = true;
      return { needLogin: true, items: [], url: info.url };
    }

    // 顶层 + 所有 iframe
    const all = await collectFromAllFrames(win, fallbackCourse);
    const map = new Map();
    for (const it of all) {
      if (it && it.sourceKey && !map.has(it.sourceKey)) map.set(it.sourceKey, it);
    }
    const items = Array.from(map.values());

    // 调试：把每个来源页面的 HTML 都存一份，方便对着真实结构核对采集结果
    if (process.env.FLOATING_TODO_SAVE_ALL) {
      try {
        const html = await execJs(win, 'document.documentElement.outerHTML', 12000);
        if (typeof html === 'string' && html.length > 0) {
          const out = path.join(DATA_DIR, `page-${Date.now()}.html`);
          fs.writeFileSync(out, html, 'utf8');
          logToFile(`[dump] page saved ${out} len=${html.length} items=${items.length} url=${url.slice(0, 70)}`);
        }
      } catch (_) {
        /* ignore */
      }
    }

    if (items.length > 0) return { needLogin: false, items, url: info.url };
  }

  // 调试：抓不到东西时把页面存下来，方便对着真实结构调规则（用同步窗口，它渲染得出来）
  if (process.env.FLOATING_TODO_SAVE_EMPTY) {
    try {
      const html = await execJs(win, 'document.documentElement.outerHTML', 12000);
      if (typeof html === 'string' && html.length > 0) {
        const out = path.join(DATA_DIR, `empty-${Date.now()}.html`);
        fs.writeFileSync(out, html, 'utf8');
        logToFile(`[dump] empty page saved ${out} len=${html.length}`);
      } else {
        logToFile('[dump] empty page: execJs returned nothing');
      }
    } catch (err) {
      logToFile('[dump] empty page save failed ' + ((err && err.message) || err));
    }
  }

  return { needLogin: sawLogin, items: [], url: '' };
}

/**
 * 随堂练习（activetype=42）在学习通任务列表里**永远不会**变成「已完成」。
 *
 * 列表里它一直显示「剩余:3天」+「进行中」，学生交没交完全看不出来；
 * 只有点进答题页那一页才写着「已提交，待教师公布正确答案 / 我的答案：…」。
 * 所以对这类还没打勾的条目，单独打开它的答题页看一眼，看到提交痕迹就认定完成。
 */
async function cxCheckQuizSubmitted(win, item, sourceUrl) {
  const activeId = item && item.activeId;
  if (!activeId || !win || win.isDestroyed()) return false;

  let u;
  try {
    u = new URL(String(sourceUrl || item.url || ''));
  } catch (_) {
    return false;
  }

  const courseId = u.searchParams.get('courseid') || u.searchParams.get('courseId') || '';
  const classId = u.searchParams.get('clazzid') || u.searchParams.get('classId') || '';
  const fid = u.searchParams.get('fid') || '';

  const target =
    `${u.origin}/page/quiz/stu/quizStudentQuestion?activeId=${encodeURIComponent(activeId)}` +
    `&classId=${encodeURIComponent(classId)}&fid=${encodeURIComponent(fid)}` +
    `&courseId=${encodeURIComponent(courseId)}&returnType=0&viewType=2&timetable=0`;

  try {
    await loadPage(win, target, 20000);
    for (let i = 0; i < 7; i++) {
      if (i > 0) await sleep(1200);
      const text = await execJs(
        win,
        '(document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 4000)',
        8000
      );
      // 答题页是前端渲染的，内容还没出来就再等等
      if (!text || text.length < 80) continue;
      if (/已提交|我的答案|已作答|已交\s*[:：]/.test(text)) {
        logToFile(`[chaoxing] quiz submitted: ${activeId} ${String(item.title).slice(0, 40)}`);
        return true;
      }
      if (/未提交|尚未提交/.test(text)) {
        logToFile(`[chaoxing] quiz NOT submitted: ${activeId}`);
        return false;
      }
    }
  } catch (err) {
    logToFile('[chaoxing] quiz check failed ' + ((err && err.message) || err));
  }
  return false;
}

/** 把「进行中的随堂练习」逐个去答题页确认，已提交的补打勾 */
async function cxVerifyPendingQuizzes(win, items) {
  const pending = (items || []).filter(
    (it) => it && !it.done && it.activeId && String(it.activeType) === '42'
  );
  if (!pending.length) return;

  // 已经打过勾的别再打开页面了
  const doneKeys = new Set(
    (store.state.todos || []).filter((t) => t.done && t.sourceKey).map((t) => t.sourceKey)
  );

  let n = 0;
  for (const it of pending) {
    if (doneKeys.has(it.sourceKey)) continue;
    if (n >= 6) break; // 别一次开太多页面，拖慢同步
    n += 1;
    if (await cxCheckQuizSubmitted(win, it, it.url)) it.done = true;
  }
}

/** 依次打开每个来源页面采集，合并去重 */
async function cxFetchAll() {
  const win = cxGetWindow('fetch');
  const urls = cxSources();
  const merged = new Map();
  const perSource = [];
  const loginSources = [];
  let okHits = 0;

  logToFile(`[chaoxing] sources(${urls.length}): ${urls.map((s) => s.url).join(' | ')}`);

  for (const source of urls) {
    const { url, course } = source;
    try {
      const res = await collectFromPage(win, url, course);

      if (res.needLogin) {
        // 单个来源要登录不代表全军覆没（不同域名的会话是分开的），
        // 但必须记下来告诉用户，否则会像「作业提交了还显示」这样静默出错。
        loginSources.push(url);
        logToFile(`[chaoxing] source needs login: ${url} -> ${res.url}`);
        continue;
      }

      okHits += 1;
      perSource.push({ url, count: res.items.length });
      for (const it of res.items) {
        if (it && it.sourceKey && !merged.has(it.sourceKey)) merged.set(it.sourceKey, it);
      }

      logToFile(`[chaoxing] source ${url} -> ${res.items.length} 条`);
    } catch (err) {
      logToFile(`[chaoxing] source failed ${url}: ${(err && err.message) || err}`);
    }
  }

  // 随堂练习交没交在列表里看不出来，单独去答题页确认（只查没打勾的那几个）
  await cxVerifyPendingQuizzes(win, Array.from(merged.values()));

  const needLogin = urls.length > 0 && okHits === 0 && loginSources.length > 0;
  return { needLogin, items: Array.from(merged.values()), perSource, loginSources };
}

/** 拉一次并写入待办 */
async function cxSync(reason) {
  if (cxBusy) return { ok: false, busy: true };
  if (!store.state.settings.cxEnabled) {
    cxState.status = 'disabled';
    return { ok: false, disabled: true };
  }

  cxBusy = true;
  cxState.status = 'syncing';
  cxState.lastAttemptAt = new Date().toISOString();
  broadcastState();

  try {
    const res = await cxFetchAll();

    if (res.needLogin) {
      cxState.status = 'need-login';
      cxState.loggedIn = false;
      cxState.message = '需要登录学习通';
      logToFile(`[chaoxing] need login (${reason})`);
      broadcastState();
      return { ok: false, needLogin: true };
    }

    cxState.loggedIn = true;
    cxState.partialLogin = (res.loginSources || []).length;
    const result = store.upsertImported(res.items, 'chaoxing');
    store.saveNow();

    cxState.status = 'ok';
    cxState.message = '';
    cxState.lastAt = new Date().toISOString();
    cxState.lastResult = {
      created: result.created,
      updated: result.updated,
      completed: result.completed,
      skipped: result.skipped
    };

    logToFile(
      `[chaoxing] sync ok (${reason}) items=${res.items.length} created=${result.created} updated=${result.updated} completed=${result.completed} skipped=${result.skipped}`
    );
    // 每次同步成功都顺手把会话级 cookie 续成持久的，避免下次重启掉登录
    await persistCxCookies(7, 'sync');
    broadcastState();
    return { ok: true, ...cxState.lastResult };
  } catch (err) {
    cxState.status = 'error';
    cxState.message = String((err && err.message) || err).slice(0, 200);
    logToFile('[chaoxing] sync error ' + cxState.message);
    broadcastState();
    return { ok: false, error: cxState.message };
  } finally {
    cxBusy = false;
  }
}

// ---------------------------------------------------------------------------
// 学习通：登录
// ---------------------------------------------------------------------------
function stopCxLoginPoll() {
  if (cxLoginPoll) clearInterval(cxLoginPoll);
  cxLoginPoll = null;
}

/** 判断「某个作业页」当前是否已登录（会实际打开它，看是否被踢到登录页） */
async function cxIsUrlLoggedIn(url) {
  try {
    const win = cxGetWindow('fetch');
    await loadPage(win, url, 12000);
    const info = await execJs(
      win,
      '({url: location.href, text: (document.body ? document.body.innerText : "").slice(0, 800)})'
    );
    if (!info) return false;
    const isLogin =
      /passport|login|sso|cas\//i.test(info.url) ||
      /扫码登录|账号登录|手机号登录|请先登录|重新登录|统一身份认证|校园统一身份/.test(info.text);
    return !isLogin;
  } catch (_) {
    return false;
  }
}

/**
 * 把用户填的地址收敛成「学校实例的作业总表」。
 * 用户可能贴的是首页、课程页、任务列表页，统一取 host + /work/stu-work。
 */
function cxNormalizeSchoolUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return '';
  }
  if (!u.hostname || !u.hostname.includes('.')) return '';
  return `${u.protocol}//${u.host}${CX_SCHOOL_WORK_PATH}`;
}

/**
 * 猜学校实例地址：从用户已经填过的额外页面 / 现有 cookie 域名里找线索。
 *
 * 学校自建学习通的域名通常是 `mooc1.<学校域>`、`mobilelearn.<学校域>`、
 * `passport.<学校域>` 这种结构。把一级子域名剥掉、换成 mooc1 即可复原，
 * 例如 mobilelearn.s.ecust.edu.cn → mooc1.s.ecust.edu.cn。
 * 猜不出来就返回空，界面上让用户自己贴一个。
 */
async function cxSuggestSchoolUrl() {
  const hosts = new Set();

  for (const src of cxSources()) {
    try {
      const h = new URL(src.url).hostname.toLowerCase();
      if (h) hosts.add(h);
    } catch (_) {
      /* ignore */
    }
  }

  try {
    const cookies = await session.fromPartition(CX_PARTITION).cookies.get({});
    for (const c of cookies) {
      const h = String(c.domain || '').replace(/^\./, '').toLowerCase();
      if (h) hosts.add(h);
    }
  } catch (_) {
    /* cookie 读不到就算了 */
  }

  const bases = new Set();
  for (const h of hosts) {
    // 通用域名不算「学校实例」
    if (/(^|\.)chaoxing\.com$/.test(h) || /(^|\.)chaoxing\.cn$/.test(h)) continue;
    if (h.startsWith('mooc1.')) {
      bases.add(h.slice('mooc1.'.length));
    } else {
      const rest = h.split('.').slice(1).join('.');
      if (rest.split('.').length >= 2) bases.add(rest);
    }
  }

  const candidates = [];
  for (const b of bases) candidates.push(`https://mooc1.${b}${CX_SCHOOL_WORK_PATH}`);

  return candidates[0] || '';
}

/** 学校入口地址：用户填的优先，其次自动识别；都没有就返回空（= 不启用） */
async function cxResolveSchoolUrl() {
  const explicit = cxNormalizeSchoolUrl(store.state.settings.cxSchoolUrl);
  if (explicit) return explicit;
  return cxSuggestSchoolUrl();
}

/** 把「学校入口地址」算好放进 cxState，界面直接读，不用每次问 */
async function refreshSchoolUrl() {
  try {
    const suggested = await cxSuggestSchoolUrl();
    cxState.schoolSuggested = suggested;
    cxState.schoolUrl = cxNormalizeSchoolUrl(store.state.settings.cxSchoolUrl) || suggested;
  } catch (_) {
    cxState.schoolUrl = '';
  }
  broadcastState();
}

/**
 * 打开登录窗口。
 *
 * 学习通有两套互相独立的登录：
 *   1. 通用域名 chaoxing.com → passport2.chaoxing.com（扫码 / 账号密码）
 *   2. 学校自建实例 → 各校自己的统一认证（域名因校而异）
 * 登录其中一套不会带上另一套，所以要分别登录。
 *
 * target: 'generic' | 'school'
 */
async function cxOpenLogin(target = 'generic') {
  const isSchool = target === 'school';

  let url;
  let checkUrl;
  if (isSchool) {
    const school = await cxResolveSchoolUrl();
    if (!school) {
      // 没配学校地址：不让它去撞一个写死的错域名
      logToFile('[chaoxing] school login skipped: no school url');
      return { ok: false, needUrl: true, suggested: await cxSuggestSchoolUrl() };
    }
    url = school;
    checkUrl = school;
  } else {
    url = store.state.settings.cxLoginUrl || 'https://passport2.chaoxing.com/login';
    checkUrl = CX_WORK_URL;
  }

  // 两套会话各自判断「是不是已经登进去了」，避免刚开窗就被误判成功
  const already = await cxIsUrlLoggedIn(checkUrl);
  if (already) {
    logToFile(`[chaoxing] login skipped, already signed in: ${target}`);
    await persistCxCookies(7, 'pre-login');
    await cxSync('pre-login');
    return { ok: true, already: true };
  }

  const win = cxGetWindow('login');

  try {
    await loadPage(win, url, 15000);
  } catch (err) {
    logToFile('[chaoxing] login window load failed: ' + (err && err.message));
  }

  win.show();
  win.focus();
  logToFile(`[chaoxing] login window opened (${target}): ${url}`);

  stopCxLoginPoll();
  let pollTick = 0;
  cxLoginPoll = setInterval(async () => {
    if (!cxLoginWin || cxLoginWin.isDestroyed()) {
      stopCxLoginPoll();
      return;
    }
    // 每 15 秒记一次当前地址，下次“点了没反应”时能直接看出卡在哪一步
    pollTick += 1;
    if (pollTick % 3 === 1) {
      try {
        logToFile('[chaoxing] login window url: ' + String(cxLoginWin.webContents.getURL()).slice(0, 160));
      } catch (_) {
        /* ignore */
      }
    }
    const ok = await cxIsUrlLoggedIn(checkUrl);
    if (ok) {
      stopCxLoginPoll();
      logToFile(`[chaoxing] login detected (${target}), closing login window`);
      if (cxLoginWin && !cxLoginWin.isDestroyed()) cxLoginWin.close();
      // 关键：把会话级 cookie 写成持久的，否则程序一重启就掉登录
      await persistCxCookies(7, 'after-login');
      await dumpCxCookies('after-login');
      await cxSync('after-login');
    }
  }, 5000);

  return { ok: true };
}

async function cxLogout() {
  try {
    await session.fromPartition(CX_PARTITION).clearStorageData();
  } catch (err) {
    logToFile('[chaoxing] logout error ' + (err && err.message));
  }
  cxState.loggedIn = false;
  cxState.status = 'need-login';
  cxState.lastAt = null;
  cxState.lastResult = null;
  cxLoginLoadedOnce = false;
  broadcastState();
  return { ok: true };
}

function cxStartSchedule() {
  if (cxTimer) clearInterval(cxTimer);
  cxTimer = null;
  if (!store.state.settings.cxEnabled) return;

  const min = Math.max(5, Number(store.state.settings.cxIntervalMin) || 30);
  cxTimer = setInterval(() => cxSync('timer'), min * 60 * 1000);
  logToFile(`[chaoxing] schedule every ${min} min`);
}

function cxStopAll() {
  if (cxTimer) clearInterval(cxTimer);
  cxTimer = null;
  stopCxLoginPoll();
  try {
    if (cxFetchWin && !cxFetchWin.isDestroyed()) cxFetchWin.destroy();
  } catch (_) {
    /* ignore */
  }
  try {
    if (cxLoginWin && !cxLoginWin.isDestroyed()) cxLoginWin.destroy();
  } catch (_) {
    /* ignore */
  }
  cxFetchWin = null;
  cxLoginWin = null;
}

function pushStateTo(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('state:update', snapshot());
  } catch (_) {
    /* 窗口可能正在销毁 */
  }
}

function broadcastState() {
  pushStateTo(ballWin);
  pushStateTo(panelWin);
}

// ---------------------------------------------------------------------------
// 提醒 / 全局快捷键
// ---------------------------------------------------------------------------
function pushBallAlert(payload) {
  if (!ballWin || ballWin.isDestroyed()) return;
  try {
    ballWin.webContents.send('reminder:fire', payload || {});
  } catch (_) {
    /* 窗口可能正在销毁 */
  }
}

function registerGlobalHotkey() {
  try {
    globalShortcut.unregisterAll();
  } catch (_) {
    /* ignore */
  }
  const accel = (store && store.state.settings.hotkey) || 'Control+Shift+T';
  try {
    const ok = globalShortcut.register(accel, () => showPanel());
    lastHotkeyOk = !!ok;
    logToFile(`[hotkey] register ${accel} -> ${ok}`);
    if (!ok) logToFile('[hotkey] 注册失败，可能已被其他程序占用');
  } catch (err) {
    lastHotkeyOk = false;
    logToFile('[hotkey] register error ' + (err && err.message));
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('state:get', () => snapshot());

  // ---- 球 ----
  // 兼容旧接口：命中判定已改由主进程轮询（见 startHoverPoll）
  ipcMain.on('ball:interactive', (_e, isOver) => {
    if (!ballWin || ballWin.isDestroyed()) return;
    if (dragActive) return;
    setBallHover(!!isOver);
  });

  ipcMain.on('ball:drag', (_e, payload = {}) => {
    if (!ballWin || ballWin.isDestroyed()) return;
    if (payload.phase === 'start') {
      dragOffset = { x: Number(payload.dx) || 0, y: Number(payload.dy) || 0 };
      dragOrigin = ballWin.getPosition();
      dragActive = true;
      startDrag();
      logToFile(`[ball] drag start at ${dragOrigin.join(',')} bounds=${JSON.stringify(ballWin.getBounds())}`);
    } else if (payload.phase === 'end') {
      stopDrag();
      dragActive = false;
      // 靠边吸附：吸过去了它会自己落盘
      const snapped = snapBallToEdge();
      if (!snapped) persistBallPosition();
      lastHover = null; // 下一轮轮询重新判定
      logToFile(`[ball] drag end${snapped ? ' (snapped)' : ''}`);
    } else if (payload.phase === 'cancel') {
      // 手抖被误判成拖动 → 把窗口挪回原位，不落盘
      stopDrag();
      dragActive = false;
      if (dragOrigin) ballWin.setPosition(dragOrigin[0], dragOrigin[1]);
      lastHover = null;
      logToFile('[ball] drag cancel (treated as click)');
    }
  });

  ipcMain.on('ball:click', () => {
    logToFile('[ball] click received');
    togglePanel();
  });

  ipcMain.on('ball:menu', () => {
    const template = [
      { label: '新建待办', click: () => showPanel() },
      { type: 'separator' },
      { label: ballVisible ? '隐藏悬浮球' : '显示悬浮球', click: () => toggleBallVisibility() },
      { label: '打开数据目录', click: () => shell.openPath(DATA_DIR) },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ];
    Menu.buildFromTemplate(template).popup({ window: ballWin });
  });

  // ---- 面板 ----
  ipcMain.on('panel:hide', () => hidePanel('renderer'));
  // 挡板被点：用户在面板外面按了鼠标 → 收起
  ipcMain.on('backdrop:click', () => {
    logToFile('[backdrop] click received');
    hidePanel('backdrop');
  });
  ipcMain.on('panel:open', () => showPanel());
  ipcMain.on('panel:ready', () => {
    if (panelWin) pushStateTo(panelWin);
  });

  // ---- 待办 ----
  ipcMain.handle('todos:add', (_e, input) => {
    const todo = store.addTodo(input);
    broadcastState();
    return todo;
  });

  ipcMain.handle('todos:update', (_e, { id, patch }) => {
    const todo = store.updateTodo(id, patch);
    broadcastState();
    return todo;
  });

  ipcMain.handle('todos:toggle', (_e, id) => {
    const todo = store.toggleTodo(id);
    broadcastState();
    return todo;
  });

  ipcMain.handle('todos:remove', (_e, id) => {
    const ok = store.removeTodo(id);
    broadcastState();
    return ok;
  });

  ipcMain.handle('todos:restore', (_e, todo) => {
    const restored = store.restoreTodo(todo);
    broadcastState();
    return restored;
  });

  ipcMain.handle('todos:clearCompleted', () => {
    const n = store.clearCompleted();
    broadcastState();
    return n;
  });

  // ---- 设置 / 系统 ----
  ipcMain.handle('settings:save', (_e, patch) => {
    const before = { ...store.state.settings };
    const settings = store.saveSettings(patch);

    if (before.ballSize !== settings.ballSize) rebuildBallWindow();
    if (before.panelWidth !== settings.panelWidth || before.panelHeight !== settings.panelHeight) {
      const { winW, winH } = panelMetrics();
      if (panelWin && !panelWin.isDestroyed()) panelWin.setSize(winW, winH);
      positionPanel();
    }
    if (before.ballSize !== settings.ballSize) pushStateTo(ballWin);
    if (before.hotkey !== settings.hotkey) registerGlobalHotkey();
    if (
      before.ingestEnabled !== settings.ingestEnabled ||
      before.ingestPort !== settings.ingestPort ||
      before.ingestToken !== settings.ingestToken
    ) {
      restartIngest();
    }
    if (before.cxEnabled !== settings.cxEnabled || before.cxIntervalMin !== settings.cxIntervalMin) {
      cxStartSchedule();
    }
    // 额外页面 / 学校地址变了 → 重新猜一次学校实例地址
    if (
      before.cxSchoolUrl !== settings.cxSchoolUrl ||
      JSON.stringify(before.cxExtraUrls || []) !== JSON.stringify(settings.cxExtraUrls || [])
    ) {
      refreshSchoolUrl();
    }
    broadcastState();
    return { settings, hotkeyOk: lastHotkeyOk };
  });

  ipcMain.handle('app:openDataDir', () => shell.openPath(DATA_DIR));

  ipcMain.handle('app:copyText', (_e, text) => {
    try {
      clipboard.writeText(String(text == null ? '' : text));
      return true;
    } catch (err) {
      logToFile('[clipboard] error ' + (err && err.message));
      return false;
    }
  });

  // ---- 学习通 ----
  ipcMain.handle('chaoxing:sync', () => cxSync('manual'));
  ipcMain.handle('chaoxing:login', (_e, target) => cxOpenLogin(target === 'school' ? 'school' : 'generic'));
  ipcMain.handle('chaoxing:logout', () => cxLogout());

  ipcMain.handle('app:setAutoLaunch', (_e, enabled) => {
    const on = !!enabled;
    // 开发模式下（electron.exe 直接跑源码）写开机自启会得到一个「启动参数缺失」的坏启动项
    if (!app.isPackaged) {
      logToFile('[autolaunch] skipped: not packaged');
      return { ok: false, openAtLogin: false };
    }
    try {
      app.setLoginItemSettings({ openAtLogin: on, args: [] });
    } catch (err) {
      logToFile('[autolaunch] error ' + (err && err.message));
    }
    store.saveSettings({ autoLaunch: on });
    updateTrayMenu();
    broadcastState();
    let now = false;
    try {
      now = !!app.getLoginItemSettings().openAtLogin;
    } catch (_) {
      /* ignore */
    }
    return { ok: true, openAtLogin: now };
  });

  ipcMain.handle('app:exportJson', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出待办',
      defaultPath: `floating-todo-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, JSON.stringify(store.state, null, 2), 'utf8');
    return true;
  });

  ipcMain.on('app:quit', () => {
    isQuitting = true;
    app.quit();
  });
}

// ---------------------------------------------------------------------------
// 窗口/显示器变化
// ---------------------------------------------------------------------------
function revalidateBallPosition() {
  if (!ballWin || ballWin.isDestroyed()) return;
  const { win } = ballMetrics();
  const [x, y] = ballWin.getPosition();
  const next = clampToDisplays(x, y, win);
  if (next.x !== x || next.y !== y) {
    ballWin.setPosition(next.x, next.y);
    persistBallPosition();
  }
  if (panelWin && panelWin.isVisible()) positionPanel();
}

function registerScreenEvents() {
  screen.on('display-added', revalidateBallPosition);
  screen.on('display-removed', revalidateBallPosition);
  screen.on('display-metrics-changed', revalidateBallPosition);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (ballWin && !ballWin.isDestroyed()) {
      ballVisible = true;
      ballWin.showInactive();
    }
    showPanel();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.floatingtodo.app');

    fs.mkdirSync(DATA_DIR, { recursive: true });
    store = new Store(DATA_DIR);
    store.load();
    store.onChange = () => broadcastState();

    logToFile('--- app start ---', 'dataDir=' + DATA_DIR, 'recovered=' + store.recoveredFromBackup);

    registerIpc();
    createBallWindow();
    createPanelWindow();
    createTray();
    registerScreenEvents();
    startHoverPoll();
    startDayWatcher();

    reminder = new Reminder({
      store,
      log: (...args) => logToFile('[reminder]', ...args),
      onFire: (payload) => pushBallAlert(payload),
      onOpen: () => showPanel()
    });
    reminder.start();

    // 本机接入：首次运行生成令牌
    if (!store.state.settings.ingestToken) {
      store.saveSettings({ ingestToken: randomBytes(16).toString('hex') });
    }
    ingest = new IngestServer({
      store,
      log: (...args) => logToFile(...args),
      onIngest: () => broadcastState()
    });
    restartIngest();

    // 学习通：启动后先静默试抓一次，需要登录再弹登录窗口；之后按间隔自动同步
    cxStartSchedule();
    refreshSchoolUrl();
    if (process.env.FLOATING_TODO_DUMP_COOKIES) {
      setTimeout(() => dumpCxCookies('startup'), 3000);
    }
    if (store.state.settings.cxEnabled) {
      setTimeout(async () => {
        const r = await cxSync('startup');
        // 首次启动先让用户看完新手引导，别一上来就弹登录窗
        if (r && r.needLogin && store.state.settings.onboarded !== false) cxOpenLogin();
      }, 5000);
    }

    // 开发用：把指定页面的 HTML 落盘，方便对着真实结构调采集规则
    if (process.env.FLOATING_TODO_DUMP_URL) {
      logToFile('[dump] armed, url=' + process.env.FLOATING_TODO_DUMP_URL.slice(0, 120));
      setTimeout(async () => {
        let dumpWin = null;
        let cxSession = null;
        const captured = [];
        try {
          logToFile('[dump] start');
          cxSession = session.fromPartition(CX_PARTITION);
          const onReq = (details) => {
            const u = details.url || '';
            if (/\.(css|png|jpe?g|gif|svg|woff2?|ttf|ico|mp4)(\?|$)/i.test(u)) return;
            if (!/mooc|chaoxing|ecust|exam|work|task|active/i.test(u)) return;
            captured.push(`${details.resourceType} ${u}`);
          };
          cxSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, onReq);
          dumpWin = new BrowserWindow({
            show: false,
            width: 1100,
            height: 800,
            skipTaskbar: true,
            webPreferences: {
              partition: CX_PARTITION,
              contextIsolation: true,
              nodeIntegration: false,
              backgroundThrottling: false,
              userAgent: CX_UA
            }
          });
          const how = await loadPage(dumpWin, process.env.FLOATING_TODO_DUMP_URL, 20000);
          logToFile('[dump] load ' + how);
          await sleep(6000);

          const stamp = Date.now();
          // 先把抓到的请求清单落盘：这一步不依赖页面能否执行 JS
          const outNet = path.join(DATA_DIR, `net-${stamp}.txt`);
          fs.writeFileSync(outNet, Array.from(new Set(captured)).join('\n'), 'utf8');
          logToFile(`[dump] net urls=${new Set(captured).size} -> ${outNet}`);

          const info = await execJs(
            dumpWin,
            '({url: location.href, html: document.documentElement.outerHTML, text: (document.body?document.body.innerText:"").slice(0,600), iframes: Array.from(document.querySelectorAll("iframe")).map(f=>f.src)})',
            12000
          );
          if (!info) {
            logToFile('[dump] execJs returned nothing (page likely busy)');
            return;
          }
          const outHtml = path.join(DATA_DIR, `dump-${stamp}.html`);
          fs.writeFileSync(outHtml, info.html, 'utf8');

          logToFile(`[dump] wrote ${outHtml} len=${info.html.length}`);
          logToFile(`[dump] iframes=${JSON.stringify(info.iframes).slice(0, 400)}`);
        } catch (err) {
          logToFile('[dump] failed ' + ((err && err.message) || err));
        } finally {
          try {
            cxSession.webRequest.onBeforeRequest(null);
          } catch (_) {
            /* ignore */
          }
          try {
            if (dumpWin && !dumpWin.isDestroyed()) dumpWin.destroy();
          } catch (_) {
            /* ignore */
          }
        }
      }, 20000);
    }

    registerGlobalHotkey();

    // 备份恢复提示
    if (store.recoveredFromBackup) {
      setTimeout(() => {
        dialog.showMessageBox({
          type: 'warning',
          title: '数据已从备份恢复',
          message: '检测到待办数据文件损坏，已自动从最近的备份恢复。',
          detail: `损坏文件已留档：${store.corruptFile}`,
          buttons: ['知道了']
        });
      }, 1200);
    }

    // 首次启动：自动展开面板展示新手引导
    if (store.state.settings.onboarded === false) {
      setTimeout(() => showPanel(), 1500);
    }

    app.on('activate', () => showPanel());

    // 开发用：启动即展开面板，方便截图/调试
    if (process.env.FLOATING_TODO_OPEN_PANEL === '1') {
      setTimeout(() => showPanel(), 600);
    }
  });

  app.on('window-all-closed', () => {
    // 托盘常驻，不退出
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopDrag();
    stopHoverPoll();
      if (reminder) reminder.stop();
    if (ingest) ingest.stop();
    cxStopAll();
    try {
      globalShortcut.unregisterAll();
    } catch (_) {
      /* ignore */
    }
    if (store) {
      try {
        store.saveNow();
      } catch (_) {
        /* ignore */
      }
    }
  });
}

process.on('uncaughtException', (err) => {
  logToFile('uncaughtException', err && err.stack ? err.stack : String(err));
});
