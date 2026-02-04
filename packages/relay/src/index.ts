import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { Envelope, ClientType, PairRequestResponse, PairPollResponse } from '@openclaw/shared';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

type PendingPair = {
  clientId: string;
  deviceCode: string;
  userCode: string;
  expiresAt: number;
  verified: boolean;
  token?: string;
};

const pending = new Map<string, PendingPair>(); // deviceCode -> entry
const byClient = new Map<string, PendingPair>(); // clientId -> entry

// Active websocket connections per token.
type Conn = { ws: WebSocket; client: ClientType; clientId: string };
const connsByToken = new Map<string, { extension?: Conn; agent?: Conn }>();

function rand(len = 16): string {
  return crypto.randomBytes(len).toString('hex');
}

function makeUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  return `${part()}-${part()}`;
}

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.type('text').send('OpenClaw Relay running.');
});

app.post('/pair/request', (req, res) => {
  const clientId = String(req.body?.clientId || '');
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  // create new
  const deviceCode = rand(16);
  const userCode = makeUserCode();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  const verificationUri = `${req.protocol}://${req.get('host')}/pair/verify`;
  const entry: PendingPair = { clientId, deviceCode, userCode, expiresAt, verified: false };

  pending.set(deviceCode, entry);
  byClient.set(clientId, entry);

  const out: PairRequestResponse = { clientId, deviceCode, userCode, verificationUri, expiresAt };
  res.json(out);
});

// One-click pairing confirmation for the same browser that initiated /pair/request.
// This removes the confusing "open another tab" step while preserving explicit user intent
// (the user has to click Pair in the extension).
app.post('/pair/confirm', (req, res) => {
  const clientId = String(req.body?.clientId || '');
  const deviceCode = String(req.body?.deviceCode || '');
  if (!clientId || !deviceCode) return res.status(400).json({ error: 'clientId and deviceCode required' });

  const entry = pending.get(deviceCode);
  if (!entry || entry.clientId !== clientId) return res.status(404).json({ error: 'not found' });
  if (Date.now() > entry.expiresAt) return res.status(410).json({ error: 'expired' });

  if (!entry.token) entry.token = rand(24);
  entry.verified = true;

  return res.json({ ok: true, token: entry.token });
});

app.get('/pair/poll', (req, res) => {
  const clientId = String(req.query.clientId || '');
  const deviceCode = String(req.query.deviceCode || '');
  const entry = pending.get(deviceCode);
  if (!entry || entry.clientId !== clientId) return res.status(404).json({ error: 'not found' });
  if (Date.now() > entry.expiresAt) {
    pending.delete(deviceCode);
    byClient.delete(clientId);
    return res.json({ status: 'pending' } satisfies PairPollResponse);
  }
  if (entry.verified && entry.token) {
    return res.json({ status: 'verified', token: entry.token } satisfies PairPollResponse);
  }
  res.json({ status: 'pending' } satisfies PairPollResponse);
});

app.get('/pair/verify', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>OpenClaw Pair</title>
<style>body{font-family:system-ui;margin:30px;max-width:520px}input{font-size:18px;padding:8px;width:260px}button{padding:8px 12px;font-size:16px}</style>
</head>
<body>
<h2>OpenClaw Relay Pairing</h2>
<form method="POST" action="/pair/verify">
<p>Enter the code shown in the Chrome extension popup:</p>
<input name="userCode" placeholder="ABCD-EFGH" />
<button type="submit">Verify</button>
</form>
</body></html>`);
});

app.use(express.urlencoded({ extended: false }));
app.post('/pair/verify', (req, res) => {
  const userCode = String(req.body?.userCode || '').trim().toUpperCase();
  const entry = Array.from(pending.values()).find((p) => p.userCode === userCode);
  if (!entry) return res.status(404).type('text').send('Code not found.');
  if (Date.now() > entry.expiresAt) return res.status(410).type('text').send('Code expired.');

  entry.verified = true;
  entry.token = rand(24);
  res.type('text').send(`Paired. You may return to the extension and click Connect WS.\nToken: ${entry.token.slice(0, 6)}…`);
});

// Agent simulator endpoint: send a message envelope to extension for a token.
app.post('/agent/send', (req, res) => {
  const token = String(req.query.token || req.body?.token || '');
  const msg = req.body?.msg;
  if (!token) return res.status(400).json({ error: 'token required' });
  const bucket = connsByToken.get(token);
  if (!bucket?.extension) return res.status(404).json({ error: 'no extension connected for token' });

  const env: Envelope = {
    v: 1,
    id: rand(8),
    ts: Date.now(),
    token,
    from: 'agent',
    to: 'extension',
    msg
  };
  bucket.extension.ws.send(JSON.stringify(env));
  res.json({ ok: true });
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

function parseQuery(urlStr: string): Record<string, string> {
  const u = new URL(urlStr, 'http://localhost');
  const out: Record<string, string> = {};
  for (const [k, v] of u.searchParams.entries()) out[k] = v;
  return out;
}

wss.on('connection', (ws, req) => {
  const q = parseQuery(req.url || '/ws');
  const token = String(q.token || '');
  const client = (q.client as ClientType) || 'extension';
  const clientId = String(q.clientId || '');

  if (!token || !clientId) {
    ws.close(1008, 'token and clientId required');
    return;
  }

  // Require that token was issued by pairing OR allow dev override.
  const allowAnyToken = process.env.ALLOW_ANY_TOKEN === '1';
  const issued = Array.from(pending.values()).some((p) => p.token === token);
  if (!allowAnyToken && !issued) {
    ws.close(1008, 'unknown token (pair first)');
    return;
  }

  const bucket = connsByToken.get(token) || {};
  const conn: Conn = { ws, client, clientId };
  if (client === 'extension') bucket.extension = conn;
  if (client === 'agent') bucket.agent = conn;
  connsByToken.set(token, bucket);

  ws.on('message', (data) => {
    let env: Envelope;
    try {
      env = JSON.parse(String(data));
    } catch {
      return;
    }
    if (env.token !== token) return;

    const b = connsByToken.get(token);
    const dest = env.to === 'agent' ? b?.agent : b?.extension;
    if (dest?.ws && dest.ws.readyState === dest.ws.OPEN) {
      dest.ws.send(JSON.stringify(env));
    }
  });

  ws.on('close', () => {
    const b = connsByToken.get(token);
    if (!b) return;
    if (b.extension?.ws === ws) delete b.extension;
    if (b.agent?.ws === ws) delete b.agent;
    if (!b.extension && !b.agent) connsByToken.delete(token);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`OpenClaw Relay listening on http://${HOST}:${PORT}`);
});
