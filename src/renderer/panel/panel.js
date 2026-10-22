'use strict';

const bridge = window.api;
const P = window.FTParser;

const dom = {
  dateLabel: document.getElementById('dateLabel'),
  progressText: document.getElementById('progressText'),
  ringFg: document.getElementById('ringFg'),
  closeBtn: document.getElementById('closeBtn'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  composerChips: document.getElementById('composerChips'),
  timeBtn: document.getElementById('timeBtn'),
  prioBtn: document.getElementById('prioBtn'),
  hint: document.getElementById('hint'),
  list: document.getElementById('list'),
  tabs: document.getElementById('tabs'),
  settingsBtn: document.getElementById('settingsBtn'),
  timePop: document.getElementById('timePop'),
  dateInput: document.getElementById('dateInput'),
  timeInput: document.getElementById('timeInput'),
  allDayChk: document.getElementById('allDayChk'),
  applyTimeBtn: document.getElementById('applyTimeBtn'),
  clearTimeBtn: document.getElementById('clearTimeBtn'),
  timeQuicks: document.getElementById('timeQuicks'),
  sheet: document.getElementById('sheet'),
  sheetClose: document.getElementById('sheetClose'),
  sizeSeg: document.getElementById('sizeSeg'),
  animChk: document.getElementById('animChk'),
  soundChk: document.getElementById('soundChk'),
  snapChk: document.getElementById('snapChk'),
  ballThemeSeg: document.getElementById('ballThemeSeg'),
  themeSeg: document.getElementById('themeSeg'),
  dataDirHint: document.getElementById('dataDirHint'),
  openDirBtn: document.getElementById('openDirBtn'),
  exportBtn: document.getElementById('exportBtn'),
  toast: document.getElementById('toast'),
  toastText: document.getElementById('toastText'),
  toastAction: document.getElementById('toastAction'),
  hotkeyBtn: document.getElementById('hotkeyBtn'),
  hotkeyText: document.getElementById('hotkeyText'),
  hotkeyHint: document.getElementById('hotkeyHint'),
  autostartChk: document.getElementById('autostartChk'),
  clearDoneBtn: document.getElementById('clearDoneBtn'),
  ingestChk: document.getElementById('ingestChk'),
  ingestInfo: document.getElementById('ingestInfo'),
  ingestCopyBtn: document.getElementById('ingestCopyBtn'),
  cxChk: document.getElementById('cxChk'),
  cxInfo: document.getElementById('cxInfo'),
  cxLoginBtn: document.getElementById('cxLoginBtn'),
  cxSchoolLoginBtn: document.getElementById('cxSchoolLoginBtn'),
  cxSyncBtn: document.getElementById('cxSyncBtn'),
  cxLogoutBtn: document.getElementById('cxLogoutBtn'),
  cxLoginUrl: document.getElementById('cxLoginUrl'),
  cxSchoolUrl: document.getElementById('cxSchoolUrl'),
  cxSchoolHint: document.getElementById('cxSchoolHint'),
  cxExtraUrls: document.getElementById('cxExtraUrls'),
  welcome: document.getElementById('welcome'),
  welcomeStart: document.getElementById('welcomeStart'),
  welcomeLogin: document.getElementById('welcomeLogin')
};

const ICONS = {
  clock:
    '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  flag:
    '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 3v18M6 4h10l-1.8 3L16 10H6"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M5 7h14M9.5 7V5.2h5V7M7.5 7l.9 12.2h7.2L16.5 7"/></svg>'
};

let state = { todos: [], settings: {} };
let filter = 'open';
let pendingDue = null; // { iso, allDay }
let pendingPrio = 0;
let popTarget = null;
let lastDeleted = null;
let toastTimer = null;
let editingId = null;
let recording = false;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function iconBtn(name, act, title) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.dataset.act = act;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = ICONS[name];
  return b;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

function endOfDay(ts) {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function isOverdue(t) {
  if (!t.dueAt || t.done) return false;
  const ts = Date.parse(t.dueAt);
  if (!Number.isFinite(ts)) return false;
  return (t.allDay ? endOfDay(ts) : ts) < Date.now();
}

function repeatLabel(r) {
  if (!r || !r.unit) return '';
  const n = r.interval || 1;
  if (r.unit === 'day') return n === 1 ? '每天' : `每 ${n} 天`;
  if (r.unit === 'week') return n === 1 ? '每周' : `每 ${n} 周`;
  if (r.unit === 'month') return n === 1 ? '每月' : `每 ${n} 月`;
  if (r.unit === 'weekday') return '工作日';
  return '重复';
}

const PRIO_NAME = ['', '低', '中', '高'];

// ---------------------------------------------------------------------------
// 渲染：头部
// ---------------------------------------------------------------------------
function renderHeader() {
  const now = new Date();
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  dom.dateLabel.textContent = `${now.getMonth() + 1}月${now.getDate()}日 · ${wd}`;

  const s = startOfDay(now);
  const e = addDays(s, 1);
  const todays = state.todos.filter((t) => {
    if (!t.dueAt) return false;
    const ts = Date.parse(t.dueAt);
    return Number.isFinite(ts) && ts >= s.getTime() && ts < e.getTime();
  });
  const doneToday = todays.filter((t) => t.done).length;
  const undoneAll = state.todos.filter((t) => !t.done).length;

  if (todays.length > 0) {
    dom.progressText.textContent = `今天 ${doneToday}/${todays.length}`;
    const p = doneToday / todays.length;
    dom.ringFg.style.strokeDashoffset = String(94.25 * (1 - p));
  } else {
    dom.progressText.textContent = undoneAll > 0 ? `${undoneAll} 项待办` : '今天没有待办';
    dom.ringFg.style.strokeDashoffset = '94.25';
  }
}

// ---------------------------------------------------------------------------
// 渲染：列表
// ---------------------------------------------------------------------------
function buildGroups() {
  const now = new Date();
  const s = startOfDay(now);
  const e = addDays(s, 1);
  const e2 = addDays(s, 2);

  const buckets = { overdue: [], today: [], tomorrow: [], later: [], someday: [], done: [] };

  for (const t of state.todos) {
    if (t.done) {
      buckets.done.push(t);
      continue;
    }
    if (!t.dueAt) {
      buckets.someday.push(t);
      continue;
    }
    const ts = Date.parse(t.dueAt);
    if (!Number.isFinite(ts)) {
      buckets.someday.push(t);
      continue;
    }
    const cmp = t.allDay ? endOfDay(ts) : ts;
    if (cmp < Date.now()) buckets.overdue.push(t);
    else if (ts < e.getTime()) buckets.today.push(t);
    else if (ts < e2.getTime()) buckets.tomorrow.push(t);
    else buckets.later.push(t);
  }

  const byDue = (a, b) => {
    const ta = a.allDay ? endOfDay(Date.parse(a.dueAt)) : Date.parse(a.dueAt);
    const tb = b.allDay ? endOfDay(Date.parse(b.dueAt)) : Date.parse(b.dueAt);
    if (ta !== tb) return ta - tb;
    return (b.priority || 0) - (a.priority || 0);
  };
  const byPrio = (a, b) =>
    (b.priority || 0) - (a.priority || 0) || String(b.createdAt).localeCompare(String(a.createdAt));

  const DEFS = [
    { key: 'overdue', label: '已过期', items: buckets.overdue.sort(byDue), overdue: true },
    { key: 'today', label: '今天', items: buckets.today.sort(byDue) },
    { key: 'tomorrow', label: '明天', items: buckets.tomorrow.sort(byDue) },
    { key: 'later', label: '以后', items: buckets.later.sort(byDue) },
    { key: 'someday', label: '无日期', items: buckets.someday.sort(byPrio) },
    {
      key: 'done',
      label: '已完成',
      items: buckets.done.sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')))
    }
  ];

  if (filter === 'done') return DEFS.filter((g) => g.key === 'done');
  const open = DEFS.filter((g) => g.key !== 'done');
  if (filter === 'all') return open.concat(DEFS.filter((g) => g.key === 'done'));
  return open;
}

function itemEl(t) {
  const wrap = el('div', t.done ? 'item done' : 'item');
  wrap.dataset.id = t.id;
  wrap.dataset.prio = String(t.priority || 0);

  const check = el('button', 'check');
  check.dataset.act = 'toggle';
  check.title = t.done ? '标记为未完成' : '完成';
  check.setAttribute('aria-label', check.title);

  const body = el('div', 'item__body');
  const title = el('div', 'item__title', t.title);
  title.dataset.act = 'edit';
  title.title = '双击修改';
  body.appendChild(title);

  const hasMeta = t.dueAt || t.repeat || t.priority > 0;
  if (hasMeta) {
    const meta = el('div', 'item__meta');
    if (t.dueAt) {
      const chip = el('span', 'chip', P.humanDue(t.dueAt, t.allDay));
      if (isOverdue(t)) chip.classList.add('chip--overdue');
      meta.appendChild(chip);
    }
    if (t.repeat) meta.appendChild(el('span', 'chip chip--repeat', repeatLabel(t.repeat)));
    if (t.course) meta.appendChild(el('span', 'chip chip--course', t.course));
    if (t.priority > 0) meta.appendChild(el('span', 'chip', `优先级 ${PRIO_NAME[t.priority]}`));
    body.appendChild(meta);
  }

  const actions = el('div', 'item__actions');
  if (!t.done) {
    actions.appendChild(iconBtn('clock', 'time', '设置时间'));
    actions.appendChild(iconBtn('flag', 'prio', '切换优先级'));
  }
  actions.appendChild(iconBtn('trash', 'del', '删除'));

  wrap.append(check, body, actions);
  return wrap;
}

function emptyEl() {
  const box = el('div', 'empty');
  box.appendChild(el('div', 'empty__ball'));
  if (filter === 'done') {
    box.appendChild(el('div', null, '还没有完成的待办'));
  } else if (filter === 'all') {
    box.appendChild(el('div', null, '一条待办都没有'));
  } else {
    box.appendChild(el('div', null, '还没有待办'));
    box.appendChild(el('div', null, '在下面输入框写一条，回车即可'));
  }
  return box;
}

function renderList() {
  if (editingId) return; // 正在内联编辑，别打断
  dom.list.textContent = '';

  const groups = buildGroups();
  const visible = groups.filter((g) => g.items.length > 0);

  // 「已完成」视图才显示清空入口
  const doneCount = state.todos.filter((t) => t.done).length;
  dom.clearDoneBtn.hidden = !(filter === 'done' && doneCount > 0);

  if (visible.length === 0) {
    dom.list.appendChild(emptyEl());
    return;
  }

  for (const g of visible) {
    const head = el('div', g.overdue ? 'group__title group__title--overdue' : 'group__title');
    head.appendChild(el('span', null, g.label));
    head.appendChild(el('span', 'group__count', String(g.items.length)));
    dom.list.appendChild(head);
    for (const t of g.items) dom.list.appendChild(itemEl(t));
  }
}

// ---------------------------------------------------------------------------
// 渲染：输入区
// ---------------------------------------------------------------------------
function renderComposerChips() {
  dom.composerChips.textContent = '';

  if (pendingDue) {
    const chip = el('span', 'chip', P.humanDue(pendingDue.iso, pendingDue.allDay));
    const x = el('button', 'icon-btn');
    x.style.width = '14px';
    x.style.height = '14px';
    x.style.fontSize = '10px';
    x.textContent = '✕';
    x.title = '清除时间';
    x.dataset.act = 'clear-pending-time';
    chip.style.display = 'inline-flex';
    chip.style.alignItems = 'center';
    chip.style.gap = '3px';
    chip.appendChild(x);
    dom.composerChips.appendChild(chip);
  }

  if (pendingPrio > 0) {
    const chip = el('span', 'chip', `P${pendingPrio}`);
    chip.dataset.act = 'clear-pending-prio';
    chip.title = '点击清除优先级';
    dom.composerChips.appendChild(chip);
  }

  dom.prioBtn.className = `icon-btn composer__btn prio${pendingPrio}`;
}

function updateHint() {
  const raw = dom.input.value;
  if (!raw.trim()) {
    dom.hint.textContent = '';
    return;
  }
  const parsed = P.parse(raw);
  const parts = [];
  if (parsed.dueAt) parts.push(`📅 ${P.humanDue(parsed.dueAt, parsed.allDay)}`);
  if (parsed.repeat) parts.push(repeatLabel(parsed.repeat));
  if (parsed.priority > 0) parts.push(`优先级 ${PRIO_NAME[parsed.priority]}`);
  dom.hint.textContent = parts.length ? parts.join('   ·   ') : '';
}

// ---------------------------------------------------------------------------
// 渲染：设置
// ---------------------------------------------------------------------------
function applyTheme() {
  const theme = state.settings.theme || 'system';
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;

  // 面板主色跟着球走，避免「球的配色」和界面强调色对不上
  const ballTheme = state.settings.ballTheme || 'aurora';
  if (ballTheme && ballTheme !== 'aurora') document.documentElement.dataset.ballTheme = ballTheme;
  else delete document.documentElement.dataset.ballTheme;
}

function renderSettings() {
  const s = state.settings;

  for (const b of dom.sizeSeg.querySelectorAll('button')) {
    b.classList.toggle('is-active', Number(b.dataset.size) === (s.ballSize || 44));
  }
  for (const b of dom.themeSeg.querySelectorAll('button')) {
    b.classList.toggle('is-active', b.dataset.theme === (s.theme || 'system'));
  }
  for (const b of dom.ballThemeSeg.querySelectorAll('button')) {
    b.classList.toggle('is-active', b.dataset.ballTheme === (s.ballTheme || 'aurora'));
  }
  dom.snapChk.checked = s.snapToEdge !== false;
  dom.animChk.checked = s.animation !== false;
  dom.soundChk.checked = s.sound !== false;
  dom.autostartChk.checked = !!state.autoLaunch;
  if (!recording) dom.hotkeyText.textContent = prettyHotkey(s.hotkey || 'Control+Shift+T');

  const STALE_MS = 2 * 60 * 60 * 1000; // 超过 2 小时没成功同步就提醒

  dom.cxInfo.classList.remove('is-stale');
  dom.settingsBtn.classList.remove('has-warn');
  dom.settingsBtn.title = '设置';

  // ---- 内置学习通同步 ----
  const cx = state.chaoxing || {};
  dom.cxChk.checked = s.cxEnabled !== false;
  if (document.activeElement !== dom.cxLoginUrl) dom.cxLoginUrl.value = s.cxLoginUrl || '';
  if (document.activeElement !== dom.cxSchoolUrl) dom.cxSchoolUrl.value = s.cxSchoolUrl || '';
  if (document.activeElement !== dom.cxExtraUrls) {
    dom.cxExtraUrls.value = (Array.isArray(s.cxExtraUrls) ? s.cxExtraUrls : []).join('\n');
  }

  // 学校入口：填了就用填的，没填就显示自动识别到什么（识别不到就提示去填）
  const schoolUrl = cx.schoolUrl || '';
  dom.cxSchoolUrl.placeholder = cx.schoolSuggested
    ? `自动识别：${cx.schoolSuggested}`
    : '学校学习通地址（留空则自动识别）';
  const schoolKnown = !!(s.cxSchoolUrl || cx.schoolSuggested);
  dom.cxSchoolLoginBtn.disabled = !schoolKnown;
  dom.cxSchoolLoginBtn.title = schoolKnown ? '' : '需要先填你学校的地址';
  if (s.cxSchoolUrl) {
    dom.cxSchoolHint.textContent = '已填学校地址。不需要学校入口就清空它，不影响通用入口。';
  } else if (cx.schoolSuggested) {
    dom.cxSchoolHint.textContent = `自动识别到 ${cx.schoolSuggested.replace(/^https?:\/\//, '').replace(/\/work\/stu-work$/, '')}，不对就在上面改；不需要就留空。`;
  } else {
    dom.cxSchoolHint.textContent =
      '只有部分学校的学习通是独立站点。把你学校学习通的地址填进来即可（形如 https://mooc1.s.xxx.edu.cn/work/stu-work）；不需要就留空，不影响通用入口。';
  }

  let cxText = '';
  if (s.cxEnabled === false) cxText = '已关闭';
  else if (cx.status === 'syncing') cxText = '正在同步…';
  else if (cx.status === 'need-login') cxText = '⚠ 未登录，点「登录学习通」';
  else if (cx.status === 'error') cxText = `⚠ 出错：${cx.message || '未知'}`;
  else if (!cx.lastAt) cxText = '还没有成功同步过';
  else {
    const t = new Date(cx.lastAt);
    const hh = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const r = cx.lastResult || { created: 0, updated: 0, completed: 0 };
    const bits = [];
    if (r.created) bits.push(`新增 ${r.created}`);
    if (r.updated) bits.push(`更新 ${r.updated}`);
    if (r.completed) bits.push(`完成 ${r.completed}`);
    cxText = `已登录 · 最后 ${hh} ${bits.length ? bits.join(' / ') : '无新作业'}`;
  }
  // 部分来源登录过期：作业提交了却还显示，通常就是这个原因
  if (cx.partialLogin > 0 && cx.status !== 'need-login') {
    cxText = `⚠ 有 ${cx.partialLogin} 个来源登录已过期 · 点「登录学习通」重新扫码`;
  }

  dom.cxInfo.textContent = cxText;
  if (cx.status === 'need-login' || cx.status === 'error' || cx.partialLogin > 0) {
    dom.cxInfo.classList.add('is-stale');
  }
  if (cx.partialLogin > 0 && cx.status !== 'need-login') {
    dom.settingsBtn.classList.add('has-warn');
    dom.settingsBtn.title = '学习通有来源登录过期，需要重新扫码';
  }

  // ---- 备用接入 ----
  const ing = state.ingest;
  dom.ingestChk.checked = s.ingestEnabled !== false;
  if (!ing || !ing.enabled) {
    dom.ingestInfo.textContent = s.ingestEnabled === false ? '已关闭' : '未启动（端口可能被占用）';
  } else if (!ing.lastAt) {
    dom.ingestInfo.textContent = `本地 127.0.0.1:${ing.port} · 还没收到推送`;
  } else {
    const t = new Date(ing.lastAt);
    const hh = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    dom.ingestInfo.textContent = `本地 127.0.0.1:${ing.port} · ${hh} 收到过推送`;
  }

  // ---- 超过 2 小时没有任何一条同步成功 ----
  const lastOk = lastSuccessAt();
  if (s.cxEnabled !== false && lastOk && Date.now() - lastOk >= STALE_MS) {
    dom.cxInfo.classList.add('is-stale');
    dom.settingsBtn.classList.add('has-warn');
    dom.settingsBtn.title = `学习通已 ${fmtAge(Date.now() - lastOk)}没同步`;
  }
}

/** 两条路（内置窗口 / 浏览器脚本）里最近一次成功同步的时间 */
function lastSuccessAt() {
  const a = state.chaoxing && state.chaoxing.lastAt ? Date.parse(state.chaoxing.lastAt) : 0;
  const b = state.ingest && state.ingest.lastAt ? Date.parse(state.ingest.lastAt) : 0;
  return Math.max(a || 0, b || 0);
}

function fmtAge(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${Math.max(1, min)} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

/** 同步停了超过 2 小时就这样提示一次（30 分钟内不重复唠叨） */
let lastStaleNoticeAt = 0;

function maybeWarnStaleSync() {
  if (state.settings.cxEnabled === false) return;

  // 部分来源登录过期：这会让「学习通上已提交的作业仍然显示未完成」，优先级最高
  const cx = state.chaoxing || {};
  if (cx.partialLogin > 0) {
    showToast(`学习通有 ${cx.partialLogin} 个来源登录过期了，作业状态可能不同步，建议重新扫码`);
    return;
  }

  const lastOk = lastSuccessAt();
  if (!lastOk) return;

  const age = Date.now() - lastOk;
  if (age < 2 * 60 * 60 * 1000) return;
  if (Date.now() - lastStaleNoticeAt < 30 * 60 * 1000) return;

  lastStaleNoticeAt = Date.now();
  showToast(`学习通已 ${fmtAge(age)}没同步，检查一下是否已登录`);
}

function render() {
  applyTheme();
  renderHeader();
  renderList();
  renderComposerChips();
  renderSettings();
  updateHint();
  renderWelcome();
}

/** 首次启动的引导页 */
function renderWelcome() {
  const show = state.settings && state.settings.onboarded === false;
  dom.welcome.hidden = !show;
  if (show) {
    // 引导页打开时收起设置抽屉，避免层叠
    if (!dom.sheet.hidden) closeSheet();
  }
}

function dismissWelcome() {
  dom.welcome.hidden = true;
  saveSetting({ onboarded: true });
}

dom.welcomeStart.addEventListener('click', () => {
  dismissWelcome();
});

dom.welcomeLogin.addEventListener('click', async () => {
  dismissWelcome();
  showToast('已打开登录窗口，用手机学习通扫码即可');
  await bridge.cxLogin();
});

// ---------------------------------------------------------------------------
// 数据操作
// ---------------------------------------------------------------------------
async function refresh() {
  try {
    const next = await bridge.getState();
    if (next) state = next;
  } catch (_) {
    /* ignore */
  }
  render();
}

async function submit() {
  const raw = dom.input.value;
  if (!raw.trim()) return;

  const parsed = P.parse(raw);
  const dueAt = pendingDue ? pendingDue.iso : parsed.dueAt;
  const allDay = pendingDue ? pendingDue.allDay : parsed.allDay;
  const priority = pendingPrio || parsed.priority;

  dom.input.value = '';
  pendingDue = null;
  pendingPrio = 0;
  updateHint();
  renderComposerChips();

  await bridge.addTodo({
    title: parsed.title,
    dueAt,
    allDay,
    priority,
    repeat: parsed.repeat
  });

  await refresh();
  dom.input.focus();
}

async function toggle(id) {
  await bridge.toggleTodo(id);
  await refresh();
}

async function removeTodo(id) {
  const victim = state.todos.find((t) => t.id === id);
  await bridge.removeTodo(id);
  await refresh();
  if (victim) {
    lastDeleted = victim;
    showToast('已删除一条待办', '撤销', async () => {
      await bridge.restoreTodo(victim);
      await refresh();
      hideToast();
    });
  }
}

function cyclePriority(id) {
  const t = state.todos.find((x) => x.id === id);
  if (!t) return;
  const next = ((t.priority || 0) + 1) % 4;
  bridge.updateTodo(id, { priority: next }).then(refresh);
}

// ---------------------------------------------------------------------------
// 内联编辑
// ---------------------------------------------------------------------------
function startEdit(wrap, todo) {
  if (editingId) return;
  editingId = todo.id;

  const body = wrap.querySelector('.item__body');
  const titleEl = body.querySelector('.item__title');
  const input = document.createElement('input');
  input.className = 'item__edit';
  input.type = 'text';
  input.maxLength = 200;
  input.value = todo.title;
  body.replaceChild(input, titleEl);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    editingId = null;
    const value = input.value.trim();
    if (save && value && value !== todo.title) {
      await bridge.updateTodo(todo.id, { title: value });
    }
    await refresh();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------------------------------------------------------------------------
// 时间弹出层
// ---------------------------------------------------------------------------
function toDateValue(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toTimeValue(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openTimePop(target) {
  popTarget = target;
  let due = null;
  if (target === 'new') {
    due = pendingDue;
  } else {
    const t = state.todos.find((x) => x.id === target);
    if (t && t.dueAt) due = { iso: t.dueAt, allDay: !!t.allDay };
  }

  if (due && due.iso) {
    dom.dateInput.value = toDateValue(due.iso);
    dom.timeInput.value = due.allDay ? '' : toTimeValue(due.iso);
    dom.allDayChk.checked = !!due.allDay;
  } else {
    dom.dateInput.value = '';
    dom.timeInput.value = '';
    dom.allDayChk.checked = false;
  }

  dom.timeInput.disabled = dom.allDayChk.checked;
  dom.timePop.hidden = false;
  dom.dateInput.focus();
}

function closeTimePop() {
  dom.timePop.hidden = true;
  popTarget = null;
}

function applyTime() {
  const target = popTarget;
  const dateVal = dom.dateInput.value;

  if (!dateVal) {
    clearTime(target);
    return;
  }

  const allDay = dom.allDayChk.checked;
  const timeVal = allDay ? '' : dom.timeInput.value;
  const [y, mo, d] = dateVal.split('-').map(Number);
  let h = 23;
  let mi = 59;
  if (timeVal) {
    const [hh, mm] = timeVal.split(':').map(Number);
    h = hh;
    mi = mm;
  } else if (!allDay) {
    // 只填了日期没填时间 → 按全天处理，避免变成 23:59 的「已过期」
    h = 9;
    mi = 0;
  }

  const when = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (Number.isNaN(when.getTime())) return;

  const iso = when.toISOString();
  const isAllDay = allDay || !timeVal;

  if (target === 'new') {
    pendingDue = { iso, allDay: isAllDay };
    renderComposerChips();
    updateHint();
  } else if (target) {
    bridge.updateTodo(target, { dueAt: iso, allDay: isAllDay }).then(refresh);
  }
  closeTimePop();
  dom.input.focus();
}

function clearTime(target) {
  if (target === 'new') {
    pendingDue = null;
    renderComposerChips();
    updateHint();
  } else if (target) {
    bridge.updateTodo(target, { dueAt: null, allDay: false, remindAt: null }).then(refresh);
  }
  closeTimePop();
  dom.input.focus();
}

function applyQuick(kind) {
  const now = new Date();
  const s = startOfDay(now);
  let d = new Date(s);

  if (kind === 'today18') {
    d.setHours(18, 0, 0, 0);
  } else if (kind === 'tomorrow9') {
    d = addDays(s, 1);
    d.setHours(9, 0, 0, 0);
  } else if (kind === 'tomorrow18') {
    d = addDays(s, 1);
    d.setHours(18, 0, 0, 0);
  } else if (kind === 'nextMon9') {
    let delta = (1 - now.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    d = addDays(s, delta);
    d.setHours(9, 0, 0, 0);
  } else {
    return;
  }

  dom.dateInput.value = toDateValue(d.toISOString());
  dom.timeInput.value = toTimeValue(d.toISOString());
  dom.timeInput.disabled = false;
  dom.allDayChk.checked = false;
}

// ---------------------------------------------------------------------------
// 设置抽屉
// ---------------------------------------------------------------------------
function openSheet() {
  dom.sheet.hidden = false;
  renderSettings();
  dom.dataDirHint.textContent = state.dataDir || '';
}

function closeSheet() {
  dom.sheet.hidden = true;
}

async function saveSetting(patch) {
  await bridge.saveSettings(patch);
  await refresh();
}

// ---------------------------------------------------------------------------
// 全局快捷键录制
// ---------------------------------------------------------------------------
function prettyHotkey(accel) {
  return String(accel || '')
    .split('+')
    .map((k) => {
      if (k === 'Control' || k === 'CmdOrCtrl') return 'Ctrl';
      if (k === 'Super' || k === 'Meta') return 'Win';
      return k;
    })
    .join(' + ');
}

function keyFromEvent(e) {
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  const map = {
    Space: 'Space',
    Enter: 'Return',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    Delete: 'Delete',
    Tab: 'Tab'
  };
  return map[code] || null;
}

function onHotkeyKey(e) {
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') {
    stopRecording();
    dom.hotkeyHint.textContent = '点一下，再按你要用的组合键即可更换';
    return;
  }

  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  const key = keyFromEvent(e);
  if (!key) return;

  if (mods.length === 0) {
    dom.hotkeyHint.textContent = '至少要带上 Ctrl / Alt / Shift 其中一个';
    return;
  }

  const accel = mods.concat(key).join('+');
  stopRecording();
  applyHotkey(accel);
}

function startRecording() {
  recording = true;
  dom.hotkeyText.textContent = '按下组合键…';
  dom.hotkeyBtn.classList.add('is-recording');
  dom.hotkeyHint.textContent = '按 Esc 取消';
  window.addEventListener('keydown', onHotkeyKey, true);
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  dom.hotkeyBtn.classList.remove('is-recording');
  window.removeEventListener('keydown', onHotkeyKey, true);
  renderSettings();
}

async function applyHotkey(accel) {
  const res = await bridge.saveSettings({ hotkey: accel });
  await refresh();
  if (res && res.hotkeyOk === false) {
    dom.hotkeyHint.textContent = '这个组合键被别的程序占用了，换一个试试';
  } else {
    dom.hotkeyHint.textContent = `已生效：${prettyHotkey(accel)}`;
  }
}

// ---------------------------------------------------------------------------
// 轻提示
// ---------------------------------------------------------------------------
function showToast(text, actionLabel, action) {
  dom.toastText.textContent = text;
  if (actionLabel) {
    dom.toastAction.hidden = false;
    dom.toastAction.textContent = actionLabel;
    dom.toastAction.onclick = action;
  } else {
    dom.toastAction.hidden = true;
    dom.toastAction.onclick = null;
  }
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 4000);
}

function hideToast() {
  dom.toast.hidden = true;
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
dom.input.addEventListener('input', updateHint);

dom.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submit();
  } else if (e.key === 'Escape') {
    if (dom.input.value) {
      e.stopPropagation();
      dom.input.value = '';
      updateHint();
    }
  }
});

dom.closeBtn.addEventListener('click', () => bridge.hidePanel());

dom.list.addEventListener('click', (e) => {
  const target = e.target.closest('[data-act]');
  if (!target) return;
  const item = target.closest('.item');
  if (!item) return;
  const id = item.dataset.id;
  const act = target.dataset.act;

  if (act === 'toggle') toggle(id);
  else if (act === 'del') removeTodo(id);
  else if (act === 'time') openTimePop(id);
  else if (act === 'prio') cyclePriority(id);
});

dom.list.addEventListener('dblclick', (e) => {
  const title = e.target.closest('.item__title');
  if (!title) return;
  const item = title.closest('.item');
  const todo = state.todos.find((t) => t.id === item.dataset.id);
  if (todo) startEdit(item, todo);
});

dom.tabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  filter = tab.dataset.filter;
  for (const b of dom.tabs.querySelectorAll('.tab')) b.classList.toggle('is-active', b === tab);
  renderList();
});

dom.clearDoneBtn.addEventListener('click', async () => {
  const n = await bridge.clearCompleted();
  await refresh();
  if (n > 0) showToast(`已清空 ${n} 条已完成`);
});

dom.timeBtn.addEventListener('click', () => openTimePop('new'));

dom.prioBtn.addEventListener('click', () => {
  pendingPrio = (pendingPrio + 1) % 4;
  renderComposerChips();
});

dom.composerChips.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'clear-pending-time') {
    pendingDue = null;
    renderComposerChips();
    updateHint();
  } else if (act === 'clear-pending-prio') {
    pendingPrio = 0;
    renderComposerChips();
  }
});

