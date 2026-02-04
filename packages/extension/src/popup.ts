import { getAudit, type Settings } from './storage';
import type { WSState } from './ws';

// injected at build time (see scripts/build.mjs)
declare const __BUILD_TIME__: string | undefined;

type ControlledInfo = {
  activeTabId: number | null;
  inGroup: boolean;
  groupId?: number;
  groupTitle?: string;
  groupColor?: string;
  title?: string;
  url?: string;
  hostname?: string;
  lastError?: string;
};

type PopupGetStateResponse = {
  ws: WSState;
  settings: Settings;
  controlled: ControlledInfo;
};

type PairMeta = {
  browser?: string;
  os?: string;
  userAgent?: string;
};

function qs<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el as T;
}

async function rpc<TReq extends object, TRes>(msg: TReq): Promise<TRes> {
  return (await chrome.runtime.sendMessage(msg)) as TRes;
}

function detectPairMeta(): PairMeta {
  const ua = navigator.userAgent || '';

  // Lightweight heuristics (good enough for approval UI).
  let browser: string | undefined;
  if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome/')) browser = 'Chrome';
  else if (ua.includes('Firefox/')) browser = 'Firefox';

  let os: string | undefined;
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS X')) os = 'macOS';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('Linux')) os = 'Linux';

  return { browser, os, userAgent: ua };
}

let pairingPending = false;

function setStatusPill(ws: { status?: string; lastError?: string } | undefined) {
  const dot = qs<HTMLSpanElement>('statusDot');
  const text = qs<HTMLSpanElement>('statusText');
  const pill = qs<HTMLDivElement>('statusPill');

  const status = ws?.status || 'disconnected';

  dot.classList.remove('good', 'bad', 'warn');
  pill.title = ws?.lastError ? `Last error: ${ws.lastError}` : '';

  // Pair UX: show an explicit awaiting-approval state (amber pill) while polling.
  if (pairingPending) {
    dot.classList.add('warn');
    text.textContent = 'Awaiting Approval';
    return;
  }

  if (status === 'connected') {
    dot.classList.add('good');
    text.textContent = 'Connected';
  } else if (status === 'connecting') {
    dot.classList.add('warn');
    text.textContent = 'Connecting…';
  } else {
    dot.classList.add('bad');
    text.textContent = ws?.lastError ? 'Disconnected (error)' : 'Disconnected';
  }
}

