// ==UserScript==
// @name         学习通作业 → 悬浮待办
// @namespace    floating-todo
// @version      0.2.1
// @description  把学习通里有明确截止时间的作业/考试，自动推送到桌面悬浮待办
// @author       floating-todo
// @match        *://*.chaoxing.com/*
// @match        *://*.chaoxing.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      chaoxing.com
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  'use strict';

  // =========================================================================
  // ① 配置：打开待办 → 设置 →「学习通同步」→ 复制接入配置，粘贴下面两行
  // =========================================================================
  let FT_ENDPOINT = 'http://127.0.0.1:45870';
  let FT_TOKEN = '';
  // =========================================================================

  const savedEndpoint = GM_getValue('ft_endpoint', '');
  const savedToken = GM_getValue('ft_token', '');
  if (savedEndpoint) FT_ENDPOINT = savedEndpoint;
  if (savedToken) FT_TOKEN = savedToken;

  // =========================================================================
  // ② 采集规则 —— 学习通改版后大概率要调这里
  // =========================================================================

  // 作业总表（实测可用：列出全部课程作业，截止时间显示为「剩余X小时Y分钟」）
  const WORK_LIST_URL = 'https://mooc1-api.chaoxing.com/work/stu-work';

  // 自动同步间隔
  const AUTO_SYNC_MS = 5 * 60 * 1000;

  // 容器深度上限
  const MAX_ANCESTOR_DEPTH = 8;

  // 绝对日期写法
  const ABS_PATTERNS = [
    /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日]?\s*(\d{1,2})\s*[:：]\s*(\d{2})/,
    /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日]?/,
    /(\d{1,2})[-/月](\d{1,2})[日]?\s*(\d{1,2})\s*[:：]\s*(\d{2})/
  ];

  // 倒计时写法：剩余177小时5分钟 / 剩余3天2小时 / 剩余45分钟
  const COUNTDOWN_RE = /剩余\s*((?:\d+\s*天)?\s*(?:\d+\s*小时)?\s*(?:\d+\s*分钟)?)/;
  const STATUS_RE = /未提交|已提交|已完成|待批阅|已批阅|未开始|已结束|已过期/g;

  // =========================================================================
  // 工具
  // =========================================================================
  function text(node) {
    return (node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /** 「剩余177小时5分钟」→ 绝对时间 */
  function parseCountdown(str) {
    const m = String(str || '').match(COUNTDOWN_RE);
    if (!m || !m[1]) return null;
    const seg = m[1];
    const day = /(\d+)\s*天/.exec(seg);
    const hour = /(\d+)\s*小时/.exec(seg);
    const min = /(\d+)\s*分钟/.exec(seg);
    const ms =
      ((day ? +day[1] : 0) * 86400 + (hour ? +hour[1] : 0) * 3600 + (min ? +min[1] : 0) * 60) * 1000;
    if (ms <= 0) return null;
    return new Date(Date.now() + ms).toISOString();
  }

  /** 绝对日期写法 */
  function parseAbsolute(str) {
    let m = str.match(ABS_PATTERNS[0]);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    m = str.match(ABS_PATTERNS[1]);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 0, 0);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    m = str.match(ABS_PATTERNS[2]);
    if (m) {
      const y = new Date().getFullYear();
      const d = new Date(y, +m[1] - 1, +m[2], +m[3], +m[4], 0, 0);
      if (d.getTime() < Date.now() - 180 * 864e5) d.setFullYear(y + 1);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
  }

  /** 从一行文字里抠出标题：去掉徽标、状态、课程名、倒计时 */
  function extractTitle(blockText, course) {
    let s = blockText;
    if (course) s = s.split(course).join(' ');
    s = s.replace(/《[^》]*》/g, ' ');
    s = s.replace(/剩余\s*(?:\d+\s*天)?\s*(?:\d+\s*小时)?\s*(?:\d+\s*分钟)?/g, ' ');
    s = s.replace(STATUS_RE, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^(作业|考试|测验|讨论|章节测验|任务点)\s*/, '').trim();
    return s.slice(0, 200);
  }

  /**
   * 这一行是不是「已经交过/做完」的。
   *
   * 关键：学习通对已完成的作业**照样显示「剩余X小时」**，光看倒计时会把做过的
   * 作业一起收进来（曾经踩过），所以必须再看状态字样。
   */
  function isDoneStatus(blockText) {
    const m = String(blockText || '').match(STATUS_RE);
    if (!m || !m.length) return false;
    return /已提交|已完成|已批阅|待批阅|已结束|已过期/.test(m.join(' '));
  }

  function idsFromHref(href) {
    const out = {};
    try {
      const u = new URL(href, location.origin);
      ['workId', 'examId', 'workid', 'examid', 'courseId', 'courseid', 'id'].forEach((k) => {
        if (u.searchParams.has(k)) out[k.toLowerCase()] = u.searchParams.get(k);
      });
      const m = u.pathname.match(/\/(work|exam)[^/]*\/(\d+)/);
      if (m) out[m[1] + 'id'] = m[2];
    } catch (_) {
      /* ignore */
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 策略 A：倒计时节点（作业总表就是这个格式）
  // -------------------------------------------------------------------------
  function collectByCountdown(root) {
    const out = [];
    const usedBoxes = new Set();
    const nodes = root.querySelectorAll('*');

    for (const el of nodes) {
      const t = text(el);
      // 只认「内容就是倒计时」的叶子节点，避免父容器重复命中
      if (t.length > 32 || t.indexOf('剩余') !== 0) continue;

      const dueAt = parseCountdown(t);
      if (!dueAt) continue;

      // 往上找同时包含《课程名》的容器
      let box = el.parentElement;
      let depth = 0;
      let target = null;
      while (box && depth < MAX_ANCESTOR_DEPTH) {
        const bt = text(box);
        if (bt.length > 400) break;
        if (/《[^》]+》/.test(bt)) {
          target = box;
          break;
        }
        box = box.parentElement;
        depth += 1;
      }
      if (!target) continue;
      if (usedBoxes.has(target)) continue;
      usedBoxes.add(target);

      const bt = text(target);
      const cm = bt.match(/《([^》]+)》/);
      const course = cm ? cm[1].replace(/[…\.\s]+$/, '').trim() : '';

      // 已提交/已完成的跳过（它们同样带倒计时，不能只看时间）
      if (isDoneStatus(bt)) continue;

      const title = extractTitle(bt, course);
      if (!title) continue;

      out.push({
        // 倒计时的绝对值每次都会漂移一点点，所以不能用 dueAt 参与去重键
        sourceKey: `cx:${course || 'x'}:${title}`,
        title,
        course: course || null,
        dueAt,
        url: WORK_LIST_URL
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 策略 B：链接里带 work/exam 的条目（部分页面是这种结构）
  // -------------------------------------------------------------------------
  function collectByLinks(root) {
    const out = [];
    const links = root.querySelectorAll('a[href]');

    for (const a of links) {
      const t = text(a);
      if (!t || t.length > 120) continue;

      const href = a.getAttribute('href') || '';
      const hl = href.toLowerCase();
      const hit =
        /work|exam|task|homework|quiz/.test(hl) || /作业|考试|测验|测试/.test(t);
      if (!hit) continue;

      let box = a.parentElement;
      let depth = 0;
      let dueAt = null;
      let blockText = '';
      while (box && depth < MAX_ANCESTOR_DEPTH) {
        const bt = text(box);
        if (bt.length > 400) break;
        const d = parseCountdown(bt) || parseAbsolute(bt);
        if (d) {
          dueAt = d;
          blockText = bt;
          break;
        }
        box = box.parentElement;
        depth += 1;
      }
      if (!dueAt) continue;

      const cm = blockText.match(/《([^》]+)》/);
      const course = cm ? cm[1].replace(/[…\.\s]+$/, '').trim() : '';
      const ids = idsFromHref(href);
      const idPart = ids.workid || ids.workId || ids.examid || ids.examId || ids.id ||
        hash(t + (course || ''));

      out.push({
        sourceKey: `cx:${ids.courseid || ids.courseId || course || 'x'}:${idPart}`,
        title: t.slice(0, 200),
        course: course || null,
        dueAt,
        url: href.indexOf('http') === 0 ? href.slice(0, 500) : null
      });
    }
    return out;
  }

  function collectFromDocument(doc) {
    const root = doc || document;
    const map = new Map();
    for (const it of collectByCountdown(root)) map.set(it.sourceKey, it);
    for (const it of collectByLinks(root)) map.set(it.sourceKey, it);
    return Array.from(map.values());
  }

  // =========================================================================
  // 与待办通信
  // =========================================================================
  function gmRequest(opts) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        ...opts,
        onload: (r) => resolve({ ok: true, status: r.status, text: r.responseText }),
        onerror: () => resolve({ ok: false, status: 0, text: '' }),
        ontimeout: () => resolve({ ok: false, status: 0, text: '' })
      });
    });
  }

  async function ping() {
    const r = await gmRequest({ method: 'GET', url: `${FT_ENDPOINT}/api/ping`, timeout: 4000 });
    if (!r.ok) return { ok: false };
    try {
      return JSON.parse(r.text);
    } catch (_) {
      return { ok: false };
    }
  }

  async function push(items) {
    const r = await gmRequest({
      method: 'POST',
      url: `${FT_ENDPOINT}/api/ingest`,
      headers: { 'Content-Type': 'application/json', 'X-FT-Token': FT_TOKEN },
      data: JSON.stringify({ items }),
      timeout: 10000
    });
    let body = null;
    try {
      body = JSON.parse(r.text);
    } catch (_) {
      body = { ok: false, error: r.ok ? '返回格式不对' : '网络错误' };
    }
    return { status: r.status, body };
  }

  /** 后台重新拉一次作业总表，拿到「新一点」的倒计时 */
  async function fetchWorkListDoc() {
    const r = await gmRequest({ method: 'GET', url: WORK_LIST_URL, timeout: 12000 });
    if (!r.ok || r.status !== 200 || !r.text) return null;
    try {
      return new DOMParser().parseFromString(r.text, 'text/html');
    } catch (_) {
      return null;
    }
  }

  /** 拿到的页面是不是登录页（登录过期时学习通会重定向） */
  function looksLikeLoginPage(doc) {
    if (!doc || !doc.body) return false;
    const t = text(doc.body).slice(0, 1500);
    return /扫码登录|账号登录|手机号登录|验证码登录|忘记密码|请先登录|重新登录/.test(t);
  }

  // =========================================================================
  // 界面
  // =========================================================================
  const state = { busy: false };

  let panelEl = null;

  function ensurePanel() {
    if (panelEl && document.body.contains(panelEl)) return panelEl;

    panelEl = document.createElement('div');
    panelEl.id = 'ft-sync-panel';
    panelEl.innerHTML = `
      <div class="ft-hd">
        <span class="ft-title">悬浮待办 · 学习通</span>
        <button class="ft-x" title="收起">✕</button>
      </div>
      <div class="ft-body">
        <div class="ft-msg">未同步</div>
        <div class="ft-btns">
          <button class="ft-btn ft-primary" data-act="sync">立即同步</button>
          <button class="ft-btn" data-act="preview">预览</button>
        </div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #ft-sync-panel {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
        width: 232px; border-radius: 12px; background: #fff;
        box-shadow: 0 8px 28px rgba(0,0,0,.22); border: 1px solid rgba(0,0,0,.06);
        font: 12px/1.5 "Microsoft YaHei UI", "Segoe UI", sans-serif; color: #1f1f1f;
        overflow: hidden;
      }
      #ft-sync-panel .ft-hd {
        display: flex; align-items: center; justify-content: space-between;
        padding: 7px 8px 7px 10px;
        background: linear-gradient(90deg,#4285f4,#9b72cb 28%,#d96570 52%,#f9ab00 76%,#34a853);
        color: #fff; font-weight: 600; font-size: 11.5px;
      }
      #ft-sync-panel .ft-x {
        border: none; background: rgba(255,255,255,.25); color: #fff; cursor: pointer;
        width: 18px; height: 18px; border-radius: 5px; font-size: 10px; line-height: 1; padding: 0;
      }
      #ft-sync-panel .ft-body { padding: 9px 10px 10px; }
      #ft-sync-panel .ft-msg { color: #5f6368; margin-bottom: 8px; word-break: break-all; white-space: pre-wrap; max-height: 150px; overflow: auto; }
      #ft-sync-panel .ft-btns { display: flex; gap: 6px; }
      #ft-sync-panel .ft-btn {
        flex: 1; border: 1px solid rgba(0,0,0,.1); background: #fff; color: #1f1f1f;
        border-radius: 8px; padding: 5px 0; font: inherit; cursor: pointer;
      }
      #ft-sync-panel .ft-btn:hover { background: rgba(66,133,244,.08); border-color: rgba(66,133,244,.35); }
      #ft-sync-panel .ft-primary { background: #4285f4; border-color: #4285f4; color: #fff; font-weight: 600; }
      #ft-sync-panel .ft-primary:hover { background: #3b78e7; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panelEl);

    panelEl.querySelector('.ft-x').addEventListener('click', () => {
      panelEl.style.display = 'none';
    });
    panelEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'sync') doSync(false);
      if (btn.dataset.act === 'preview') doSync(true);
    });

    return panelEl;
  }

  function setMessage(msg) {
    const p = ensurePanel();
    const el = p.querySelector('.ft-msg');
    if (el) el.textContent = msg;
  }

  // =========================================================================
  // 同步
  // =========================================================================
  function fmt(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function summarize(items) {
    if (!items.length) return '没找到带截止时间的作业';
    const lines = items.slice(0, 8).map((it) => `· ${it.title}\n  ${fmt(it.dueAt)}${it.course ? '  ' + it.course : ''}`);
    if (items.length > 8) lines.push(`… 共 ${items.length} 条`);
    return lines.join('\n');
  }

  async function doSync(previewOnly) {
    if (state.busy) return;
    state.busy = true;
    setMessage('正在读取…');

    try {
      if (!FT_TOKEN) {
        setMessage('还没配置令牌。\n去待办 → 设置 → 学习通同步 → 复制接入配置，\n替换脚本顶部 ① 区那两行。');
        return;
      }

      const alive = await ping();
      if (!alive || !alive.ok) {
        setMessage(`连不上待办程序。\n确认它开着，地址是 ${FT_ENDPOINT}`);
        return;
      }

      // 当前页 + 后台重拉的作业总表，合并去重
      const map = new Map();
      for (const it of collectFromDocument(document)) map.set(it.sourceKey, it);

      const listDoc = await fetchWorkListDoc();
      if (listDoc) {
        for (const it of collectFromDocument(listDoc)) map.set(it.sourceKey, it);
      }

      const items = Array.from(map.values());

      if (previewOnly) {
        setMessage(summarize(items));
        return;
      }
      if (!items.length) {
        if (listDoc && looksLikeLoginPage(listDoc)) {
          setMessage('学习通登录已过期。\n请在浏览器里重新登录学习通，再点一次同步。');
          return;
        }
        setMessage('没有待提交的作业。\n（已提交/已完成的会被跳过）\n确认你打开的是作业列表页。');
        return;
      }

      const res = await push(items);
      if (res.status === 200 && res.body && res.body.ok) {
        setMessage(
          `同步成功 ✔\n新增 ${res.body.created}，更新 ${res.body.updated}，跳过 ${res.body.skipped}`
        );
      } else if (res.status === 401) {
        setMessage('令牌不对，重新复制接入配置。');
      } else {
        setMessage(`同步失败：${(res.body && res.body.error) || res.status}`);
      }
    } catch (err) {
      setMessage('出错了：' + (err && err.message));
      console.error('[作业同步]', err);
    } finally {
      state.busy = false;
    }
  }

  // =========================================================================
  // 启动
  // =========================================================================
  GM_registerMenuCommand('⚙ 设置接入地址与令牌', () => {
    const ep = prompt('待办接入地址（形如 http://127.0.0.1:45870）', FT_ENDPOINT);
    if (ep) {
      FT_ENDPOINT = ep.trim().replace(/\/+$/, '');
      GM_setValue('ft_endpoint', FT_ENDPOINT);
    }
    const tk = prompt('接入令牌', FT_TOKEN);
    if (tk) {
      FT_TOKEN = tk.trim();
      GM_setValue('ft_token', FT_TOKEN);
    }
    setMessage('已保存，点「立即同步」试试。');
  });

  GM_registerMenuCommand('🔄 立即同步一次', () => doSync(false));
  GM_registerMenuCommand('👀 预览抓到的内容', () => doSync(true));

  ensurePanel();
  setMessage(FT_TOKEN ? '准备就绪，点「预览」看看抓到什么' : '还没配置令牌，先看设置页「学习通同步」');

  setTimeout(() => doSync(false), 2500);
  setInterval(() => doSync(false), AUTO_SYNC_MS);

  console.log('[作业同步] loaded on', location.href);
})();
