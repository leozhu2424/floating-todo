const P = require('../src/shared/parser.js');

const now = new Date('2026-10-18T15:00:00'); // 周六 15:00

const cases = [
  '明天10点交报告',
  '明天 10点 交报告',
  '周五开会',
  '每天8:00吃药',
  '交电费',
  '下午3点半开会',
  '3月5日交材料',
  '!!! 修 bug',
  '周末去超市',
  '今天晚上8点 看电影',
  '下周一 9点 汇报',
  '后天 大后天 测试',
  '半小时后出发',
  '买牛奶 2 盒',
  '每周一 10:00 例会',
  '工作日 早上9点 打卡',
  '记得 明天中午吃火锅',
  '10点',
  '十点半睡觉',
  '12/25 圣诞',
  '5号 交房租',
  '今晚',
  '明天'
];

for (const c of cases) {
  const r = P.parse(c, now);
  console.log(JSON.stringify({
    in: c,
    out: r.title,
    due: r.dueAt ? new Date(r.dueAt).toLocaleString('zh-CN', { hour12: false }) : null,
    allDay: r.allDay,
    prio: r.priority,
    repeat: r.repeat,
    matched: r.matched
  }));
}
