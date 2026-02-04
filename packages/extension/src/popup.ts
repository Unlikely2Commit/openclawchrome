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

function setStatusPill(wsStatus: string, token?: string) {
  const dot = qs<HTMLSpanElement>('statusDot');
  const text = qs<HTMLSpanElement>('statusText');

  const connected = wsStatus === 'connected';
  const paired = !!token;

  if (connected) {
    dot.classList.remove('bad');
    dot.classList.add('good');
    text.textContent = paired ? 'Connected' : 'Connected (unpaired?)';
    return;
  }

  dot.classList.remove('good');
  dot.classList.add('bad');
  text.textContent = paired ? 'Disconnected' : 'Disconnected';
}

async function renderAttachedList(attachedTabIds: number[]) {
  const el = qs('attachedList');
  if (!attachedTabIds?.length) {
    el.textContent = 'No tabs attached.';
    return;
  }
  el.textContent = `Attached tabs: ${attachedTabIds.join(', ')}`;
}

async function refresh() {
  const state: PopupState = await rpc({ t: 'popup_get_state' });
  const s = state.settings;

  qs<HTMLInputElement>('httpBase').value = s.httpBase || '';

  const wsStatus = state.ws?.status || 'disconnected';
  setStatusPill(wsStatus, s.token);

  // Build info (optional)
  try {
    qs('buildInfo').textContent = `build ${String((globalThis as any).__BUILD_TIME__ || '').slice(0, 19)}`;
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

  await renderAttachedList(attached);

  // Security
  qs<HTMLInputElement>('allowActions').checked = !!s.allowActions;
  qs<HTMLTextAreaElement>('allowlist').value = (s.allowlist || []).join('\n');

  // Audit
  const audit = await getAudit();
  const body = qs<HTMLTableSectionElement>('auditBody');
  body.innerHTML = '';
  const items = audit.slice(-25).reverse();
  if (!items.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = 'No audit entries yet.';
    td.style.color = 'var(--muted)';
    tr.appendChild(td);
    body.appendChild(tr);
  } else {
    for (const entry of items) {
      const tr = document.createElement('tr');

      const t1 = document.createElement('td');
      t1.textContent = new Date(entry.ts).toISOString().slice(11, 19);

      const t2 = document.createElement('td');
      t2.textContent = String(entry.kind || '');

      const t3 = document.createElement('td');
      t3.textContent = entry.tabId != null ? String(entry.tabId) : '-';

      const t4 = document.createElement('td');
      t4.textContent = JSON.stringify(entry.detail);
      t4.style.fontFamily = 'var(--mono)';

      tr.appendChild(t1);
      tr.appendChild(t2);
      tr.appendChild(t3);
      tr.appendChild(t4);
      body.appendChild(tr);
    }
  }
}

async function pairFlow() {
  const httpBase = qs<HTMLInputElement>('httpBase').value.trim();
  if (!httpBase) throw new Error('Set Relay HTTP Base URL');

  const pairInfo = qs('pairInfo');
  pairInfo.textContent = 'Requesting pairing code…';

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

  const fp = data.fingerprint?.short ? String(data.fingerprint.short).toUpperCase() : '????';
  const userCode = String(data.userCode || '').toUpperCase();

  pairInfo.innerHTML = `
<div class="kv">
  <div>Relay</div><div><span class="mono">${fp}</span></div>
  <div>Code</div><div><span class="mono">${userCode}</span></div>
  <div>Command</div><div><span class="mono">pair browser ${userCode}</span></div>
</div>
<div style="margin-top:8px; color: var(--muted); font-size: 12px;">Waiting for approval…</div>
`;

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
      pairInfo.textContent = 'Paired. Click Connect.';
      await refresh();
      return;
    }
  }

  pairInfo.textContent = 'Pairing expired.';
}

async function main() {
  qs('pairBtn').addEventListener('click', () => pairFlow().catch((e) => (qs('pairInfo').textContent = String(e.message || e))));

  qs('connectBtn').addEventListener('click', async () => {
    await rpc({ t: 'popup_connect' });
    await refresh();
  });

  qs('disconnectBtn').addEventListener('click', async () => {
    await rpc({ t: 'popup_disconnect' });
    await refresh();
  });

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

  // Save Relay URL on blur for convenience.
  qs<HTMLInputElement>('httpBase').addEventListener('change', async (e) => {
    const httpBase = (e.target as HTMLInputElement).value.trim();
    await rpc({ t: 'popup_set_settings', patch: { httpBase } });
    await refresh();
  });

  await refresh();
}

main().catch((e) => {
  qs('statusText').textContent = `Error: ${String(e.message || e)}`;
  qs('statusDot').classList.add('bad');
});
