'use strict';

const { Notification } = require('electron');

const TICK_MS = 20 * 1000; // 每 20 秒扫一次
const FRESH_MS = 60 * 1000; // 1 分钟内到期的算「刚到期」，单条弹
const MAX_SINGLE = 3; // 一次最多弹几条，其余并进汇总

function pad(n) {
  return String(n).padStart(2, '0');
}

function timeText(iso, allDay) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (allDay) return sameDay ? '今天' : `${d.getMonth() + 1}月${d.getDate()}日`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/**
 * 提醒调度
 *
 * 规则：
 * - 有 remindAt 用 remindAt；否则用 dueAt；
 * - 全天任务（allDay）默认在当天 09:00 提醒；
 * - 已 remindedAt 的不再重复提醒（改时间会清空它）；
 * - 超过 1 分钟才被发现的一律汇总成一条，避免睡醒/开机后弹一屏通知。
 */
class Reminder {
  constructor(opts = {}) {
    this.store = opts.store;
    this.log = opts.log || (() => {});
    this.onFire = opts.onFire || (() => {});
    this.onOpen = opts.onOpen || (() => {});
    this.timer = null;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // 启动 3 秒后补算一次（覆盖关机期间错过的）
    setTimeout(() => this.tick(), 3000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  targetTime(todo) {
    if (todo.remindAt) {
      const t = Date.parse(todo.remindAt);
      if (Number.isFinite(t)) return t;
    }
    if (!todo.dueAt) return null;
    const due = Date.parse(todo.dueAt);
    if (!Number.isFinite(due)) return null;
    if (todo.allDay) {
      const d = new Date(due);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }
    return due;
  }

  pending(now = Date.now()) {
    const out = [];
    for (const todo of this.store.state.todos) {
      if (todo.done || todo.remindedAt) continue;
      const at = this.targetTime(todo);
      if (at === null) continue;
      if (at <= now) out.push({ todo, at });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  tick() {
    let items;
    try {
      items = this.pending(Date.now());
    } catch (err) {
      this.log('reminder tick error', err && err.message);
      return;
    }
    if (!items.length) return;

    const now = Date.now();
    const fresh = [];
    const stale = [];
    for (const it of items) {
      if (now - it.at <= FRESH_MS) fresh.push(it);
      else stale.push(it);
    }

    const sound = this.store.state.settings.sound !== false;

    if (fresh.length > 0) {
      const single = fresh.slice(0, MAX_SINGLE);
      const rest = fresh.slice(MAX_SINGLE);

      for (const it of single) {
        this.showToast(it.todo.title, it.todo.note || timeText(it.todo.dueAt, it.todo.allDay) || '时间到了', this.todoIcon());
      }
      if (single.length) this.onFire({ sound });
      if (rest.length) {
        stale.push(...rest);
      }
    }

    if (stale.length > 0) {
      const titles = stale.slice(0, 3).map((x) => x.todo.title).join('、');
      const body = stale.length > 3 ? `${titles} 等 ${stale.length} 条已到期` : titles;
      const title = stale.length === 1 ? stale[0].todo.title : `有 ${stale.length} 条待办已到期`;
      const bodyText =
        stale.length === 1
          ? stale[0].todo.note || timeText(stale[0].todo.dueAt, stale[0].todo.allDay) || '时间到了'
          : body;
      this.showToast(title, bodyText, this.todoIcon());
      this.onFire({ sound });
    }

    // 批量标记，只触发一次保存/广播
    this.store.markRemindedMany(items.map((x) => x.todo.id));
    this.store.saveNow();
    this.log(`reminder fired fresh=${fresh.length} stale=${stale.length}`);
  }

  todoIcon() {
    try {
      // eslint-disable-next-line global-require
      const path = require('path');
      return path.join(__dirname, '../../assets/icon.png');
    } catch (_) {
      return undefined;
    }
  }

  showToast(title, body, icon) {
    if (!Notification.isSupported()) {
      this.log('notification not supported');
      return null;
    }
    try {
      const n = new Notification({
        title: String(title || '待办提醒').slice(0, 120),
        body: String(body || '').slice(0, 200),
        icon,
        silent: true, // 声音由我们自己播，避免和系统音重复
        timeoutType: 'default'
      });
      n.on('click', () => this.onOpen());
      n.on('failed', (_e, err) => this.log('notification failed', err));
      n.show();
      return n;
    } catch (err) {
      this.log('notification error', err && err.message);
      return null;
    }
  }
}

module.exports = { Reminder, timeText };
