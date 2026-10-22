/**
 * 采集器的集成测试：在真实的 Electron 窗口（有真 DOM）里跑一遍。
 *
 * 为什么不在 Node 里测：采集器依赖 document.querySelectorAll 等真实 DOM API，
 * 而项目里没有 jsdom。用 Electron 起一个隐藏窗口加载模拟页面，测的就是线上同一份代码。
 *
 * 用法：node_modules\electron\dist\electron.exe scripts\test-collector.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const { SOURCE } = require('../src/shared/chaoxing-collector');

const FIXTURE = path.join(__dirname, 'fixture-chaoxing.html');

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

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  if (!fs.existsSync(FIXTURE)) {
    console.error('找不到 fixture: ' + FIXTURE);
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { partition: 'persist:collector-test', contextIsolation: true }
  });

  try {
    await win.loadFile(FIXTURE);

    const items = await win.webContents.executeJavaScript(SOURCE, true);

    console.log(`== 采集结果（${items.length} 条）==`);
    for (const it of items) {
      const d = new Date(it.dueAt);
      const p = (n) => String(n).padStart(2, '0');
      console.log(
        `  · ${it.title}  |  ${it.course}  |  ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      );
    }
    console.log('');

    const titles = items.map((x) => x.title);
    const pending = items.filter((x) => !x.done);
    const doneItems = items.filter((x) => x.done);

    check('采到 9 条（6 条待办 + 3 条已完成）', items.length === 9, items.length);
    check('待办 6 条', pending.length === 6, pending.map((x) => x.title));
    check('已完成 3 条', doneItems.length === 3, doneItems.map((x) => x.title));

    check('含 2.7-2.8 MOOC练习', titles.indexOf('2.7-2.8 MOOC练习') >= 0, titles);
    check('含 数字示波器', titles.indexOf('数字示波器') >= 0, titles);
    check('含 扭摆', titles.indexOf('扭摆') >= 0, titles);
    check('含 考试：期中考试', titles.indexOf('期中考试') >= 0, titles);
    check('含 分组任务：小组调研报告', titles.indexOf('小组调研报告') >= 0, titles);
    check('含 随堂练习：第3节 随堂测验', titles.indexOf('第3节 随堂测验') >= 0, titles);

    const exam = pending.find((x) => x.title === '期中考试');
    check(
      '考试用绝对日期解析出截止时间（11-05 14:00）',
      exam &&
        new Date(exam.dueAt).getMonth() === 10 &&
        new Date(exam.dueAt).getDate() === 5 &&
        new Date(exam.dueAt).getHours() === 14,
      exam && exam.dueAt
    );
    check('分组任务课程名正确', (pending.find((x) => x.title === '小组调研报告') || {}).course === '市场营销');
    check('随堂练习按倒计时解析（≈12.5h）', (() => {
      const q = pending.find((x) => x.title === '第3节 随堂测验');
      return q && Math.abs((Date.parse(q.dueAt) - Date.now()) / 3600000 - 12.5) < 0.1;
    })());

    check('第1章 章节测试 标为已完成', doneItems.some((x) => x.title === '第1章 章节测试'), doneItems.map((x) => x.title));
    check('2.1-2.3 MOOC练习 标为已完成（待批阅）', doneItems.some((x) => x.title === '2.1-2.3 MOOC练习'), doneItems.map((x) => x.title));
    check('第2章 章节测试 靠状态兜底抓到（无倒计时）', doneItems.some((x) => x.title === '第2章 章节测试'), doneItems.map((x) => x.title));

    const first = items.find((x) => x.title === '2.7-2.8 MOOC练习');
    check('课程名正确', first && first.course === '电工学（26', first && first.course);
    check('sourceKey 稳定格式', first && first.sourceKey === 'cx:电工学（26:2.7-2.8 MOOC练习', first && first.sourceKey);
    check('待提交的 done=false', first && first.done === false, first && first.done);

    const hours = (Date.parse(first.dueAt) - Date.now()) / 3600000;
    check('倒计时换算成截止时间（≈177h）', Math.abs(hours - 177.08) < 0.1, hours.toFixed(2));

    check(
      '没有出现「剩余」「《》」残留',
      items.every((x) => x.title.indexOf('剩余') < 0 && x.title.indexOf('《') < 0),
      titles
    );

    console.log('');
    console.log(`通过 ${pass}，失败 ${fail}`);
  } catch (err) {
    console.error('测试异常：', err);
    fail++;
  }

  win.destroy();
  app.exit(fail > 0 ? 1 : 0);
});
