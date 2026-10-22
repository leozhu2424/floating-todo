/**
 * 从 userscript 源码里抠出纯解析函数，用真实页面文案做断言。
 *
 * 为什么要「抠源码」而不是复制一份：复制一份就一定会和线上代码跑偏。
 * 这里直接读 chaoxing-sync.user.js 的函数体，测的就是将来真正跑的那份代码。
 *
 * 用法：node scripts/test-userscript-logic.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'userscript', 'chaoxing-sync.user.js');
const source = fs.readFileSync(SRC, 'utf8');

/** 从 startIndex 处的 `function name(` 开始，按大括号配平抠出整个函数体 */
function sliceFunction(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('找不到函数 ' + name);
  const braceStart = src.indexOf('{', at);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error('函数 ' + name + ' 括号不配平');
}

function sliceConst(src, name) {
  const re = new RegExp('const ' + name + '\\s*=\\s*([\\s\\S]*?);\\s*\\n');
  const m = src.match(re);
  if (!m) throw new Error('找不到常量 ' + name);
  return 'const ' + name + ' = ' + m[1] + ';';
}

const parts = [
  sliceConst(source, 'ABS_PATTERNS'),
  sliceConst(source, 'COUNTDOWN_RE'),
  sliceConst(source, 'STATUS_RE'),
  sliceFunction(source, 'parseCountdown'),
  sliceFunction(source, 'parseAbsolute'),
  sliceFunction(source, 'extractTitle'),
  sliceFunction(source, 'isDoneStatus')
].join('\n\n');

const sandbox = {};
// eslint-disable-next-line no-new-func
new Function('exports', parts + '\nexports.parseCountdown = parseCountdown; exports.parseAbsolute = parseAbsolute; exports.extractTitle = extractTitle; exports.isDoneStatus = isDoneStatus;')(sandbox);

const { parseCountdown, parseAbsolute, extractTitle, isDoneStatus } = sandbox;

let pass = 0;
let fail = 0;

function check(name, cond, got) {
  if (cond) {
    pass++;
    console.log('  ✔ ' + name);
  } else {
    fail++;
    console.log('  ✘ ' + name + (got !== undefined ? '  → ' + JSON.stringify(got) : ''));
  }
}

function nearHours(iso, hours, toleranceMin = 2) {
  if (!iso) return false;
  const diffMin = (Date.parse(iso) - Date.now()) / 60000;
  return Math.abs(diffMin - hours * 60) <= toleranceMin;
}

console.log('== 倒计时解析（截图里的真实文案）==');
check('剩余177小时5分钟 ≈ +177.08h', nearHours(parseCountdown('剩余177小时5分钟'), 177 + 5 / 60), parseCountdown('剩余177小时5分钟'));
check('剩余69小时6分钟 ≈ +69.1h', nearHours(parseCountdown('剩余69小时6分钟'), 69 + 6 / 60), parseCountdown('剩余69小时6分钟'));
check('剩余3天2小时 ≈ +74h', nearHours(parseCountdown('剩余3天2小时'), 74), parseCountdown('剩余3天2小时'));
check('剩余45分钟 ≈ +0.75h', nearHours(parseCountdown('剩余45分钟'), 0.75), parseCountdown('剩余45分钟'));
check('剩余0分钟 → 不产生截止时间', parseCountdown('剩余0分钟') === null, parseCountdown('剩余0分钟'));
check('已完成（没有倒计时）→ null', parseCountdown('已完成') === null);

console.log('');
console.log('== 标题清洗（截图里的 4 条）==');
check(
  'MOOC 练习',
  extractTitle('作业 2.7-2.8 MOOC练习 未提交 《电工学（26…》 剩余177小时5分钟', '电工学（26') === '2.7-2.8 MOOC练习',
  extractTitle('作业 2.7-2.8 MOOC练习 未提交 《电工学（26…》 剩余177小时5分钟', '电工学（26')
);
check(
  '数字示波器',
  extractTitle('作业 数字示波器 未提交 《大学物理实验…》 剩余69小时6分钟', '大学物理实验') === '数字示波器',
  extractTitle('作业 数字示波器 未提交 《大学物理实验…》 剩余69小时6分钟', '大学物理实验')
);
check(
  '扭摆',
  extractTitle('作业 扭摆 未提交 《大学物理实验…》 剩余69小时6分钟', '大学物理实验') === '扭摆',
  extractTitle('作业 扭摆 未提交 《大学物理实验…》 剩余69小时6分钟', '大学物理实验')
);
check(
  '第1章 章节测试',
  extractTitle('作业 第1章 章节测试 已完成 《电工学（26…》', '电工学（26') === '第1章 章节测试',
  extractTitle('作业 第1章 章节测试 已完成 《电工学（26…》', '电工学（26')
);

console.log('');
console.log('== 已完成/已提交的必须被排除（曾经漏掉，把做过的作业也导进来了）==');
check(
  '「已完成」判定为已完成',
  isDoneStatus('作业 第1章 章节测试 已完成 《电工学（26…》 剩余5小时3分钟') === true,
  isDoneStatus('作业 第1章 章节测试 已完成 《电工学（26…》 剩余5小时3分钟')
);
check(
  '「未提交」判定为未完成',
  isDoneStatus('作业 2.7-2.8 MOOC练习 未提交 《电工学（26…》 剩余177小时5分钟') === false,
  isDoneStatus('作业 2.7-2.8 MOOC练习 未提交 《电工学（26…》 剩余177小时5分钟')
);
check('「已提交」也要排除', isDoneStatus('作业 扭摆 已提交 《大学物理实验…》 剩余69小时') === true);
check('「待批阅」要排除', isDoneStatus('作业 扭摆 待批阅 《大学物理实验…》 剩余69小时') === true);
check('没有状态字样 → 保守地收入', isDoneStatus('作业 某作业 《某课程》 剩余1小时') === false);

console.log('');
console.log('== 绝对日期仍然可用（其它页面是这种写法）==');
const abs = parseAbsolute('2026-10-20 23:59');
check('2026-10-20 23:59 解析成功', abs && new Date(abs).getFullYear() === 2026, abs);
check('只有日期 → 当天 23:59', parseAbsolute('2026-12-01') && new Date(parseAbsolute('2026-12-01')).getHours() === 23);
check('乱七八糟的文字 → null', parseAbsolute('暂无截止时间') === null);

console.log('');
console.log(`通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
