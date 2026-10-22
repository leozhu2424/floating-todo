'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const APP_FOLDER = 'FloatingTodo';
const BACKUP_KEEP = 7;

const DEFAULT_SETTINGS = Object.freeze({
  ballSize: 44,
  ballOpacity: 0.95,
  edgeHide: false,
  animation: true,
  sound: true,
  hotkey: 'Control+Shift+T',
  autoLaunch: false,
  theme: 'system',
  // 悬浮球配色（外观主题）
  ballTheme: 'aurora',
  // 拖到屏幕边缘附近时自动吸附
  snapToEdge: true,
  panelWidth: 320,
  panelHeight: 420,
  // 首次启动展示新手引导
  onboarded: false,
  // 本机接入（供浏览器脚本推送学习通作业）
  ingestEnabled: true,
  ingestPort: 45870,
  ingestToken: '',
  // 内置学习通同步（隐藏窗口，不依赖浏览器）
  // 留空则用通用域名的作业总表，登录页支持手机扫码
  cxEnabled: true,
  cxLoginUrl: '',
  // 学校自建学习通实例的地址（各校不同，留空则自动识别；识别不到=不启用学校入口）
  cxSchoolUrl: '',
  cxExtraUrls: [],
  cxIntervalMin: 30
});

// 可选外观主题（键名与 ball.css 里的 data-ball-theme 对应）
const BALL_THEMES = ['aurora', 'sunset', 'ocean', 'sakura', 'forest', 'mono'];

const PRIORITIES = [0, 1, 2, 3];

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    ball: { x: null, y: null, displayId: null },
    todos: []
  };
}