function setPairInfo(text: string, isError = false) {
  const el = qs('pairInfo');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function showPairBox(show: boolean) {
  qs('pairBox').style.display = show ? 'block' : 'none';
}

function setPairBoxDetails(opts: { relayShort: string; userCode: string }) {
  qs('pairRelay').textContent = opts.relayShort;
  qs('pairCode').textContent = opts.userCode;
  const cmd = `pair browser ${opts.userCode}`;
  qs('pairCmd').textContent = cmd;
  (qs('copyPairCmd') as HTMLButtonElement).dataset.cmd = cmd;
}

function setBtnLoading(btn: HTMLButtonElement, on: boolean, opts?: { label?: string }) {
  btn.classList.toggle('loading', on);
  btn.disabled = on;
  if (opts?.label) btn.textContent = opts.label;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older environments
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

let lastHttpBaseDraft = '';
let isEditingHttpBase = false;

function formatTabTitle(title?: string): string {
  const t = (title || '').trim();
  if (!t) return '(untitled)';
  return t.length > 52 ? `${t.slice(0, 52)}…` : t;
}

let auditOpen = false;

async function renderAudit() {
  const list = qs('auditList');
  list.innerHTML = '';
  const audit = await getAudit();
  const items = audit.slice(-25).reverse();
  if (!items.length) {
    const div = document.createElement('div');
    div.className = 'hint';
    div.textContent = 'No audit entries yet.';
    list.appendChild(div);
  } else {
    for (const entry of items) {
      const item = document.createElement('div');
      item.className = 'auditItem';

      const top = document.createElement('div');
      top.className = 'auditTop';
      const time = document.createElement('div');
      time.textContent = new Date(entry.ts).toISOString().slice(11, 19);

      const right = document.createElement('div');
      right.style.display = 'flex';
      right.style.gap = '6px';

      const tag1 = document.createElement('span');
      tag1.className = 'tag';
      tag1.textContent = String(entry.kind || '');

      const tag2 = document.createElement('span');
      tag2.className = 'tag';
      tag2.textContent = entry.tabId != null ? `tab ${entry.tabId}` : 'tab -';

      right.appendChild(tag1);
      right.appendChild(tag2);

      top.appendChild(time);
      top.appendChild(right);

      const detail = document.createElement('div');
      detail.className = 'auditDetail';
      detail.textContent = JSON.stringify(entry.detail);

      item.appendChild(top);
      item.appendChild(detail);
      list.appendChild(item);
    }
  }
}

async function refresh() {
  const state = await rpc<{ t: 'popup_get_state' }, PopupGetStateResponse>({ t: 'popup_get_state' });
  const s = state.settings;

  // Don't clobber the relay URL while the user is typing.
  const httpEl = qs<HTMLInputElement>('httpBase');
  if (!isEditingHttpBase) {
    httpEl.value = s.httpBase || '';
    lastHttpBaseDraft = httpEl.value;
  }

  // Clear the temporary pairing state once the background connects or errors.
  if (state.ws?.status === 'connected' || state.ws?.lastError) pairingPending = false;
  setStatusPill(state.ws);

  // Build info (best-effort)
  try {
    const t = String(__BUILD_TIME__ || '');
    qs('buildInfo').textContent = t ? `build ${t.slice(0, 19)}` : '';
  } catch {
    // ignore
  }

  // Controlled tab info (Model 2)
  const c = state.controlled || {};
  const groupInfo = qs('groupInfo');
  const tabInfo = qs('tabInfo');
  const tabHost = qs('tabHost');
  const detachBtn = qs<HTMLButtonElement>('detachBtn');
  const startBtn = qs<HTMLButtonElement>('startBtn');

  const inGroup = !!c.inGroup;
  const gTitle = c.groupTitle || (inGroup ? 'OpenClaw' : '—');
  const gColor = c.groupColor ? String(c.groupColor) : '';
  groupInfo.textContent = inGroup ? `${gTitle}${gColor ? ` (${gColor})` : ''}` : '(not in OpenClaw group)';

  tabInfo.textContent = c.activeTabId ? `#${c.activeTabId} — ${formatTabTitle(c.title)}` : 'No active tab';
  tabHost.textContent = c.hostname || '—';

  startBtn.disabled = !c.activeTabId || inGroup;
  detachBtn.disabled = !c.activeTabId || !inGroup;

  // Security
  qs<HTMLInputElement>('allowActions').checked = !!s.allowActions;

  // Audit (avoid jitter: only refresh when the user opens the panel)
  const list = qs('auditList');
  list.style.display = auditOpen ? 'flex' : 'none';
  if (auditOpen) {
    await renderAudit();
  }
}

async function pairFlow() {
  const httpBase = qs<HTMLInputElement>('httpBase').value.trim();
  if (!httpBase) throw new Error('Set Relay server URL');

  pairingPending = true;
  setStatusPill(undefined);
  setPairInfo('Requesting pairing code…');
  showPairBox(false);

  // Save httpBase immediately.
  await rpc({ t: 'popup_set_settings', patch: { httpBase } });

  const clientId = (await rpc<{ t: 'popup_get_state' }, PopupGetStateResponse>({ t: 'popup_get_state' })).settings.clientId;

  const r1 = await fetch(new URL('/pair/request', httpBase).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, meta: detectPairMeta() })
  });
  if (!r1.ok) throw new Error(`pair/request failed: ${r1.status}`);
  const data = (await r1.json()) as {
    clientId: string;
    deviceCode: string;
    userCode: string;
    expiresAt: number;
    fingerprint?: { short?: string };
  };

  const relayShort = data.fingerprint?.short ? String(data.fingerprint.short).toUpperCase() : '????';
  const userCode = String(data.userCode || '').toUpperCase();

  setPairBoxDetails({ relayShort, userCode });
  showPairBox(true);
  setPairInfo('Waiting for approval…');
  pairingPending = true;
  setStatusPill(undefined);

  const expiresAt = data.expiresAt as number;
  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, 1500));
    const r2 = await fetch(
      new URL(`/pair/poll?clientId=${encodeURIComponent(clientId)}&deviceCode=${encodeURIComponent(data.deviceCode)}`, httpBase).toString(),
    );
    if (!r2.ok) continue;
    const p = (await r2.json()) as { status: 'pending' } | { status: 'verified'; token: string };
    if (p.status === 'verified') {
      pairingPending = false;
      await rpc<{ t: 'popup_set_settings'; patch: Partial<Settings> }, { ok: true; settings: Settings }>({ t: 'popup_set_settings', patch: { token: p.token } });
      setPairInfo('Paired. Background will try to connect automatically (or click Connect).');
      await refresh();
      return;
    }
  }

  pairingPending = false;
  setStatusPill(undefined);
  setPairInfo('Pairing expired. Click Pair to try again.', true);
}

