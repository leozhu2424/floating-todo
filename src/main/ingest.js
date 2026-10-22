'use strict';

/**
 * 本机接入服务：给浏览器上的 Tampermonkey 脚本一个投递口。
 *
 * 安全设计（这是刻意收紧过的）：
 * - 只监听 127.0.0.1，外网 / 局域网都连不上；
 * - 必须带令牌（请求头 X-FT-Token、?token= 或 body.token 三者之一）；
 * - 只接受 POST /api/ingest，请求体上限 256KB，单次最多 500 条；
 * - 不读文件、不执行命令，只做白名单字段的清洗后交给 store。
 *
 * 端口被占用时自动往后试（最多 10 个），把实际端口回报给调用方。
 */

const http = require('http');

const MAX_BODY = 256 * 1024;
const MAX_ITEMS = 500;
const DEFAULT_PORT = 45870;

function clampText(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/** 把一条外部数据清洗成 store 认识的结构 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const title = clampText(raw.title, 200);
  if (!title) return null;

  let dueAt = null;
  if (raw.dueAt) {
    const t = Date.parse(raw.dueAt);
    if (Number.isFinite(t)) dueAt = new Date(t).toISOString();
  }

  // 没有 sourceKey 就用「课程 + 标题 + 截止时间」兜一个，保证同一作业不会重复建
  let sourceKey = clampText(raw.sourceKey, 200);
  if (!sourceKey) {
    sourceKey = `${clampText(raw.course, 60) || ''}|${title}|${dueAt || ''}`;
  }

  return {
    sourceKey,
    title,
    course: clampText(raw.course, 60),
    dueAt,
    allDay: !!raw.allDay,
    url: clampText(raw.url, 500),
    priority: [0, 1, 2, 3].includes(raw.priority) ? raw.priority : 0,
    // 浏览器脚本也能带上「已完成」标记，走和内置同步一样的打勾逻辑
    done: !!raw.done
  };
}

class IngestServer {
  constructor(options = {}) {
    this.store = options.store;
    this.log = options.log || (() => {});
    this.onIngest = options.onIngest || (() => {});

    this.server = null;
    this.port = null;
    this.token = '';
    this.lastAt = null;
    this.lastResult = null;
    this.requests = 0;
    this.rejected = 0;
  }

  get running() {
    return !!this.server;
  }

  info() {
    return {
      enabled: this.running,
      port: this.port,
      token: this.token,
      lastAt: this.lastAt,
      lastResult: this.lastResult,
      requests: this.requests,
      rejected: this.rejected
    };
  }

  start({ port, token }) {
    this.stop();
    this.token = String(token || '');

    if (!this.token) {
      this.log('[ingest] no token, refuse to start');
      return Promise.resolve({ ok: false, error: 'no token' });
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      const tryPort = (p, attempt) => {
        const srv = http.createServer((req, res) => {
          try {
            this._handle(req, res);
          } catch (err) {
            this.log('[ingest] handler error ' + (err && err.message));
            try {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end('{"ok":false,"error":"internal"}');
            } catch (_) {
              /* ignore */
            }
          }
        });

        srv.on('error', (err) => {
          if (err && err.code === 'EADDRINUSE' && attempt < 10) {
            tryPort(p + 1, attempt + 1);
            return;
          }
          this.log(`[ingest] listen failed on ${p}: ${err && err.message}`);
          done({ ok: false, error: err && err.message });
        });

        srv.listen(p, '127.0.0.1', () => {
          this.server = srv;
          this.port = p;
          this.log(`[ingest] listening http://127.0.0.1:${p}`);
          done({ ok: true, port: p });
        });
      };

      tryPort(Number(port) || DEFAULT_PORT, 0);
    });
  }

  stop() {
    if (this.server) {
      try {
        this.server.close();
      } catch (_) {
        /* ignore */
      }
      this.server = null;
      this.port = null;
    }
  }

  // -------------------------------------------------------------------------
  // 请求处理
  // -------------------------------------------------------------------------
  _handle(req, res) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, x-ft-token',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      // Chrome 的 Private Network Access：从公网页面访问 127.0.0.1 时要显式放行，
      // 否则请求会在预检阶段被浏览器拦掉（书签脚本方案依赖它）
      'Access-Control-Allow-Private-Network': 'true'
    };

    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
      });
      res.end(body);
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;

    // 探活：不需要令牌，方便脚本先确认程序开着
    if (req.method === 'GET' && path === '/api/ping') {
      send(200, { ok: true, app: 'floating-todo', api: 1, enabled: this.running });
      return;
    }

    if (path !== '/api/ingest') {
      send(404, { ok: false, error: 'not found' });
      return;
    }

    if (req.method !== 'POST') {
      send(405, { ok: false, error: 'method not allowed' });
      return;
    }

    const headerToken = req.headers['x-ft-token'];
    const queryToken = url.searchParams.get('token');

    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        this.rejected += 1;
        send(413, { ok: false, error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (size > MAX_BODY) return;

      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_) {
        this.rejected += 1;
        send(400, { ok: false, error: 'invalid json' });
        return;
      }

      const token = headerToken || queryToken || (payload && payload.token);
      if (!token || token !== this.token) {
        this.rejected += 1;
        this.log('[ingest] rejected: bad token');
        send(401, { ok: false, error: 'bad token' });
        return;
      }

      const rawItems = Array.isArray(payload && payload.items) ? payload.items : [];
      if (rawItems.length === 0) {
        send(400, { ok: false, error: 'no items' });
        return;
      }
      if (rawItems.length > MAX_ITEMS) {
        this.rejected += 1;
        send(413, { ok: false, error: `too many items (>${MAX_ITEMS})` });
        return;
      }

      const cleaned = [];
      for (const raw of rawItems) {
        const item = normalizeItem(raw);
        if (item) cleaned.push(item);
      }

      const result = this.store.upsertImported(cleaned, 'chaoxing');
      this.store.saveNow();

      this.requests += 1;
      this.lastAt = new Date().toISOString();
      this.lastResult = {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        completed: result.completed
      };

      this.log(
        `[ingest] ok in=${rawItems.length} cleaned=${cleaned.length} created=${result.created} updated=${result.updated} completed=${result.completed} skipped=${result.skipped}`
      );

      try {
        this.onIngest(result);
      } catch (_) {
        /* ignore */
      }

      send(200, {
        ok: true,
        received: rawItems.length,
        accepted: cleaned.length,
        created: result.created,
        updated: result.updated,
        completed: result.completed,
        skipped: result.skipped
      });
    });

    req.on('error', () => {
      /* 客户端断开，忽略 */
    });
  }
}

module.exports = { IngestServer, normalizeItem };
