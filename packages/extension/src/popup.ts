import { getAudit } from './storage';

type PopupState = any;

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

async function rpc(msg: any): Promise<any> {
  return await chrome.runtime.sendMessage(msg);
}

function normalizeAllowlist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
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

async function getActiveTabId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const t = tabs?.[0];
    return typeof t?.id === 'number' ? t.id : null;
  } catch {
    return null;
  }
}

function setStatusPill(wsStatus: string) {
  const dot = qs<HTMLSpanElement>('statusDot');
  const text = qs<HTMLSpanElement>('statusText');

  const connected = wsStatus === 'connected';

  dot.classList.remove('good', 'bad');
  if (connected) {
    dot.classList.add('good');
    text.textContent = 'Connected';
  } else {
    dot.classList.add('bad');
    text.textContent = 'Disconnected';
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

async function refresh() {
  const state: PopupState = await rpc({ t: 'popup_get_state' });
  const s = state.settings;

  qs<HTMLInputElement>('httpBase').value = s.httpBase || '';

  const wsStatus = state.ws?.status || 'disconnected';
  setStatusPill(wsStatus);

  // Build info (best-effort)
  try {
    const t = String((globalThis as any).__BUILD_TIME__ || '');
    qs('buildInfo').textContent = t ? `build ${t.slice(0, 19)}` : '';
  } catch {
    // ignore
  }

  // Attach toggle state
  const activeTabId = await getActiveTabId();
  const attached = (s.attachedTabIds || []) as number[];
  const isActiveAttached = activeTabId != null && attached.includes(activeTabId);
  const attachToggle = qs<HTMLInputElement>('attachToggle');
  attachToggle.checked = isActiveAttached;

  const attachDesc = qs('attachDesc');
  if (activeTabId == null) {
    attachDesc.textContent = 'No active tab detected.';
    attachToggle.disabled = true;
  } else {
    attachToggle.disabled = false;
    attachDesc.textContent = isActiveAttached ? `Tab ${activeTabId} is attached.` : `Tab ${activeTabId} is not attached.`;
  }

  const attachedList = qs('attachedList');
  attachedList.textContent = attached.length ? `Attached tabs: ${attached.join(', ')}` : 'No tabs attached.';

  // Security
  qs<HTMLInputElement>('allowActions').checked = !!s.allowActions;
  qs<HTMLTextAreaElement>('allowlist').value = (s.allowlist || []).join('\n');

  // Audit
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

async function pairFlow() {
  const httpBase = qs<HTMLInputElement>('httpBase').value.trim();
  if (!httpBase) throw new Error('Set Relay server URL');

  setPairInfo('Requesting pairing code…');
  showPairBox(false);

  // Save httpBase immediately.
  await rpc({ t: 'popup_set_settings', patch: { httpBase } });

  const clientId = (await rpc({ t: 'popup_get_state' })).settings.clientId;

  const r1 = await fetch(new URL('/pair/request', httpBase).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, meta: detectPairMeta() })
  });
  if (!r1.ok) throw new Error(`pair/request failed: ${r1.status}`);
  const data = await r1.json();

  const relayShort = data.fingerprint?.short ? String(data.fingerprint.short).toUpperCase() : '????';
  const userCode = String(data.userCode || '').toUpperCase();

  setPairBoxDetails({ relayShort, userCode });
  showPairBox(true);
  setPairInfo('Waiting for approval…');

  const expiresAt = data.expiresAt as number;
  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, 1500));
    const r2 = await fetch(
      new URL(`/pair/poll?clientId=${encodeURIComponent(clientId)}&deviceCode=${encodeURIComponent(data.deviceCode)}`, httpBase).toString(),
    );
    if (!r2.ok) continue;
    const p = await r2.json();
    if (p.status === 'verified') {
      await rpc({ t: 'popup_set_settings', patch: { token: p.token } });
      setPairInfo('Paired. Click Connect.');
      await refresh();
      return;
    }
  }

  setPairInfo('Pairing expired. Click Pair to try again.', true);
}

async function main() {
  // Pair
  qs('pairBtn').addEventListener('click', () =>
    pairFlow().catch((e) => setPairInfo(String(e.message || e), true)),
  );

  // Connect/disconnect
  qs('connectBtn').addEventListener('click', async () => {
    await rpc({ t: 'popup_connect' });
    await refresh();
  });
  qs('disconnectBtn').addEventListener('click', async () => {
    await rpc({ t: 'popup_disconnect' });
    await refresh();
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

  // Attach toggle
  qs<HTMLInputElement>('attachToggle').addEventListener('change', async (e) => {
    const wantAttached = (e.target as HTMLInputElement).checked;
    const activeTabId = await getActiveTabId();
    if (activeTabId == null) {
      await refresh();
      return;
    }

    if (wantAttached) {
      await rpc({ t: 'attach_current_tab' });
    } else {
      await rpc({ t: 'detach_tab', tabId: activeTabId });
    }

    await refresh();
  });

  // Security settings
  qs<HTMLInputElement>('allowActions').addEventListener('change', async (e) => {
    const allowActions = (e.target as HTMLInputElement).checked;
    await rpc({ t: 'popup_set_settings', patch: { allowActions } });
    await refresh();
  });

  qs<HTMLTextAreaElement>('allowlist').addEventListener('change', async (e) => {
    const allowlist = normalizeAllowlist((e.target as HTMLTextAreaElement).value);
    await rpc({ t: 'popup_set_settings', patch: { allowlist } });
    await refresh();
  });

  // Relay URL save on change
  qs<HTMLInputElement>('httpBase').addEventListener('change', async (e) => {
    const httpBase = (e.target as HTMLInputElement).value.trim();
    await rpc({ t: 'popup_set_settings', patch: { httpBase } });
    await refresh();
  });

  showPairBox(false);
  setPairInfo('');
  await refresh();
}

main().catch((e) => {
  qs('statusText').textContent = `Error: ${String(e.message || e)}`;
  qs('statusDot').classList.add('bad');
});