async function main() {
  // Pair
  qs('pairBtn').addEventListener('click', () =>
    pairFlow().catch((e) => {
      pairingPending = false;
      setStatusPill(undefined);
      setPairInfo(String(e.message || e), true);
    }),
  );

  // Connect/disconnect
  qs('connectBtn').addEventListener('click', async () => {
    const btn = qs<HTMLButtonElement>('connectBtn');
    const prev = btn.textContent || 'Connect';
    try {
      setBtnLoading(btn, true, { label: 'Connecting…' });
      await rpc<{ t: 'popup_connect' }, { ok: true }>({ t: 'popup_connect' });
      // Background service worker may connect a moment after this call; poll briefly.
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 400));
        await refresh();
        const state = await rpc<{ t: 'popup_get_state' }, PopupGetStateResponse>({ t: 'popup_get_state' });
        if (state.ws?.status === 'connected') break;
      }
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
  qs('disconnectBtn').addEventListener('click', async () => {
    const btn = qs<HTMLButtonElement>('disconnectBtn');
    const prev = btn.textContent || 'Disconnect';
    try {
      setBtnLoading(btn, true, { label: 'Disconnecting…' });
      await rpc<{ t: 'popup_disconnect' }, { ok: true }>({ t: 'popup_disconnect' });
      await refresh();
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  // Start controlling
  qs('startBtn').addEventListener('click', async () => {
    const btn = qs<HTMLButtonElement>('startBtn');
    const prev = btn.textContent || 'Start controlling this tab';
    try {
      setBtnLoading(btn, true, { label: 'Starting…' });
      await rpc<{ t: 'popup_start_control_active_tab' }, { ok: true }>({ t: 'popup_start_control_active_tab' });
      await refresh();
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  // Stop / detach
  qs('detachBtn').addEventListener('click', async () => {
    const btn = qs<HTMLButtonElement>('detachBtn');
    const prev = btn.textContent || 'Stop';
    try {
      setBtnLoading(btn, true, { label: 'Stopping…' });
      await rpc<{ t: 'popup_detach_active_tab' }, { ok: true }>({ t: 'popup_detach_active_tab' });
      await refresh();
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  // Copy pairing command
  qs<HTMLButtonElement>('copyPairCmd').addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const cmd = btn.dataset.cmd || '';
    if (!cmd) return;
    const ok = await copyText(cmd);
    const prev = btn.textContent || 'Copy';
    btn.textContent = ok ? 'Copied' : 'Failed';
    setTimeout(() => (btn.textContent = prev), 900);
  });

  // Security settings
  qs<HTMLInputElement>('allowActions').addEventListener('change', async (e) => {
    const allowActions = (e.target as HTMLInputElement).checked;
    await rpc<{ t: 'popup_set_settings'; patch: Partial<Settings> }, { ok: true; settings: Settings }>({
      t: 'popup_set_settings',
      patch: { allowActions }
    });
    await refresh();
  });

  qs<HTMLButtonElement>('enableActionsSessionBtn').addEventListener('click', async () => {
    const btn = qs<HTMLButtonElement>('enableActionsSessionBtn');
    const prev = btn.textContent || 'Enable actions for this session';
    try {
      setBtnLoading(btn, true, { label: 'Enabling…' });
      await rpc<{ t: 'popup_enable_actions_session' }, { ok: true }>({
        t: 'popup_enable_actions_session'
      });
      btn.textContent = 'Enabled';
      setTimeout(() => {
        btn.textContent = prev;
      }, 1200);
      await refresh();
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });

  // Audit toggle
  qs<HTMLButtonElement>('auditToggleBtn').addEventListener('click', async () => {
    auditOpen = !auditOpen;
    qs<HTMLButtonElement>('auditToggleBtn').textContent = auditOpen ? 'Hide' : 'Show';
    await refresh();
  });

  // Relay URL: avoid wiping mid-typing; save on blur (and allow manual edit).
  const httpEl = qs<HTMLInputElement>('httpBase');
  httpEl.addEventListener('focus', () => {
    isEditingHttpBase = true;
    lastHttpBaseDraft = httpEl.value;
  });
  httpEl.addEventListener('input', () => {
    lastHttpBaseDraft = httpEl.value;
  });
  httpEl.addEventListener('blur', async () => {
    isEditingHttpBase = false;
    const httpBase = (lastHttpBaseDraft || '').trim();
    await rpc({ t: 'popup_set_settings', patch: { httpBase } });
    await refresh();
  });

  showPairBox(false);
  setPairInfo('');
  await refresh();

  // Keep UI in sync while popup is open (MV3 service worker state can change asynchronously).
  setInterval(() => {
    void refresh();
  }, 1000);
}

main().catch((e) => {
  qs('statusText').textContent = `Error: ${String(e.message || e)}`;
  qs('statusDot').classList.add('bad');
});
