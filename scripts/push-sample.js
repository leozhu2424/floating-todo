/**
 * 往「正在运行」的悬浮待办推一批假的学通作业，验证整条链路。
 * 令牌和端口直接从 %APPDATA%\FloatingTodo\todos.json 里读。
 *
 * 用法：node scripts/push-sample.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const dataFile = path.join(process.env.APPDATA || '', 'FloatingTodo', 'todos.json');
if (!fs.existsSync(dataFile)) {
  console.error('找不到 ' + dataFile + '，先启动一次程序');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const port = state.settings.ingestPort;
const token = state.settings.ingestToken;

if (!token) {
  console.error('还没有令牌，先启动一次程序让它生成');
  process.exit(1);
}

// 造两个未来的截止时间
const inDays = (n, h, m) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const items = [
  {
    sourceKey: 'cx:math:9001',
    title: '第三章 课后习题',
    course: '高等数学',
    dueAt: inDays(2, 23, 59),
    url: 'https://mooc1.chaoxing.com/work/9001'
  },
  {
    sourceKey: 'cx:phy:9002',
    title: '实验报告：单摆测重力加速度',
    course: '大学物理',
    dueAt: inDays(4, 18, 0),
    url: 'https://mooc1.chaoxing.com/work/9002'
  },
  {
    sourceKey: 'cx:eng:9003',
    title: '线上考试（限时 60 分钟）',
    course: '大学英语',
    dueAt: inDays(1, 9, 30)
  }
];

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/ingest',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'X-FT-Token': token
        }
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log(`推送到 127.0.0.1:${port}，共 ${items.length} 条…`);
  const r1 = await post({ items });
  console.log('第一次：', r1.status, r1.body);

  const r2 = await post({ items });
  console.log('第二次（应全部跳过）：', r2.status, r2.body);

  const changed = JSON.parse(JSON.stringify(items));
  changed[0].dueAt = inDays(3, 12, 0);
  const r3 = await post({ items: changed });
  console.log('改一条截止时间（应 updated=1）：', r3.status, r3.body);
})().catch((err) => {
  console.error('失败：', err.message);
  process.exit(1);
});
