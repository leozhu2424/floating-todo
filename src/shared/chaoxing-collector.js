'use strict';

/**
 * 学习通任务采集器（作业 / 考试 / 分组任务 / 随堂练习 通用）。
 *
 * 这个函数会被 toString() 之后注入到页面里执行，所以：
 * - 里面不能引用任何外部变量（闭包里的东西在页面上下文不存在）
 * - 只能用标准 DOM API
 *
 * 设计上刻意「不区分类型」，只认两个特征：
 *   1. 这一行里有《课程名》
 *   2. 这一行有截止时间（倒计时「剩余X小时」或绝对日期）——或者状态是已完成
 * 所以只要能同时在同一个页面上看到不同类型，就会一起收走。
 *
 * 三个已踩过的坑：
 * 1. 作业页的截止时间是「剩余X小时Y分钟」倒计时，不是绝对日期；
 * 2. 已提交/已完成**同样带倒计时**，必须按状态区分，不能只看有没有时间；
 * 3. 不同页面写法不一样（考试可能只有绝对日期），所以三种抓法并行再合并。
 */
function collectItems() {
  // 注意：任务列表页写的是「剩余:3天」，冒号是可选的
  var COUNTDOWN_RE = /剩余\s*[:：]?\s*((?:\d+\s*天)?\s*(?:\d+\s*小时)?\s*(?:\d+\s*分钟)?)/;
  var STATUS_RE = /未提交|已提交|已完成|待批阅|已批阅|未开始|已结束|已过期|待完成|进行中/;
  var DONE_RE = /已提交|已完成|已批阅|待批阅|已结束|已过期/;

  // 任务类型徽标：抓标题时要去掉
  var BADGE_RE = /^(作业|考试|测验|测试|练习|随堂练习|分组任务|小组任务|讨论|章节测验|章节练习|任务点)\s*/;

  var ABS_PATTERNS = [
    /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日]?\s*(\d{1,2})\s*[:：]\s*(\d{2})/,
    /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日]?/,
    /(\d{1,2})[-/月](\d{1,2})[日]?\s*(\d{1,2})\s*[:：](\d{2})/
  ];

  function text(node) {
    return (node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function parseCountdown(str) {
    var m = String(str || '').match(COUNTDOWN_RE);
    if (!m || !m[1]) return null;
    var seg = m[1];
    var day = /(\d+)\s*天/.exec(seg);
    var hour = /(\d+)\s*小时/.exec(seg);
    var min = /(\d+)\s*分钟/.exec(seg);
    var ms = ((day ? +day[1] : 0) * 86400 + (hour ? +hour[1] : 0) * 3600 + (min ? +min[1] : 0) * 60) * 1000;
    if (ms <= 0) return null;
    return new Date(Date.now() + ms).toISOString();
  }

  function parseAbsolute(str) {
    var m = str.match(ABS_PATTERNS[0]);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0).toISOString();
    m = str.match(ABS_PATTERNS[1]);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 0, 0).toISOString();
    m = str.match(ABS_PATTERNS[2]);
    if (m) {
      var y = new Date().getFullYear();
      var d = new Date(y, +m[1] - 1, +m[2], +m[3], +m[4], 0, 0);
      if (d.getTime() < Date.now() - 180 * 864e5) d.setFullYear(y + 1);
      return d.toISOString();
    }
    return null;
  }

  function isDone(blockText) {
    var m = String(blockText || '').match(STATUS_RE);
    if (!m) return false;
    return DONE_RE.test(m[0]);
  }

  function extractTitle(blockText, course) {
    var s = blockText;
    if (course) s = s.split(course).join(' ');
    s = s.replace(/《[^》]*》/g, ' ');
    s = s.replace(/剩余\s*(?:\d+\s*天)?\s*(?:\d+\s*小时)?\s*(?:\d+\s*分钟)?/g, ' ');
    // 绝对日期也要剥掉，否则标题里会挂着「2026-11-05 14:00」
    s = s.replace(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日]?(\s*\d{1,2}\s*[:：]\s*\d{2})?/g, ' ');
    s = s.replace(/(\d{1,2})[-/](\d{1,2})\s+(\d{1,2})[:：](\d{2})/g, ' ');
    s = s.replace(new RegExp(STATUS_RE.source, 'g'), ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(BADGE_RE, '').trim();
    return s.slice(0, 200);
  }

  var found = {};
  var used = [];
  var out = [];

  /** 从某个元素往上找，返回第一个同时含《课程名》的容器（限制在单行大小内） */
  function climbWithCourse(startEl) {
    var box = startEl;
    var depth = 0;
    while (box && depth < 8) {
      var bt = text(box);
      if (bt.length > 400) return null;
      if (/《[^》]+》/.test(bt)) return box;
      box = box.parentElement;
      depth++;
    }
    return null;
  }

  function consider(el, dueAt) {
    if (!el || used.indexOf(el) >= 0) return;
    var block = text(el);
    // 一行不可能太长；也不能同时出现两个课程名（那说明抓到的是整个列表）
    if (block.length > 300) return;
    var courseMarks = (block.match(/《/g) || []).length;
    if (courseMarks !== 1) return;

    var cm = block.match(/《([^》]+)》/);
    if (!cm) return;
    var course = cm[1].replace(/[…\.\s]+$/, '').trim();

    var title = extractTitle(block, course);
    if (!title || title.length < 2) return;

    var key = 'cx:' + (course || 'x') + ':' + title;
    if (found[key]) return;
    found[key] = 1;
    used.push(el);

    out.push({
      sourceKey: key,
      title: title,
      course: course || null,
      dueAt: dueAt || null,
      done: isDone(block),
      url: location.href
    });
  }

  var nodes = document.querySelectorAll('*');
  var i;

  // ⓿ 学习通「任务列表」页（/page/active/stuActiveList）：结构最规整，优先走这条
  //    每一行是 <li activeid="..." activetype="...">，标题在 .right-content p，
  //    时间在 .time，类型在 [aria-label]。用 activeid 当去重键最稳。
  var fallbackCourse =
    (typeof window !== 'undefined' && window.__FT_FALLBACK_COURSE__) || '';
  var rows = document.querySelectorAll('li[activeid]');

  for (i = 0; i < rows.length; i++) {
    var li = rows[i];
    var activeId = li.getAttribute('activeid');
    if (!activeId) continue;
    if (used.indexOf(li) >= 0) continue;

    var titleEl = li.querySelector('.right-content p') || li.querySelector('p');
    var rowTitle = titleEl ? text(titleEl) : '';
    if (!rowTitle) continue;

    var timeEl = li.querySelector('.time span') || li.querySelector('.time');
    var timeText = timeEl ? text(timeEl) : '';
    var rowDue = parseCountdown(timeText) || parseAbsolute(timeText);

    var rowText = text(li);

    // 签到这类是课堂内动作，做成待办没有意义，直接跳过
    if (/签到/.test(rowTitle)) continue;

    // 「结束时间：10-09 08:58」= 已结束的活动，别当待办创建
    var rowDone = /已完成|已结束|已批阅|已提交|结束时间/.test(rowText);

    // 既没有时间也不是已完成，跳过
    if (!rowDue && !rowDone) continue;

    var key0 = 'cx:active:' + activeId;
    if (found[key0]) continue;
    found[key0] = 1;
    used.push(li);

    out.push({
      sourceKey: key0,
      title: rowTitle.slice(0, 200),
      course: fallbackCourse || null,
      dueAt: rowDue || null,
      done: rowDone,
      url: location.href,
      // 随堂练习（42）在列表里永远不会变成「已完成」，要靠答题页确认，
      // 所以把活动 id/类型带出去给主进程用
      activeId: activeId,
      activeType: li.getAttribute('activetype') || '',
      activeStatus: li.getAttribute('activestatus') || ''
    });
  }

  // ① 倒计时写法（作业页）
  for (i = 0; i < nodes.length; i++) {
    var t1 = text(nodes[i]);
    if (t1.length > 32 || t1.indexOf('剩余') !== 0) continue;
    var d1 = parseCountdown(t1);
    if (!d1) continue;
    consider(climbWithCourse(nodes[i].parentElement), d1);
  }

  // ② 绝对日期写法（考试页常见）
  for (i = 0; i < nodes.length; i++) {
    var t2 = text(nodes[i]);
    if (t2.length > 44) continue;
    if (!/(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})|(\d{1,2}[-/月]\d{1,2}\s*\d{1,2}[:：]\d{2})/.test(t2)) continue;
    var d2 = parseAbsolute(t2);
    if (!d2) continue;
    consider(climbWithCourse(nodes[i].parentElement), d2);
  }

  // ③ 已完成但没有时间显示的行（用于自动打勾）
  for (i = 0; i < nodes.length; i++) {
    var t3 = text(nodes[i]);
    if (t3.length > 300) continue;
    if (!/《[^》]+》/.test(t3) || !isDone(t3)) continue;

    // 只取最小容器，父节点也满足就说明还没到行
    var pt = nodes[i].parentElement ? text(nodes[i].parentElement) : '';
    if (pt && pt.length <= 400 && /《[^》]+》/.test(pt) && isDone(pt)) continue;

    consider(nodes[i], null);
  }

  return out;
}

module.exports = {
  collectItems,
  /** 注入页面时执行的表达式 */
  SOURCE: '(' + collectItems.toString() + ')()'
};
