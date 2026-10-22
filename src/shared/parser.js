/**
 * 「明天10点交报告」→ { title:'交报告', dueAt:'...', allDay:false }
 *
 * 设计原则：宁可不识别，也不猜错。
 * - 只有命中明确的日期/时刻/重复/优先级词，才改动结果；
 * - 任何歧义或未命中，整句原样作为标题，绝不把标题里的数字当时间。
 *
 * 纯本地规则，不联网、不依赖任何库。
 */
(function (root) {
  'use strict';

  const CN_NUM = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

  const WEEKDAY_CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 七: 0 };
  const WEEKDAY_EN = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };

  function cnToInt(str) {
    if (str == null) return NaN;
    const s = String(str).trim();
    if (!s) return NaN;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s === '十') return 10;
    if (s.length === 1) return CN_NUM[s] !== undefined ? CN_NUM[s] : NaN;
    if (s[0] === '十') {
      const rest = CN_NUM[s[1]];
      return rest === undefined ? NaN : 10 + rest;
    }
    if (s[1] === '十') {
      const tens = CN_NUM[s[0]];
      if (tens === undefined) return NaN;
      const ones = s[2] !== undefined ? CN_NUM[s[2]] : 0;
      return ones === undefined ? NaN : tens * 10 + ones;
    }
    return NaN;
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addDays(d, n) {
    const next = new Date(d.getTime());
    next.setDate(next.getDate() + n);
    return next;
  }

  /** 把命中的片段从字符串里挖掉（保留长度，最后统一收尾） */
  function cut(str, start, len) {
    return str.slice(0, start) + ' '.repeat(len) + str.slice(start + len);
  }

  function cleanTitle(str) {
    return str
      .replace(/[ \t\u3000]+/g, ' ')
      .replace(/\s*([，,、。；;：:])\s*/g, '$1')
      .replace(/^[\s，,、。；;：:]+/, '')
      .replace(/[\s，,、。；;：:]+$/, '')
      .trim();
  }

  const PREFIX_RE = /^(?:请|帮我|提醒我|提醒一下|提醒|记得|别忘了|我要|需要)[\s,，:：]*/;

  function parse(raw, nowInput) {
    const now = nowInput instanceof Date ? nowInput : new Date();
    const original = String(raw == null ? '' : raw);
    const result = {
      title: original.trim(),
      dueAt: null,
      allDay: false,
      priority: 0,
      repeat: null,
      matched: false
    };

    if (!result.title) return result;

    let rest = result.title;

    let dayOffset = null; // 相对今天
    let explicitDate = null; // { y, m, d }
    let weekdayDelta = null;
    let hour = null;
    let minute = 0;
    let period = null; // 时段
    let repeat = null;
    let priority = 0;

    // ------------------------------------------------------------------
    // 1. 重复
    // ------------------------------------------------------------------
    let m = rest.match(/(每)(\d{1,2})?(天|日)/);
    if (m) {
      repeat = { unit: 'day', interval: m[2] ? Math.max(1, parseInt(m[2], 10)) : 1 };
      rest = cut(rest, m.index, m[0].length);
    }
    if (!repeat) {
      m = rest.match(/每(?:个)?(周|星期|礼拜)([一二三四五六日天])?/);
      if (m) {
        repeat = { unit: 'week', interval: 1 };
        if (m[2]) {
          const wd = WEEKDAY_CN[m[2]];
          if (wd !== undefined) {
            const today = startOfDay(now);
            let delta = (wd - today.getDay() + 7) % 7;
            if (delta === 0) delta = 7;
            weekdayDelta = delta;
          }
        }
        rest = cut(rest, m.index, m[0].length);
      }
    }
    if (!repeat) {
      m = rest.match(/每(?:个)?月(\d{1,2})?[日号]?/);
      if (m) {
        repeat = { unit: 'month', interval: 1 };
        rest = cut(rest, m.index, m[0].length);
      }
    }
    if (!repeat) {
      m = rest.match(/每个?工作日|工作日每天|法定工作日/);
      // 也支持句首裸写「工作日 早上9点 打卡」（不用「每」字）
      if (!m) m = rest.match(/^工作日\s*/);
      if (m) {
        repeat = { unit: 'weekday', interval: 1 };
        rest = cut(rest, m.index, m[0].length);
      }
    }

    // ------------------------------------------------------------------
    // 2. 今/明/后天（含「今晚」「明早」这种带时段的写法）
    // ------------------------------------------------------------------
    const DAY_WORDS = [
      { re: /大后天/, offset: 3 },
      { re: /后天/, offset: 2 },
      { re: /明天|明日|明儿/, offset: 1 },
      { re: /今天|今日|今儿/, offset: 0 }
    ];

    const PERIOD_TAIL = [
      { re: /早上|早晨|清晨|一大早/, period: 'morning' },
      { re: /上午/, period: 'morning' },
      { re: /中午|晌午/, period: 'noon' },
      { re: /下午/, period: 'afternoon' },
      { re: /傍晚/, period: 'evening' },
      { re: /晚上|夜里|夜晚|晚间|今晚|明晚|夜里/, period: 'evening' },
      { re: /凌晨/, period: 'dawn' }
    ];

    // 「今晚」「明早」：先在日期词里拆出时段
    const combined = [
      { re: /今晚|今天晚上|今夜/, offset: 0, period: 'evening' },
      { re: /今早|今天早上|今天上午/, offset: 0, period: 'morning' },
      { re: /明晚|明天晚上|明夜/, offset: 1, period: 'evening' },
      { re: /明早|明天早上|明天上午/, offset: 1, period: 'morning' }
    ];
    for (const c of combined) {
      const mm = rest.match(c.re);
      if (mm) {
        if (dayOffset === null) dayOffset = c.offset;
        if (!period) period = c.period;
        rest = cut(rest, mm.index, mm[0].length);
        break;
      }
    }

    if (rest.includes('工作日') && !repeat) {
      // 「工作日」常被当成重复词，但也可能只是标题 —— 只在没有时间信息时忽略
    }

    if (dayOffset === null) {
      for (const w of DAY_WORDS) {
        const mm = rest.match(w.re);
        if (mm) {
          dayOffset = w.offset;
          rest = cut(rest, mm.index, mm[0].length);
          break;
        }
      }
    }

    // ------------------------------------------------------------------
    // 3. 周几 / 下周几
    // ------------------------------------------------------------------
    if (dayOffset === null && explicitDate === null && weekdayDelta === null) {
      const mm = rest.match(/(下下下|下下|下|本|这|这个)?\s*(?:周|星期|礼拜)([一二三四五六日天])/);
      if (mm) {
        const wd = WEEKDAY_CN[mm[2]];
        if (wd !== undefined) {
          const today = startOfDay(now);
          const downs = mm[1] ? (mm[1].match(/下/g) || []).length : 0;
          if (downs > 0) {
            // 「下周X」按周一为一周起点算，而不是简单 +7
            const fromMonday = (today.getDay() + 6) % 7;
            const nextWeekStart = addDays(today, -fromMonday + 7 + (downs - 1) * 7);
            const idx = (wd + 6) % 7;
            weekdayDelta = Math.round((addDays(nextWeekStart, idx).getTime() - today.getTime()) / 86400000);
          } else {
            weekdayDelta = (wd - today.getDay() + 7) % 7;
          }
          rest = cut(rest, mm.index, mm[0].length);
        }
      }
    }

    // ------------------------------------------------------------------
    // 4. 具体日期：3月5日 / 3月5号 / 5号 / 5日
    // ------------------------------------------------------------------
    if (dayOffset === null && weekdayDelta === null) {
      let mm = rest.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
      if (mm) {
        const month = parseInt(mm[1], 10);
        const day = parseInt(mm[2], 10);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          let year = now.getFullYear();
          const candidate = new Date(year, month - 1, day);
          if (candidate.getTime() < startOfDay(now).getTime()) year += 1;
          explicitDate = { y: year, m: month, d: day };
          rest = cut(rest, mm.index, mm[0].length);
        }
      } else {
        mm = rest.match(/(?:^|\s|(?<=[\u4e00-\u9fa5]))(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[日号]/);
        if (mm) {
          const day = cnToInt(mm[1]);
          if (Number.isFinite(day) && day >= 1 && day <= 31) {
            let month = now.getMonth();
            let year = now.getFullYear();
            if (day < now.getDate()) {
              month += 1;
              if (month > 11) {
                month = 0;
                year += 1;
              }
            }
            explicitDate = { y: year, m: month + 1, d: day };
            rest = cut(rest, mm.index + mm[0].indexOf(mm[1]), mm[1].length + 1);
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // 5. 时段词（必须在时刻之前吃掉，避免「下午」残留）
    // ------------------------------------------------------------------
    if (!period) {
      for (const p of PERIOD_TAIL) {
        const mm = rest.match(p.re);
        if (mm) {
          period = p.period;
          rest = cut(rest, mm.index, mm[0].length);
          break;
        }
      }
    }

    // ------------------------------------------------------------------
    // 6. 时刻：10:30 / 10点 / 十点半 / 8点一刻
    // ------------------------------------------------------------------
    m = rest.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (m) {
      const h = parseInt(m[1], 10);
      const mi = parseInt(m[2], 10);
      if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) {
        hour = h;
        minute = mi;
        rest = cut(rest, m.index, m[0].length);
      }
    }

    if (hour === null) {
      m = rest.match(/(\d{1,2}|[一二三四五六七八九十]{1,3})\s*点\s*(半|一刻|三刻|(\d{1,2})\s*分?)?/);
      if (m) {
        const h = cnToInt(m[1]);
        if (Number.isFinite(h) && h >= 0 && h <= 24) {
          hour = h;
          if (m[2] === '半') minute = 30;
          else if (m[2] === '一刻') minute = 15;
          else if (m[2] === '三刻') minute = 45;
          else if (m[3]) minute = parseInt(m[3], 10);
          if (minute > 59) minute = 0;
          rest = cut(rest, m.index, m[0].length);
        }
      }
    }

    // 时段修正小时
    if (hour !== null) {
      if (hour === 24) hour = 0;
      if (period === 'afternoon' || period === 'evening') {
        if (hour < 12) hour += 12;
      } else if (period === 'noon') {
        if (hour < 6) hour += 12;
      } else if (period === 'dawn') {
        if (hour === 12) hour = 0;
      } else if (period === 'morning') {
        if (hour === 12) hour = 0;
      }
    }

    // 只说了时段没说几点（「明天中午」「今晚」）→ 给一个符合直觉的默认时刻
    if (hour === null && period) {
      const PERIOD_DEFAULT = { dawn: 6, morning: 9, noon: 12, afternoon: 15, evening: 20 };
      hour = PERIOD_DEFAULT[period];
      minute = 0;
    }

    // ------------------------------------------------------------------
    // 7. 优先级
    // ------------------------------------------------------------------
    const bang = rest.match(/[!！]{1,3}/);
    if (bang) {
      priority = Math.min(3, bang[0].length);
      rest = cut(rest, bang.index, bang[0].length);
    } else {
      const kw = rest.match(/紧急|非常急|很重要|重要|高优先|低优先/);
      if (kw) {
        if (/紧急|非常急|很重要/.test(kw[0])) priority = 3;
        else if (/重要|高优先/.test(kw[0])) priority = 2;
        else priority = 1;
        rest = cut(rest, kw.index, kw[0].length);
      }
    }

    // ------------------------------------------------------------------
    // 8. 组装
    // ------------------------------------------------------------------
    let date = null;
    if (explicitDate) {
      date = new Date(explicitDate.y, explicitDate.m - 1, explicitDate.d);
    } else if (dayOffset !== null) {
      date = addDays(startOfDay(now), dayOffset);
    } else if (weekdayDelta !== null) {
      date = addDays(startOfDay(now), weekdayDelta);
    }

    const hasTime = hour !== null;
    const hasDate = date !== null;

    if (hasDate && hasTime) {
      date.setHours(hour, minute, 0, 0);
      result.dueAt = date.toISOString();
      result.allDay = false;
    } else if (hasDate) {
      date.setHours(23, 59, 0, 0);
      result.dueAt = date.toISOString();
      result.allDay = true;
    } else if (hasTime) {
      const d = startOfDay(now);
      d.setHours(hour, minute, 0, 0);
      if (d.getTime() <= now.getTime()) {
        d.setDate(d.getDate() + 1);
      }
      result.dueAt = d.toISOString();
      result.allDay = false;
    }

    result.repeat = repeat;
    result.priority = priority;

    let title = cleanTitle(rest).replace(PREFIX_RE, '');
    title = cleanTitle(title);
    if (!title) title = cleanTitle(original);

    result.title = title;
    result.matched = !!(result.dueAt || repeat || priority > 0);
    return result;
  }

  function humanDue(iso, allDay, nowInput) {
    if (!iso) return '';
    const now = nowInput instanceof Date ? nowInput : new Date();
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';

    const today = startOfDay(now);
    const day = startOfDay(d);
    const diff = Math.round((day.getTime() - today.getTime()) / 86400000);

    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    let dayText;
    if (diff === 0) dayText = '今天';
    else if (diff === 1) dayText = '明天';
    else if (diff === 2) dayText = '后天';
    else if (diff === -1) dayText = '昨天';
    else if (diff < 0 && diff > -7) dayText = `${-diff} 天前`;
    else if (diff > 0 && diff < 7) dayText = weekNames[day.getDay()];
    else dayText = `${d.getMonth() + 1}月${d.getDate()}日`;

    return allDay ? dayText : `${dayText} ${hm}`;
  }

  const API = { parse, humanDue, cnToInt, startOfDay, addDays };

  root.FTParser = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
