/**
 * 书签脚本（bookmarklet）的源码。
 *
 * 由 scripts/make-bookmarklet.js 读取本文件，注入真实的地址和令牌，
 * 生成一个可以拖到书签栏的链接。
 *
 * 和油猴脚本的区别：
 * - 不用装任何扩展，任何浏览器都能用；
 * - 只能「点一下同步一次」，不会自动轮询。
 *
 * 占位符：__ENDPOINT__ / __TOKEN__（生成时替换）
 */
(function () {
  var EP = '__ENDPOINT__';
  var TK = '__TOKEN__';

  var COUNTDOWN_RE = /剩余\s*((?:\d+\s*天)?\s*(?:\d+\s*小时)?\s*(?:\d+\s*分钟)?)/;
  var STATUS_RE = /未提交|已提交|已完成|待批阅|已批阅|未开始|已结束|已过期/g;
  var ABS_PATTERNS = [
    /(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})[日]?\s*(\d{1,2})\s*[:：]\s*(\d{2})/,
    /(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})[日]?/,
    /(\d{1,2})[-\/月](\d{1,2})[日]?\s*(\d{1,2})\s*[:：](\d{2})/
  ];

  function txt(n) {
    return (n && n.textContent ? n.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function parseCountdown(s) {
    var m = String(s || '').match(COUNTDOWN_RE);
    if (!m || !m[1]) return null;
    var seg = m[1];
    var day = /(\d+)\s*天/.exec(seg);
    var hour = /(\d+)\s*小时/.exec(seg);
    var min = /(\d+)\s*分钟/.exec(seg);
    var ms = ((day ? +day[1] : 0) * 86400 + (hour ? +hour[1] : 0) * 3600 + (min ? +min[1] : 0) * 60) * 1000;
    if (ms <= 0) return null;
    return new Date(Date.now() + ms).toISOString();
  }

  function parseAbsolute(s) {
    var m = s.match(ABS_PATTERNS[0]);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0).toISOString();
    m = s.match(ABS_PATTERNS[1]);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 0, 0).toISOString();
    m = s.match(ABS_PATTERNS[2]);
    if (m) {
      var y = new Date().getFullYear();
      var d = new Date(y, +m[1] - 1, +m[2], +m[3], +m[4], 0, 0);
      if (d.getTime() < Date.now() - 180 * 864e5) d.setFullYear(y + 1);
      return d.toISOString();
    }
    return null;
  }

  function extractTitle(blockText, course) {
    var s = blockText;
    if (course) s = s.split(course).join(' ');
    s = s.replace(/《[^》]*》/g, ' ');
    s = s.replace(/剩余\s*(?:\d+\s*天)?\s*(?:\d+\s*小时)?\s*(?:\d+\s*分钟)?/g, ' ');
    s = s.replace(STATUS_RE, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^(作业|考试|测验|讨论|章节测验|任务点)\s*/, '').trim();
    return s.slice(0, 200);
  }

  function collect() {
    var map = {};

    // 策略 A：倒计时节点（作业总表 stu-work 就是这种）
    var nodes = document.querySelectorAll('*');
    var used = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var t = txt(el);
      if (t.length > 32 || t.indexOf('剩余') !== 0) continue;
      var dueAt = parseCountdown(t);
      if (!dueAt) continue;

      var box = el.parentElement;
      var depth = 0;
      var target = null;
      while (box && depth < 8) {
        var bt = txt(box);
        if (bt.length > 400) break;
        if (/《[^》]+》/.test(bt)) {
          target = box;
          break;
        }
        box = box.parentElement;
        depth++;
      }
      if (!target || used.indexOf(target) >= 0) continue;
      used.push(target);

      var block = txt(target);
      var cm = block.match(/《([^》]+)》/);
      var course = cm ? cm[1].replace(/[…\.\s]+$/, '').trim() : '';

      // 已提交/已完成的一样带倒计时，必须按状态排除
      var st = block.match(STATUS_RE);
      if (st && /已提交|已完成|已批阅|待批阅|已结束|已过期/.test(st.join(' '))) continue;

      var title = extractTitle(block, course);
      if (!title) continue;

      var key = 'cx:' + (course || 'x') + ':' + title;
      map[key] = {
        sourceKey: key,
        title: title,
        course: course || null,
        dueAt: dueAt,
        url: location.href
      };
    }

    // 策略 B：带 work/exam 链接的条目
    var links = document.querySelectorAll('a[href]');
    for (var j = 0; j < links.length; j++) {
      var a = links[j];
      var at = txt(a);
      if (!at || at.length > 120) continue;
      var href = a.getAttribute('href') || '';
      if (!/work|exam|task|homework|quiz/.test(href.toLowerCase()) && !/作业|考试|测验|测试/.test(at)) continue;

      var b2 = a.parentElement;
      var d2 = 0;
      var due2 = null;
      var text2 = '';
      while (b2 && d2 < 8) {
        var bt2 = txt(b2);
        if (bt2.length > 400) break;
        var cand = parseCountdown(bt2) || parseAbsolute(bt2);
        if (cand) {
          due2 = cand;
          text2 = bt2;
          break;
        }
        b2 = b2.parentElement;
        d2++;
      }
      if (!due2) continue;

      var cm2 = text2.match(/《([^》]+)》/);
      var course2 = cm2 ? cm2[1].replace(/[…\.\s]+$/, '').trim() : '';
      var key2 = 'cx:' + (course2 || 'x') + ':' + at;
      if (map[key2]) continue;
      map[key2] = {
        sourceKey: key2,
        title: at.slice(0, 200),
        course: course2 || null,
        dueAt: due2,
        url: href.indexOf('http') === 0 ? href.slice(0, 500) : null
      };
    }

    return Object.keys(map).map(function (k) {
      return map[k];
    });
  }

  var items = collect();
  if (!items.length) {
    var hints = [];
    hints.push('这一页没找到带「截止时间 / 剩余X小时Y分钟」的作业。');
    hints.push('');
    hints.push('建议直接在下面这个页面点我：');
    hints.push('https://mooc1-api.chaoxing.com/work/stu-work');
    alert(hints.join('\n'));
    return;
  }

  fetch(EP + '/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FT-Token': TK },
    body: JSON.stringify({ items: items })
  })
    .then(function (r) {
      return r.json().then(function (j) {
        return { status: r.status, body: j };
      });
    })
    .then(function (res) {
      if (res.status === 200 && res.body.ok) {
        alert(
          '同步成功 ✔\n\n找到 ' +
            items.length +
            ' 条\n新增 ' +
            res.body.created +
            ' 条，更新 ' +
            res.body.updated +
            ' 条，跳过 ' +
            res.body.skipped +
            ' 条'
        );
      } else if (res.status === 401) {
        alert('令牌不对，请用设置页的「复制接入配置」重新生成书签。');
      } else {
        alert('同步失败：' + ((res.body && res.body.error) || res.status));
      }
    })
    .catch(function (err) {
      alert(
        '连不上悬浮待办。\n\n确认：\n1. 程序正在运行（屏幕上有那颗球）\n2. 地址是 ' +
          EP +
          '\n\n错误：' +
          err.message
      );
    });
})();
