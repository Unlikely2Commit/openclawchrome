import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type {
  Envelope,
  ClientType,
  PairRequestResponse,
  PairPollResponse,
  RelayFingerprint,
  AttachTab,
  DetachTab,
  TabEvent,
  ActionResult,
  ExtractResult,
  ResumeAck
} from '@openclaw/shared';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

type PairMetadata = {
  browser?: string;
  os?: string;
  userAgent?: string;
};

type PendingPair = {
  clientId: string;
  deviceCode: string;
  userCode: string;
  expiresAt: number;
  verified: boolean;
  token?: string;
  meta?: PairMetadata;
  approverLabel?: string;
};

const pending = new Map<string, PendingPair>(); // deviceCode -> entry
const byClient = new Map<string, PendingPair>(); // clientId -> entry
const byUserCode = new Map<string, PendingPair>(); // userCode -> entry

// Active websocket connections per token.
type Conn = { ws: WebSocket; client: ClientType; clientId: string };
const connsByToken = new Map<string, { extension?: Conn; agent?: Conn }>();

// --- Dev visibility (Model 2 UX support) ---

type ControlledTab = {
  tabId: number;
  url: string;
  title?: string;
  updatedAt: number;
};

type LastState = {
  controlledTab?: ControlledTab;
  lastActionResult?: { env: Envelope<ActionResult>; at: number };
  lastExtractResult?: { env: Envelope<ExtractResult>; at: number };
  lastResumeAck?: { env: Envelope<ResumeAck>; at: number };
  lastTabEvent?: { env: Envelope<TabEvent>; at: number };
  lastAttach?: { env: Envelope<AttachTab>; at: number };
  lastDetach?: { env: Envelope<DetachTab>; at: number };
};

const lastByToken = new Map<string, LastState>();
const devEventsByToken = new Map<string, EventEmitter>();

function getEmitter(token: string): EventEmitter {
  let em = devEventsByToken.get(token);
  if (!em) {
    em = new EventEmitter();
    em.setMaxListeners(100);
    devEventsByToken.set(token, em);
  }
  return em;
}

function recordToAgent(token: string, env: Envelope) {
  const last = lastByToken.get(token) || {};
  const at = Date.now();

  if (env.msg?.t === 'attach_tab') {
    const m = env.msg as AttachTab;
    last.controlledTab = { tabId: m.tabId, url: m.url, title: m.title, updatedAt: at };
    last.lastAttach = { env: env as Envelope<AttachTab>, at };
  }

  if (env.msg?.t === 'detach_tab') {
    const m = env.msg as DetachTab;
    if (last.controlledTab?.tabId === m.tabId) last.controlledTab = undefined;
    last.lastDetach = { env: env as Envelope<DetachTab>, at };
  }

  if (env.msg?.t === 'tab_event') {
    const m = env.msg as TabEvent;
    last.lastTabEvent = { env: env as Envelope<TabEvent>, at };
    // keep controlled tab metadata fresh if we can
    if (last.controlledTab && last.controlledTab.tabId === m.tabId) {
      if (m.url) last.controlledTab.url = m.url;
      if (m.title) last.controlledTab.title = m.title;
      last.controlledTab.updatedAt = at;
    }
  }

  if (env.msg?.t === 'action_result') {
    last.lastActionResult = { env: env as Envelope<ActionResult>, at };
  }

  if (env.msg?.t === 'extract_result') {
    last.lastExtractResult = { env: env as Envelope<ExtractResult>, at };
  }

  if (env.msg?.t === 'resume_ack') {
    last.lastResumeAck = { env: env as Envelope<ResumeAck>, at };
  }

  lastByToken.set(token, last);

  // Emit for SSE subscribers
  getEmitter(token).emit('to-agent', env);
}

function rand(len = 16): string {
  return crypto.randomBytes(len).toString('hex');
}

function makeUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  return `${part()}-${part()}`;
}

function sha256hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function loadOrCreateRelayFingerprint(): RelayFingerprint {
  // Preferred: derive from stable secret.
  const secret = process.env.RELAY_SECRET;
  if (secret) {
    const full = sha256hex(`openclaw-relay-fingerprint:${secret}`);
    return { full, short: full.slice(0, 4) };
  }

  // Fallback: persisted random seed.
  const file = process.env.RELAY_FINGERPRINT_FILE || path.join(process.cwd(), '.openclaw-relay-fingerprint');
  try {
    const seed = fs.readFileSync(file, 'utf8').trim();
    if (seed) {
      const full = sha256hex(`openclaw-relay-fingerprint:${seed}`);
      return { full, short: full.slice(0, 4) };
    }
  } catch {
    // ignore
  }

  const seed = rand(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${seed}\n`, { encoding: 'utf8' });
  } catch {
    // ignore; fingerprint will still be stable for this process lifetime
  }
  const full = sha256hex(`openclaw-relay-fingerprint:${seed}`);
  return { full, short: full.slice(0, 4) };
}

const RELAY_FINGERPRINT = loadOrCreateRelayFingerprint();

const app = express();

// CORS: allow the Chrome extension popup/background to call the relay endpoints.
// Without this, POSTs (e.g. /pair/request) can fail with "Failed to fetch" due to preflight.
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json());

app.get('/', (_req, res) => {
  res.type('text').send('OpenClaw Relay running.');
});

app.get('/fingerprint', (_req, res) => {
  res.json(RELAY_FINGERPRINT);
});

app.post('/pair/request', (req, res) => {
  const clientId = String(req.body?.clientId || '');
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  // Create new
  const deviceCode = rand(16);
  const userCode = makeUserCode();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  const verificationUri = `${req.protocol}://${req.get('host')}/pair/verify`;
  const meta = (req.body?.meta || undefined) as PairMetadata | undefined;
  const entry: PendingPair = { clientId, deviceCode, userCode, expiresAt, verified: false, meta };

  pending.set(deviceCode, entry);
  byClient.set(clientId, entry);
  byUserCode.set(userCode, entry);

  const out: PairRequestResponse = {
    clientId,
    deviceCode,
    userCode,
    verificationUri,
    expiresAt,
    fingerprint: RELAY_FINGERPRINT
  };
  res.json(out);
});

