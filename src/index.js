import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000);

const app = express();
app.use(express.raw({ type: '*/*', limit: '25mb' }));

const devices = new Map();

function bearerMatches(req) {
  if (!DEVICE_TOKEN) return false;
  return req.headers.authorization === `Bearer ${DEVICE_TOKEN}`;
}

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

const dashboard = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spark × Godot Gateway</title><style>body{font-family:system-ui,Segoe UI,sans-serif;background:#0b1020;color:#eef2ff;margin:0;padding:28px}.wrap{max-width:900px;margin:auto}.card{background:#141b31;border:1px solid #293253;border-radius:18px;padding:22px;margin:14px 0}.ok{color:#7ee787}.bad{color:#ff7b72}code{background:#0b1020;padding:4px 7px;border-radius:6px;word-break:break-all}.muted{color:#a8b1c7}</style></head><body><div class="wrap"><h1>Spark × Godot Gateway</h1><div class="card"><div>Godot: <strong id="status">...</strong></div><div class="muted" style="margin-top:10px">Railway يعمل كـTransparent MCP Gateway. 127.0.0.1 يظل محليًا على جهازك.</div></div><div class="card"><h2>MCP Endpoint</h2><code id="mcp"></code></div><div class="card"><h2>الأجهزة</h2><pre id="devices">...</pre></div></div><script>async function r(){try{const x=await (await fetch('/health')).json();document.querySelector('#status').textContent=x.godotConnected?'🟢 متصل':'🔴 غير متصل';document.querySelector('#status').className=x.godotConnected?'ok':'bad';document.querySelector('#devices').textContent=JSON.stringify(x.devicesInfo,null,2);document.querySelector('#mcp').textContent=location.origin+'/mcp'}catch(e){}}r();setInterval(r,3000)</script></body></html>`;

app.get('/', (_req, res) => res.type('html').send(dashboard));
app.get('/health', (_req, res) => {
  const devicesInfo = [...devices.values()].map(d => ({ deviceId: d.deviceId, state: d.ws.readyState === WebSocket.OPEN ? 'connected' : 'closed' }));
  res.json({ ok: true, server: 'spark-godot-transparent-gateway', godotConnected: devices.size > 0, devices: devices.size, devicesInfo });
});
app.get('/device', (_req, res) => sendJson(res, 426, { error: 'Use WebSocket on /device' }));

function selectedDevice(req) {
  const explicit = String(req.headers['x-device-id'] || '').trim();
  if (explicit && devices.has(explicit)) return devices.get(explicit);
  return devices.values().next().value;
}

app.all('/mcp', async (req, res) => {
  const entry = selectedDevice(req);
  if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
    return sendJson(res, 503, { error: 'No Godot MCP bridge connected' });
  }

  const requestId = crypto.randomUUID();
  const method = req.method.toUpperCase();
  const body = req.body?.length ? req.body.toString('utf8') : null;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'content-length'].includes(k)) continue;
    if (Array.isArray(v)) headers[k] = v.join(', '); else if (v !== undefined) headers[k] = String(v);
  }

  let settled = false;
  let timer;

  const result = await new Promise((resolve, reject) => {
    const pending = { resolve, reject, res, method, timer: null };
    pending.timer = setTimeout(() => {
      if (entry.pending.get(requestId) !== pending) return;
      entry.pending.delete(requestId);
      reject(new Error('Bridge request timed out'));
    }, REQUEST_TIMEOUT_MS);
    entry.pending.set(requestId, pending);

    const packet = { type: 'http_request', id: requestId, method, path: req.originalUrl, headers, body };
    try {
      entry.ws.send(JSON.stringify(packet));
    } catch (err) {
      clearTimeout(pending.timer);
      entry.pending.delete(requestId);
      reject(err);
    }
  }).catch(err => ({ error: err instanceof Error ? err.message : String(err) }));

  if (result?.error) return sendJson(res, 504, { error: result.error });

  for (const [k, v] of Object.entries(result.headers || {})) {
    if (k.toLowerCase() === 'transfer-encoding') continue;
    try { res.setHeader(k, v); } catch { /* ignore malformed header */ }
  }
  if (result.status) res.statusCode = result.status;
  if (result.bodyBase64) {
    res.end(Buffer.from(result.bodyBase64, 'base64'));
  } else {
    res.end(result.body || '');
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/device') return socket.destroy();
  if (!bearerMatches(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const deviceId = String(url.searchParams.get('device') || crypto.randomUUID());
  const previous = devices.get(deviceId);
  if (previous?.ws?.readyState === WebSocket.OPEN) previous.ws.close(1000, 'replaced');
  const entry = { ws, deviceId, pending: new Map() };
  devices.set(deviceId, entry);
  ws.send(JSON.stringify({ type: 'bridge_ready', deviceId }));

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'http_response') return;
      const pending = entry.pending.get(msg.id);
      if (!pending) return;
      entry.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(msg);
    } catch {
      // ignore malformed bridge frames
    }
  });

  ws.on('close', () => {
    if (devices.get(deviceId) === entry) devices.delete(deviceId);
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Godot bridge disconnected'));
    }
    entry.pending.clear();
  });
  ws.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => console.log(`Transparent MCP gateway listening on ${PORT}`));