dom.applyTimeBtn.addEventListener('click', applyTime);
dom.clearTimeBtn.addEventListener('click', () => clearTime(popTarget));

dom.timeQuicks.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-set]');
  if (b) applyQuick(b.dataset.set);
});

[dom.dateInput, dom.timeInput].forEach((input) => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyTime();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeTimePop();
    }
  });
});

dom.allDayChk.addEventListener('change', () => {
  dom.timeInput.disabled = dom.allDayChk.checked;
  if (dom.allDayChk.checked) dom.timeInput.value = '';
});

dom.settingsBtn.addEventListener('click', openSheet);
dom.sheetClose.addEventListener('click', closeSheet);

dom.sizeSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-size]');
  if (b) saveSetting({ ballSize: Number(b.dataset.size) });
});

dom.themeSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-theme]');
  if (b) saveSetting({ theme: b.dataset.theme });
});

dom.ballThemeSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ball-theme]');
  if (b) saveSetting({ ballTheme: b.dataset.ballTheme });
});

dom.snapChk.addEventListener('change', () => saveSetting({ snapToEdge: dom.snapChk.checked }));
dom.animChk.addEventListener('change', () => saveSetting({ animation: dom.animChk.checked }));
dom.soundChk.addEventListener('change', () => saveSetting({ sound: dom.soundChk.checked }));
dom.autostartChk.addEventListener('change', async () => {
  const res = await bridge.setAutoLaunch(dom.autostartChk.checked);
  await refresh();
  if (res && res.ok === false) {
    showToast('开发模式下不能设置开机自启，打包成 exe 后才可用');
  }
});
dom.hotkeyBtn.addEventListener('click', () => {
  if (recording) stopRecording();
  else startRecording();
});

