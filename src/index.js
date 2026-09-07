import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000);
const app = express();
app.use(express.json({ limit: '10mb' }));

const devices = new Map();
const dashboard = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spark × Godot Gateway</title><style>body{font-family:system-ui,Segoe UI,sans-serif;background:#0b1020;color:#eef2ff;margin:0;padding:28px}.wrap{max-width:860px;margin:auto}.card{background:#141b31;border:1px solid #293253;border-radius:18px;padding:22px;margin:14px 0}.pill{display:inline-flex;padding:7px 12px;border-radius:999px;background:#202a49}.ok{color:#7ee787}.bad{color:#ff7b72}code{background:#0b1020;padding:4px 7px;border-radius:6px;word-break:break-all}.muted{color:#a8b1c7}button{border:0;border-radius:10px;padding:10px 14px;background:#5567ff;color:white;cursor:pointer}</style></head><body><div class="wrap"><h1>Spark × Godot Gateway</h1><div class="card"><div>الحالة: <span id="status" class="pill">جاري الفحص...</span></div><div class="muted" style="margin-top:10px">اتصال Godot يتم من جهازك إلى Railway عبر WSS. لا يتم كشف 127.0.0.1 على الإنترنت.</div></div><div class="card"><h2>MCP Endpoint</h2><code id="mcp"></code></div><div class="card"><h2>الجهاز</h2><div id="device">غير متصل</div></div><div class="card"><button onclick="location.reload()">تحديث</button></div></div><script>async function refresh(){try{const r=await fetch('/health');const j=await r.json();document.getElementById('status').textContent=j.godotConnected?'🟢 متصل':'🔴 غير متصل';document.getElementById('status').className='pill '+(j.godotConnected?'ok':'bad');document.getElementById('device').textContent=j.deviceId||'غير متصل';document.getElementById('mcp').textContent=location.origin+'/mcp'}catch(e){document.getElementById('status').textContent='تعذر الفحص'}} refresh();setInterval(refresh,3000)</script></body></html>`;

function authorized(req) {
  if (!DEVICE_TOKEN) return false;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${DEVICE_TOKEN}`;
}

app.get('/', (_req, res) => res.type('html').send(dashboard));
app.get('/health', (_req, res) => {
  const first = devices.values().next().value;
  res.json({ ok: true, server: 'spark-godot-gateway', godotConnected: devices.size > 0, deviceId: first?.deviceId || null, devices: devices.size });
});
app.get('/device', (_req, res) => res.status(426).json({ error: 'Use WebSocket on /device' }));

app.post('/mcp', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const deviceId = String(req.headers['x-device-id'] || '').trim();
  const entry = deviceId ? devices.get(deviceId) : devices.values().next().value;
  if (!entry || entry.ws.readyState !== WebSocket.OPEN) return res.status(503).json({ error: 'No Godot connector connected' });

  const id = crypto.randomUUID();
  const timeout = setTimeout(() => {
    const pending = entry.pending.get(id);
    if (pending) { entry.pending.delete(id); pending.reject(new Error('Godot request timed out')); }
  }, REQUEST_TIMEOUT_MS);

  try {
    const payload = { type: 'mcp_request', id, method: req.body?.method, body: req.body, headers: { accept: String(req.headers.accept || 'application/json, text/event-stream'), 'content-type': 'application/json' } };
    const result = await new Promise((resolve, reject) => entry.pending.set(id, { resolve, reject, timeout }));
    clearTimeout(timeout);
    res.status(result.status || 200);
    if (result.contentType) res.setHeader('content-type', result.contentType);
    res.setHeader('cache-control', 'no-cache');
    res.send(result.body ?? '');
  } catch (err) {
    clearTimeout(timeout);
    res.status(504).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/device') { socket.destroy(); return; }
  if (!authorized(req)) { socket.write('HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\n\\r\\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const deviceId = String(new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).searchParams.get('device') || crypto.randomUUID());
  const previous = devices.get(deviceId);
  if (previous?.ws && previous.ws.readyState === WebSocket.OPEN) previous.ws.close(1000, 'replaced');
  const entry = { ws, deviceId, pending: new Map() };
  devices.set(deviceId, entry);
  ws.send(JSON.stringify({ type: 'bridge_ready', deviceId }));
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'mcp_response') return;
      const p = entry.pending.get(msg.id);
      if (!p) return;
      entry.pending.delete(msg.id);
      clearTimeout(p.timeout);
      if (msg.ok === false) p.reject(new Error(msg.error || 'Local MCP request failed'));
      else p.resolve({ status: msg.status || 200, contentType: msg.contentType, body: msg.body || '' });
    } catch { /* ignore malformed frames */ }
  });
  ws.on('close', () => { if (devices.get(deviceId) === entry) devices.delete(deviceId); for (const p of entry.pending.values()) { clearTimeout(p.timeout); p.reject(new Error('Godot connector disconnected')); } entry.pending.clear(); });
  ws.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => console.log(`Gateway listening on ${PORT}`));