// Bot-driven lookup: bot receives "pair browser <code>" from user and calls this.
app.post('/pair/lookup', (req, res) => {
  const userCode = String(req.body?.userCode || '').trim().toUpperCase();
  if (!userCode) return res.status(400).json({ error: 'userCode required' });

  const entry = byUserCode.get(userCode);
  if (!entry) return res.status(404).json({ error: 'not found' });
  if (Date.now() > entry.expiresAt) return res.status(410).json({ error: 'expired' });

  return res.json({
    clientId: entry.clientId,
    expiresAt: entry.expiresAt,
    fingerprint: RELAY_FINGERPRINT,
    meta: entry.meta || {}
  });
});

// Bot-driven approve: marks pairing approved and issues token (extension will receive it via /pair/poll)
app.post('/pair/approve', (req, res) => {
  const userCode = String(req.body?.userCode || '').trim().toUpperCase();
  const approverLabel = req.body?.approverLabel ? String(req.body.approverLabel) : undefined;
  if (!userCode) return res.status(400).json({ error: 'userCode required' });

  const entry = byUserCode.get(userCode);
  if (!entry) return res.status(404).json({ error: 'not found' });
  if (Date.now() > entry.expiresAt) return res.status(410).json({ error: 'expired' });

  if (!entry.token) entry.token = rand(24);
  entry.verified = true;
  if (approverLabel) entry.approverLabel = approverLabel;

  return res.json({ ok: true });
});

// One-click pairing confirmation for the same browser that initiated /pair/request.
// This is now a DEV-only flow (prefer bot approval via /pair/lookup + /pair/approve).
app.post('/pair/confirm', (req, res) => {
  if (process.env.ALLOW_PAIR_CONFIRM !== '1') return res.status(404).json({ error: 'not found' });

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
    byUserCode.delete(entry.userCode);
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
<p><b>NOTE:</b> This page is a legacy/dev flow. Prefer pairing via your OpenClaw bot.</p>
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
  const entry = byUserCode.get(userCode) || Array.from(pending.values()).find((p) => p.userCode === userCode);
  if (!entry) return res.status(404).type('text').send('Code not found.');
  if (Date.now() > entry.expiresAt) return res.status(410).type('text').send('Code expired.');

  entry.verified = true;
  if (!entry.token) entry.token = rand(24);
  res.type('text').send(`Paired. You may return to the extension and click Connect WS.\nToken: ${entry.token.slice(0, 6)}…`);
});

// Debug endpoint to see which tokens are currently connected (do not expose publicly).
app.get('/debug/conns', (_req, res) => {
  const rows = Array.from(connsByToken.entries()).map(([token, b]) => ({
    token,
    tokenPrefix: token.slice(0, 6),
    hasExtension: Boolean(b.extension),
    hasAgent: Boolean(b.agent),
    extensionClientId: b.extension?.clientId,
    agentClientId: b.agent?.clientId
  }));
  res.json({ ok: true, count: rows.length, rows });
});

// --- Dev endpoints: simulate/subscribe as an agent without running a separate client ---

// SSE stream of all envelopes routed TO agent for a given token.
app.get('/dev/agent/subscribe', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'token required' });

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });

  const em = getEmitter(token);
  const onEnv = (env: Envelope) => {
    res.write(`data: ${JSON.stringify(env)}\n\n`);
  };
  em.on('to-agent', onEnv);

  // initial ping
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, tokenPrefix: token.slice(0, 6) })}\n\n`);

  req.on('close', () => {
    em.off('to-agent', onEnv);
  });
});

app.get('/dev/controlled', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'token required' });
  const last = lastByToken.get(token) || {};
  res.json({ ok: true, tokenPrefix: token.slice(0, 6), controlledTab: last.controlledTab || null });
});

app.get('/dev/last_action_result', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'token required' });
  const last = lastByToken.get(token) || {};
  res.json({ ok: true, tokenPrefix: token.slice(0, 6), lastActionResult: last.lastActionResult || null });
});

app.get('/dev/last', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'token required' });
  const last = lastByToken.get(token) || {};
  res.json({ ok: true, tokenPrefix: token.slice(0, 6), ...last });
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

    // Record anything headed to agent (this makes action_result round-trips visible).
    if (env.to === 'agent') recordToAgent(token, env);

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
  console.log(`Relay fingerprint: ${RELAY_FINGERPRINT.short} (${RELAY_FINGERPRINT.full.slice(0, 12)}…)`);
});