dom.ingestChk.addEventListener('change', () => saveSetting({ ingestEnabled: dom.ingestChk.checked }));

// ---- 内置学习通 ----
dom.cxChk.addEventListener('change', () => saveSetting({ cxEnabled: dom.cxChk.checked }));

dom.cxLoginBtn.addEventListener('click', async () => {
  closeSheet();
  showToast('已打开登录窗口，登录成功后会自动关闭');
  const r = await bridge.cxLogin('generic');
  if (!r || !r.ok) showToast('登录窗口打不开，看日志');
});

dom.cxSchoolLoginBtn.addEventListener('click', async () => {
  const r = await bridge.cxLogin('school');
  if (r && r.ok) {
    closeSheet();
    showToast('打开学校入口，用校园统一认证登录');
    return;
  }
  if (r && r.needUrl) {
    // 学校地址未知：把自动识别的结果填进去，让用户确认一下再点
    if (r.suggested && !dom.cxSchoolUrl.value.trim()) {
      dom.cxSchoolUrl.value = r.suggested;
      showToast('已自动识别学校地址，确认无误再点一次「登录学校入口」');
    } else {
      showToast('先填你学校学习通的地址（浏览器里复制），再点登录');
    }
    dom.cxSchoolUrl.focus();
    dom.cxSchoolUrl.select();
    return;
  }
  showToast('登录窗口打不开，看日志');
});

