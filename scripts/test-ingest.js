/**
 * 本机接入服务的端到端测试（不依赖 Electron，直接跑 store + ingest）
 *
 * 覆盖：探活 / 令牌鉴权 / 空数据 / 非法 JSON / 新增 / 重复推送去重 /
 *       截止时间变更 / 已完成的不复活 / 字段清洗
 *
 * 用法：node scripts/test-ingest.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const { Store } = require('../src/main/store');
const { IngestServer } = require('../src/main/ingest');

const TMP = path.join(__dirname, '..', '.tmp-ingest');
const TOKEN = 'test-token-0123456789';

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✔ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✘ ${name}${extra ? ' → ' + JSON.stringify(extra) : ''}`);
  }
}

function request(port, { method = 'POST', p = '/api/ingest', token = TOKEN, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody != null ? rawBody : body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (payload != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers['X-FT-Token'] = token;

    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(buf);
        } catch (_) {
          parsed = buf;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const SAMPLE = [
  {
    sourceKey: 'cx:c1:w1001',
    title: '第三章 习题',
    course: '高等数学',
    dueAt: '2026-10-20T15:59:00.000Z',
    url: 'https://mooc1.chaoxing.com/work/1001'
  },
  {
    sourceKey: 'cx:c1:w1002',
    title: '实验报告一',
    course: '大学物理',
    dueAt: '2026-10-22T09:00:00.000Z',
    priority: 2
  },
  {
    // 没有截止时间的应被接受但保持无日期；没有 sourceKey 的会自动兜一个
    title: '课程视频：第五章',
    course: '线性代数'
  }
];

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const store = new Store(TMP);
  store.load();

  const server = new IngestServer({
    store,
    log: (m) => console.log('    [srv] ' + m)
  });

  const started = await server.start({ port: 45999, token: TOKEN });
  check('服务启动', started.ok === true, started);
  const port = started.port;

  // 1) 探活
  let r = await request(port, { method: 'GET', p: '/api/ping', token: null });
  check('GET /api/ping 不带令牌也能通', r.status === 200 && r.body.ok === true, r);

  // 2) 错误令牌
  r = await request(port, { token: 'wrong', body: { items: SAMPLE } });
  check('错误令牌返回 401', r.status === 401, r);

  // 3) 空 items
  r = await request(port, { body: { items: [] } });
  check('空 items 返回 400', r.status === 400, r);

  // 4) 非法 JSON
  r = await request(port, { rawBody: 'not-json{' });
  check('非法 JSON 返回 400', r.status === 400, r);

  // 5) 首次推送
  r = await request(port, { body: { items: SAMPLE } });
  check('首次推送 created=3', r.body.created === 3, r.body);
  check('store 里有 3 条', store.state.todos.length === 3, store.state.todos.length);

  const t1 = store.state.todos.find((t) => t.sourceKey === 'cx:c1:w1001');
  check('标题正确', t1 && t1.title === '第三章 习题', t1 && t1.title);
  check('课程名写入', t1 && t1.course === '高等数学', t1 && t1.course);
  check('截止时间解析正确', t1 && t1.dueAt === '2026-10-20T15:59:00.000Z', t1 && t1.dueAt);
  check('来源标记为 chaoxing', t1 && t1.source === 'chaoxing', t1 && t1.source);
  check('链接保留', t1 && t1.sourceUrl === 'https://mooc1.chaoxing.com/work/1001', t1 && t1.sourceUrl);

  const t3 = store.state.todos.find((t) => t.title === '课程视频：第五章');
  check('缺 sourceKey 的自动兜一个', !!(t3 && t3.sourceKey), t3 && t3.sourceKey);
  check('没有截止时间 → dueAt 为 null', t3 && t3.dueAt === null, t3 && t3.dueAt);

  // 6) 重复推送 → 全部跳过
  r = await request(port, { body: { items: SAMPLE } });
  check('重复推送 created=0 updated=0 skipped=3', r.body.created === 0 && r.body.updated === 0 && r.body.skipped === 3, r.body);
  check('重复推送后仍是 3 条', store.state.todos.length === 3, store.state.todos.length);

  // 7) 截止时间变了 → 更新 1 条
  const changed = JSON.parse(JSON.stringify(SAMPLE));
  changed[0].dueAt = '2026-10-21T15:59:00.000Z';
  r = await request(port, { body: { items: changed } });
  check('改截止时间 updated=1', r.body.updated === 1, r.body);
  const t1b = store.state.todos.find((t) => t.sourceKey === 'cx:c1:w1001');
  check('新截止时间已写入', t1b.dueAt === '2026-10-21T15:59:00.000Z', t1b.dueAt);
  check('仍是 3 条（没重复建）', store.state.todos.length === 3, store.state.todos.length);

  // 7b) 倒计时抖动：差 30 秒不应该算「更新」
  const jitter = JSON.parse(JSON.stringify(changed));
  jitter[0].dueAt = new Date(Date.parse(changed[0].dueAt) + 30 * 1000).toISOString();
  r = await request(port, { body: { items: jitter } });
  check('截止时间只差 30 秒 → 不更新（防抖）', r.body.updated === 0, r.body);

  // 7c) 真的改了 10 分钟以上 → 必须更新
  const realChange = JSON.parse(JSON.stringify(changed));
  realChange[0].dueAt = new Date(Date.parse(changed[0].dueAt) + 10 * 60 * 1000).toISOString();
  r = await request(port, { body: { items: realChange } });
  check('截止时间差 10 分钟 → 更新 1 条', r.body.updated === 1, r.body);

  // 8) 已完成的作业再推 → 不复活
  store.toggleTodo(t1b.id);
  check('手动标记完成', store.state.todos.find((t) => t.id === t1b.id).done === true);
  r = await request(port, { body: { items: changed } });
  check('已完成的不复活', r.body.created === 0 && r.body.updated === 0, r.body);
  check('完成状态保持', store.state.todos.find((t) => t.id === t1b.id).done === true);

  // 9) 学习通上完成了 → 对应待办自动打勾
  const beforeDone = store.state.todos.filter((t) => t.source === 'chaoxing');
  check('打勾前：有未完成的来源条目', beforeDone.some((t) => !t.done), beforeDone.length);

  const target = store.state.todos.find((t) => t.sourceKey === 'cx:c1:w1002');
  check('目标条目存在且未完成', !!target && target.done === false);

  r = await request(port, {
    body: {
      items: [
        { sourceKey: 'cx:c1:w1002', title: '实验报告一', course: '大学物理', dueAt: '2026-10-22T09:00:00.000Z', done: true }
      ]
    }
  });
  check('已完成标记让待办打勾 completed=1', r.body.completed === 1, r.body);
  const afterDone = store.state.todos.find((t) => t.sourceKey === 'cx:c1:w1002');
  check('条目已变成完成', afterDone.done === true, afterDone.done);
  check('completedAt 已写入', !!afterDone.completedAt, afterDone.completedAt);

  // 再推一次已完成的：不应重复处理
  r = await request(port, {
    body: { items: [{ sourceKey: 'cx:c1:w1002', title: '实验报告一', done: true }] }
  });
  check('重复推送已完成 → completed=0', r.body.completed === 0, r.body);

  // 学习通上已完成的「新作业」不应该被建进来
  const countBefore = store.state.todos.length;
  r = await request(port, {
    body: { items: [{ sourceKey: 'cx:c9:w9999', title: '历史已交作业', course: '某课', done: true }] }
  });
  check('已完成的陌生作业不新建', store.state.todos.length === countBefore, store.state.todos.length);
  check('且计入 skipped', r.body.skipped === 1, r.body);

  // 10) 脏数据清洗
  r = await request(port, {
    body: {
      items: [
        { sourceKey: 'cx:x:1', title: '  ' }, // 空标题 → 丢弃
        { sourceKey: 'cx:x:2', title: '正常', dangling: '<script>', dueAt: 'not-a-date' },
        null,
        'string'
      ]
    }
  });
  check('脏数据不崩，accepted=1', r.body.accepted === 1, r.body);
  const bad = store.state.todos.find((t) => t.sourceKey === 'cx:x:2');
  check('非法日期被丢弃为 null', bad && bad.dueAt === null, bad && bad.dueAt);

  // 10) 端口占用时自动换端口
  const a = new IngestServer({ store, log: () => {} });
  const b = new IngestServer({ store, log: () => {} });
  const ra = await a.start({ port: 46010, token: TOKEN });
  const rb = await b.start({ port: 46010, token: TOKEN });
  check('端口被占用时自动 +1', ra.ok && rb.ok && rb.port === 46011, { ra, rb });
  a.stop();
  b.stop();

  // 收尾
  server.stop();
  check('停止后端口释放', server.running === false);

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('');
  console.log(`通过 ${pass}，失败 ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('测试异常：', err);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
