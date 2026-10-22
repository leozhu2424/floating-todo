'use strict';

const params = new URLSearchParams(location.search);
const SIZE = Number(params.get('size')) || 44;

const ballEl = document.getElementById('ball');
const countEl = document.getElementById('count');

// 注意：必须设到 .ball 自己身上，不能只设 documentElement。
// ball.css 里 .ball 自带 `--size: 44px` 默认值，元素自身的声明会盖掉继承值，
// 之前只设到 html 上，导致「小/中/大」看起来完全没区别（球恒为 44px，只是窗口变了）。
ballEl.style.setProperty('--size', `${SIZE}px`);
document.documentElement.style.setProperty('--size', `${SIZE}px`);

const bridge = window.api;

let todos = [];
let settings = { animation: true, ballTheme: 'aurora' };
let pressed = false;
let dragging = false;
let pressPoint = null;
let pressTime = 0;

// 外观配色：只换 CSS 变量，球的结构不动
function applyBallTheme() {
  const theme = settings && settings.ballTheme ? String(settings.ballTheme) : 'aurora';
  const root = document.documentElement;
  if (theme && theme !== 'aurora') root.dataset.ballTheme = theme;
  else delete root.dataset.ballTheme;
}

// 点击 / 拖动的判定阈值。
// 原来 4px 太敏感：正常点击时鼠标手抖 5~8px 很常见，会被判成拖动，
// 结果球跟着挪一下、面板却打不开，用起来就是「点不动」。
const DRAG_START_PX = 8; // 超过这个位移才真正进入拖动
const CLICK_SLOP_PX = 14; // 松手时总位移仍小于它 → 仍然当点击处理
const CLICK_MAX_MS = 600; // 且按住时间小于它，避免长按小位移被当成点击

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function render() {
  const undone = todos.filter((t) => !t.done);
  const now = Date.now();
  const overdue = undone.some((t) => {
    if (!t.dueAt) return false;
    const at = Date.parse(t.dueAt);
    if (!Number.isFinite(at)) return false;
    if (t.allDay) {
      const d = new Date(at);
      d.setHours(23, 59, 59, 999);
      return d.getTime() < now;
    }
    return at < now;
  });

  const n = undone.length;
  const text = n > 99 ? '99+' : n > 0 ? String(n) : '';
  if (countEl.textContent !== text) countEl.textContent = text;

  ballEl.classList.toggle('overdue', overdue);
  document.body.classList.toggle('no-anim', settings.animation === false);
  applyBallTheme();
  document.title = n > 0 ? `悬浮待办 · ${n} 项未完成` : '悬浮待办';
}

// ---------------------------------------------------------------------------
// 悬停：主进程轮询光标位置后通知过来
// （透明窗口 + setIgnoreMouseEvents 时，渲染层收不到转发的 mousemove）
// ---------------------------------------------------------------------------
bridge.onBallHover((inside) => {
  if (dragging) return;
  ballEl.classList.toggle('hover', !!inside);
});

// ---------------------------------------------------------------------------
// 点击 / 拖动
// ---------------------------------------------------------------------------
function insideBall(x, y) {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  // 窗口只比球大 6px，所以判定半径放宽一点，让边缘也好点中
  const r = SIZE / 2 + 4;
  return Math.hypot(x - cx, y - cy) <= r;
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (!insideBall(e.clientX, e.clientY)) return;
  pressed = true;
  dragging = false;
  pressTime = Date.now();
  pressPoint = { sx: e.screenX, sy: e.screenY, cx: e.clientX, cy: e.clientY };
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!pressed || dragging) return;
  // 按钮其实已经松开（比如鼠标在窗口外抬起）→ 别误判成拖动
  if ((e.buttons & 1) === 0) {
    pressed = false;
    return;
  }
  const dx = e.screenX - pressPoint.sx;
  const dy = e.screenY - pressPoint.sy;
  if (Math.hypot(dx, dy) > DRAG_START_PX) {
    dragging = true;
    ballEl.classList.add('dragging');
    bridge.ballDrag({ phase: 'start', dx: pressPoint.cx, dy: pressPoint.cy });
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !pressed) return;
  pressed = false;

  const moved = Math.hypot(e.screenX - pressPoint.sx, e.screenY - pressPoint.sy);
  const held = Date.now() - pressTime;

  if (dragging) {
    dragging = false;
    ballEl.classList.remove('dragging');

    if (moved <= CLICK_SLOP_PX && held <= CLICK_MAX_MS) {
      // 手抖被误判成拖动了：把球挪回原处，并照常当点击
      bridge.ballDrag({ phase: 'cancel' });
      bridge.ballClick();
      ballEl.classList.add('hover');
    } else {
      bridge.ballDrag({ phase: 'end' });
      ballEl.classList.add('hover');
    }
  } else {
    bridge.ballClick();
  }
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  bridge.ballMenu();
});

window.addEventListener('dragstart', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// 提醒：跳三下 + 播提示音
// ---------------------------------------------------------------------------
let chime = null;

function playChime() {
  try {
    if (!chime) {
      chime = new Audio('../../../assets/notify.wav');
      chime.preload = 'auto';
      chime.volume = 0.7;
    }
    chime.currentTime = 0;
    const p = chime.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => console.log('chime blocked', err && err.message));
    }
  } catch (err) {
    console.log('chime error', err && err.message);
  }
}

bridge.onReminder((payload) => {
  const wantSound = !payload || payload.sound !== false;
  if (wantSound && settings.sound !== false) playChime();

  ballEl.classList.remove('alert');
  void ballEl.offsetWidth; // 强制重排，让动画能连续重放
  ballEl.classList.add('alert');
  setTimeout(() => ballEl.classList.remove('alert'), 2300);
});

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
bridge.onState((next) => {
  if (!next) return;
  todos = Array.isArray(next.todos) ? next.todos : [];
  settings = next.settings || settings;
  render();
});

bridge.getState().then((s) => {
  if (!s) return;
  todos = Array.isArray(s.todos) ? s.todos : [];
  settings = s.settings || settings;
  render();
});

// 每分钟刷新一次「过期」状态，让红环不会被时间落下
setInterval(render, 60 * 1000);