dom.cxSyncBtn.addEventListener('click', async () => {
  showToast('正在同步学习通…');
  const r = await bridge.cxSync();
  await refresh();
  if (r && r.ok) {
    const bits = [`新增 ${r.created}`, `更新 ${r.updated}`];
    if (r.completed) bits.push(`完成 ${r.completed}`);
    showToast(`同步完成：${bits.join('，')}`);
  } else if (r && r.needLogin) showToast('需要登录学习通，点「登录学习通」');
  else if (r && r.busy) showToast('正在同步中，稍等');
  else if (r && r.disabled) showToast('学习通同步已关闭');
  else if (r && r.error) showToast(`同步失败：${r.error}`);
});

dom.cxLogoutBtn.addEventListener('click', async () => {
  await bridge.cxLogout();
  await refresh();
  showToast('已清除学习通登录状态');
});

dom.cxLoginUrl.addEventListener('change', () => {
  saveSetting({ cxLoginUrl: dom.cxLoginUrl.value.trim() });
});

dom.cxSchoolUrl.addEventListener('change', () => {
  const v = dom.cxSchoolUrl.value.trim();
  saveSetting({ cxSchoolUrl: v });
  showToast(v ? '已保存学校入口地址' : '已清空学校入口（不启用）');
});

dom.cxExtraUrls.addEventListener('change', () => {
  const urls = dom.cxExtraUrls.value
    .split(/[\r\n]+/)
    .map((x) => x.trim())
    .filter((x) => /^https?:\/\//i.test(x));
  saveSetting({ cxExtraUrls: urls });
  showToast(urls.length ? `已保存 ${urls.length} 个额外页面` : '已清空额外页面');
});

dom.ingestCopyBtn.addEventListener('click', async () => {
  const s = state.settings;
  const ing = state.ingest;
  const port = ing && ing.port ? ing.port : s.ingestPort;
  const token = s.ingestToken || '';
  if (!token) {
    showToast('令牌还没生成，重启程序后再试');
    return;
  }
  const text = `let FT_ENDPOINT = 'http://127.0.0.1:${port}';\nlet FT_TOKEN = '${token}';`;
  const ok = await bridge.copyText(text);
  showToast(ok ? '已复制：替换脚本顶部那两行配置' : '复制失败，请手抄地址和令牌');
});
dom.openDirBtn.addEventListener('click', () => bridge.openDataDir());
dom.exportBtn.addEventListener('click', async () => {
  const ok = await bridge.exportJson();
  if (ok) showToast('已导出 JSON');
});

// 点击卡片外的透明区 = 收起
document.body.addEventListener('mousedown', (e) => {
  if (e.target === document.body) bridge.hidePanel();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (recording) return;
  if (editingId) return;
  if (!dom.timePop.hidden) {
    closeTimePop();
    return;
  }
  if (!dom.sheet.hidden) {
    closeSheet();
    return;
  }
  bridge.hidePanel();
});

// ---------------------------------------------------------------------------
// 主进程消息
// ---------------------------------------------------------------------------
bridge.onState((next) => {
  if (!next) return;
  state = next;
  render();
});

if (typeof bridge.onPanelShown === 'function') {
  // 开发用 ?sheet=1 时不要被「重开回到列表」的逻辑关掉
  const forceSheet = new URLSearchParams(location.search).get('sheet') === '1';

  bridge.onPanelShown(() => {
    document.body.classList.add('is-open');
    setTimeout(() => document.body.classList.remove('is-open'), 200);

    if (!forceSheet) {
      // 每次重新展开都回到列表：收起设置抽屉 / 时间弹层
      if (!dom.sheet.hidden) closeSheet();
      if (!dom.timePop.hidden) closeTimePop();
      hideToast();
    }

    dom.input.focus();
    dom.input.select();

    // 同步断了就顺手提示一次
    maybeWarnStaleSync();
  });
}

// 每分钟刷新一次分组（跨过零点、任务变过期）
setInterval(render, 60 * 1000);

// 初始化
refresh();
dom.input.focus();

// 开发用：?sheet=1 直接展开设置
if (new URLSearchParams(location.search).get('sheet') === '1') {
  setTimeout(() => openSheet(), 300);
}