function normalizeTodo(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof src.id === 'string' && src.id ? src.id : randomUUID(),
    title: String(src.title == null ? '' : src.title).slice(0, 200),
    note: String(src.note == null ? '' : src.note).slice(0, 2000),
    done: !!src.done,
    createdAt: src.createdAt || nowIso(),
    updatedAt: src.updatedAt || nowIso(),
    completedAt: src.completedAt || null,
    dueAt: src.dueAt || null,
    allDay: !!src.allDay,
    remindAt: src.remindAt || null,
    remindedAt: src.remindedAt || null,
    priority: PRIORITIES.includes(src.priority) ? src.priority : 0,
    repeat: src.repeat && typeof src.repeat === 'object' ? src.repeat : null,
    tags: Array.isArray(src.tags) ? src.tags.map(String).slice(0, 10) : [],
    sortOrder: typeof src.sortOrder === 'number' ? src.sortOrder : 0,
    // 外部来源（学习通等）：sourceKey 用于去重
    source: src.source ? String(src.source).slice(0, 32) : null,
    sourceKey: src.sourceKey ? String(src.sourceKey).slice(0, 200) : null,
    sourceUrl: src.sourceUrl ? String(src.sourceUrl).slice(0, 500) : null,
    course: src.course ? String(src.course).slice(0, 60) : null
  };
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'todos.json');
    this.prevFile = path.join(dir, 'todos.prev.json');
    this.state = defaultState();
    this._saveTimer = null;
    this._lastSavedAt = 0;
    this.recoveredFromBackup = false;
    this.corruptFile = null;
    this.onChange = null;
  }

  // ---------- 读写 ----------

  load() {
    fs.mkdirSync(this.dir, { recursive: true });

    if (!fs.existsSync(this.file)) {
      this.state = defaultState();
      this.saveNow();
      this._maybeBackup();
      return this.state;
    }

    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.state = this._migrate(JSON.parse(raw));
    } catch (err) {
      // 损坏兜底：留档原文件 → 从最近备份恢复 → 再不行就空状态
      this.corruptFile = `${this.file}.corrupt.${stamp()}-${Date.now()}.json`;
      try {
        fs.copyFileSync(this.file, this.corruptFile);
      } catch (_) {
        /* 留档失败也不阻塞启动 */
      }
      const restored = this._restoreFromBackup();
      if (restored) {
        this.state = restored;
        this.recoveredFromBackup = true;
      } else {
        this.state = defaultState();
      }
      this.saveNow();
    }

    this._maybeBackup();
    return this.state;
  }

  _migrate(parsed) {
    const base = defaultState();
    if (!parsed || typeof parsed !== 'object') return base;

    const settings = { ...base.settings, ...(parsed.settings || {}) };
    settings.ballSize = [36, 44, 56].includes(settings.ballSize) ? settings.ballSize : 44;
    if (!BALL_THEMES.includes(settings.ballTheme)) settings.ballTheme = 'aurora';

    const ball = { ...base.ball, ...(parsed.ball || {}) };

    const todos = Array.isArray(parsed.todos) ? parsed.todos.map(normalizeTodo) : [];

    return { version: 1, settings, ball, todos };
  }

  /**
   * 从备份恢复。优先用「上一份好状态」（todos.prev.json），
   * 它才是最近一次成功保存的内容；每日备份只作长期兜底。
   */
  _restoreFromBackup() {
    try {
      if (fs.existsSync(this.prevFile)) {
        const raw = fs.readFileSync(this.prevFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.todos)) return this._migrate(parsed);
      }
    } catch (_) {
      /* prev 也坏了，继续找每日备份 */
    }

    let files = [];
    try {
      files = fs
        .readdirSync(this.dir)
        .filter((f) => /^todos\.backup\.\d{8}\.json$/.test(f))
        .sort()
        .reverse();
    } catch (_) {
      return null;
    }
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, f), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.todos)) return this._migrate(parsed);
      } catch (_) {
        /* 这份备份也坏，继续找下一份 */
      }
    }
    return null;
  }

  _maybeBackup() {
    if (!fs.existsSync(this.file)) return;
    const name = `todos.backup.${stamp()}.json`;
    const target = path.join(this.dir, name);
    try {
      if (!fs.existsSync(target)) {
        fs.copyFileSync(this.file, target);
      }
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => /^todos\.backup\.\d{8}\.json$/.test(f))
        .sort();
      while (files.length > BACKUP_KEEP) {
        const old = files.shift();
        try {
          fs.unlinkSync(path.join(this.dir, old));
        } catch (_) {
          /* ignore */
        }
      }
    } catch (_) {
      /* 备份失败不影响主流程 */
    }
  }

  /** 立即落盘：临时文件 + rename，避免写一半断电把 JSON 写花 */
  saveNow() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    const tmp = `${this.file}.tmp`;
    const json = JSON.stringify(this.state, null, 2);
    fs.mkdirSync(this.dir, { recursive: true });

    // 写之前先把当前磁盘上的「好状态」滚动留档：写坏了还能立刻退回去
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > 2) {
        fs.copyFileSync(this.file, this.prevFile);
      }
    } catch (_) {
      /* 留档失败不阻塞保存 */
    }

    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, this.file);
    this._lastSavedAt = Date.now();
  }

  /** 合并短时间内的连续修改，200ms 内只写一次盘 */
  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        this.saveNow();
      } catch (err) {
        console.error('[store] 保存失败', err);
      }
    }, 200);
  }

  _touch() {
    this.scheduleSave();
    if (typeof this.onChange === 'function') this.onChange(this.state);
  }

  // ---------- 待办操作 ----------

  addTodo(input = {}) {
    const title = String(input.title || '').trim();
    if (!title) return null;

    const todo = normalizeTodo({
      title,
      note: input.note,
      dueAt: input.dueAt || null,
      allDay: !!input.allDay,
      remindAt: input.remindAt || null,
      priority: input.priority,
      repeat: input.repeat || null,
      tags: input.tags,
      sortOrder: Date.now()
    });

    this.state.todos.push(todo);
    this._touch();
    return todo;
  }

  findTodo(id) {
    return this.state.todos.find((t) => t.id === id) || null;
  }

  updateTodo(id, patch = {}) {
    const todo = this.findTodo(id);
    if (!todo) return null;

    const allowed = ['title', 'note', 'dueAt', 'allDay', 'remindAt', 'priority', 'repeat', 'tags', 'sortOrder'];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        if (key === 'title') {
          const t = String(patch.title).trim();
          if (t) todo.title = t.slice(0, 200);
        } else if (key === 'note') {
          todo.note = String(patch.note || '').slice(0, 2000);
        } else if (key === 'priority') {
          todo.priority = PRIORITIES.includes(patch.priority) ? patch.priority : 0;
        } else if (key === 'allDay') {
          todo.allDay = !!patch.allDay;
        } else if (key === 'tags') {
          todo.tags = Array.isArray(patch.tags) ? patch.tags.map(String).slice(0, 10) : [];
        } else {
          todo[key] = patch[key] === '' ? null : patch[key];
        }
      }
    }

    // 时间被改动后，允许重新提醒
    if (Object.prototype.hasOwnProperty.call(patch, 'dueAt') || Object.prototype.hasOwnProperty.call(patch, 'remindAt')) {
      todo.remindedAt = null;
    }

    todo.updatedAt = nowIso();
    this._touch();
    return todo;
  }

  toggleTodo(id) {
    const todo = this.findTodo(id);
    if (!todo) return null;

    todo.done = !todo.done;
    todo.completedAt = todo.done ? nowIso() : null;
    todo.updatedAt = nowIso();

    if (todo.done && todo.repeat) {
      this._spawnRepeat(todo);
    }

    this._touch();
    return todo;
  }

  /** 重复任务完成后，生成下一次的副本 */
  _spawnRepeat(source) {
    const rule = source.repeat || {};
    const unit = rule.unit || 'day';
    const interval = Math.max(1, Number(rule.interval) || 1);
    const base = source.dueAt ? new Date(source.dueAt) : new Date();
    if (Number.isNaN(base.getTime())) return;

    const next = new Date(base);
    if (unit === 'day') {
      next.setDate(next.getDate() + interval);
    } else if (unit === 'week') {
      next.setDate(next.getDate() + 7 * interval);
    } else if (unit === 'month') {
      next.setMonth(next.getMonth() + interval);
    } else if (unit === 'weekday') {
      do {
        next.setDate(next.getDate() + 1);
      } while (next.getDay() === 0 || next.getDay() === 6);
    } else {
      return;
    }

    const clone = normalizeTodo({
      ...source,
      id: randomUUID(),
      done: false,
      completedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      remindedAt: null,
      dueAt: next.toISOString(),
      remindAt: null,
      sortOrder: next.getTime()
    });

    this.state.todos.push(clone);
  }

  /** 标记已提醒（不改变 updatedAt，避免干扰「最近修改」语义） */
  markReminded(id) {
    const todo = this.findTodo(id);
    if (!todo) return null;
    todo.remindedAt = nowIso();
    this._touch();
    return todo;
  }

  /** 批量标记，只广播/落盘一次 */
  markRemindedMany(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    let n = 0;
    for (const id of ids) {
      const todo = this.findTodo(id);
      if (todo && !todo.remindedAt) {
        todo.remindedAt = nowIso();
        n += 1;
      }
    }
    if (n > 0) this._touch();
    return n;
  }

  /**
   * 外部来源（学习通）推送过来的作业，按 sourceKey 去重。
   *
   * 规则：
   * - 没见过 → 新建；
   * - 已存在且已完成 → 跳过（不复活已完成的旧作业）；
   * - 已存在且截止时间变了 → 更新时间并清掉提醒标记（让它重新提醒一次）；
   * - 其余视为无变化。
   */
  upsertImported(items, sourceName = 'chaoxing') {
    const result = { created: 0, updated: 0, skipped: 0, completed: 0, todos: [] };
    if (!Array.isArray(items) || items.length === 0) return result;

    const now = nowIso();

    for (const raw of items) {
      if (!raw || !raw.sourceKey || !raw.title) {
        result.skipped += 1;
        continue;
      }

      const existing = this.state.todos.find((t) => t.sourceKey === raw.sourceKey);

      // 学习通那边已经完成/已提交 → 把对应待办打勾（单向，不会反向取消）
      if (raw.done) {
        // 找不到对应待办就不新建：已经做完的作业没必要再进列表
        if (!existing || existing.done) {
          result.skipped += 1;
          continue;
        }
        existing.done = true;
        existing.completedAt = now;
        existing.updatedAt = now;
        result.completed += 1;
        continue;
      }

      if (existing) {
        if (existing.done) {
          result.skipped += 1;
          continue;
        }

        let changed = false;

        // 学习通作业页给的是「剩余X小时Y分钟」，换算出来的绝对时间每次都会差几十秒。
        // 差得太小就不动它，否则每 5 分钟同步一次会不停「更新」并反复重置提醒。
        const oldTs = Date.parse(existing.dueAt || '');
        const newTs = Date.parse(raw.dueAt || '');
        const bothValid = Number.isFinite(oldTs) && Number.isFinite(newTs);
        const dueMoved = bothValid
          ? Math.abs(oldTs - newTs) > 2 * 60 * 1000
          : existing.dueAt !== raw.dueAt;

        if (dueMoved) {
          existing.dueAt = raw.dueAt;
          existing.allDay = !!raw.allDay;
          existing.remindedAt = null; // 截止时间变了才重新提醒
          changed = true;
        }

        if (raw.title && existing.title !== raw.title) {
          existing.title = raw.title;
          changed = true;
        }
        if (raw.course && existing.course !== raw.course) {
          existing.course = raw.course;
          changed = true;
        }
        if (raw.url && existing.sourceUrl !== raw.url) {
          existing.sourceUrl = raw.url;
          changed = true;
        }
        if (changed) {
          existing.updatedAt = now;
          result.updated += 1;
        } else {
          result.skipped += 1;
        }
        continue;
      }

      const todo = normalizeTodo({
        title: raw.title,
        dueAt: raw.dueAt,
        allDay: !!raw.allDay,
        priority: raw.priority || 0,
        source: sourceName,
        sourceKey: raw.sourceKey,
        sourceUrl: raw.url,
        course: raw.course,
        sortOrder: raw.dueAt ? Date.parse(raw.dueAt) : Date.now()
      });
      this.state.todos.push(todo);
      result.todos.push(todo);
      result.created += 1;
    }

    if (result.created > 0 || result.updated > 0 || result.completed > 0) this._touch();
    return result;
  }

  /** 撤销删除：整条原样放回去 */
  restoreTodo(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const todo = normalizeTodo(raw);
    if (this.state.todos.some((t) => t.id === todo.id)) return todo;
    this.state.todos.push(todo);
    this._touch();
    return todo;
  }

  removeTodo(id) {
    const before = this.state.todos.length;
    this.state.todos = this.state.todos.filter((t) => t.id !== id);
    if (this.state.todos.length !== before) {
      this._touch();
      return true;
    }
    return false;
  }

  clearCompleted() {
    const before = this.state.todos.length;
    this.state.todos = this.state.todos.filter((t) => !t.done);
    const removed = before - this.state.todos.length;
    if (removed > 0) this._touch();
    return removed;
  }

  // ---------- 设置 / 位置 ----------

  saveSettings(patch = {}) {
    this.state.settings = { ...this.state.settings, ...patch };
    if (![36, 44, 56].includes(this.state.settings.ballSize)) {
      this.state.settings.ballSize = 44;
    }
    if (!BALL_THEMES.includes(this.state.settings.ballTheme)) {
      this.state.settings.ballTheme = 'aurora';
    }
    this.saveNow();
    if (typeof this.onChange === 'function') this.onChange(this.state);
    return this.state.settings;
  }

  saveBallPosition(x, y, displayId) {
    this.state.ball = { x: Math.round(x), y: Math.round(y), displayId: displayId ?? null };
    this.scheduleSave();
  }
}

module.exports = { Store, APP_FOLDER, DEFAULT_SETTINGS, BALL_THEMES };
