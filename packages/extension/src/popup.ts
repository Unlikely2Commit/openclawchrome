import { getAudit } from './storage';

type PopupState = any;

function qs<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el as T;
}

function setStatus(text: string) {
  qs('status').textContent = text;
}

function normalizeAllowlist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function rpc(msg: any): Promise<any> {
  return await chrome.runtime.sendMessage(msg);
}

async function refresh() {
  const state: PopupState = await rpc({ t: 'popup_get_state' });
  const s = state.settings;

  qs<HTMLInputElement>('httpBase').value = s.httpBase || '';
  qs<HTMLInputElement>('allowActions').checked = !!s.allowActions;
  qs<HTMLTextAreaElement>('allowlist').value = (s.allowlist || []).join('\n');

  const wsStatus = state.ws?.status || 'disconnected';
  const tokenPart = s.token ? `token=${s.token.slice(0, 4)}…` : 'unpaired';
  setStatus(`WS: ${wsStatus} | ${tokenPart} | attached: ${(s.attachedTabIds || []).length}`);

  const tabsEl = qs('tabs');
  tabsEl.innerHTML = '';
  for (const id of s.attachedTabIds || []) {
    const row = document.createElement('div');
    row.textContent = `Tab ${id} `;
    const btn = document.createElement('button');
    btn.textContent = 'Detach';
    btn.onclick = async () => {
      await rpc({ t: 'detach_tab', tabId: id });
      await refresh();
    };
    row.appendChild(btn);
    tabsEl.appendChild(row);
  }

  const audit = await getAudit();
  const logEl = qs('log');
  logEl.innerHTML = '';
  for (const entry of audit.slice(-20).reverse()) {
    const div = document.createElement('div');
    div.textContent = `[${new Date(entry.ts).toISOString()}] ${entry.kind} tab=${entry.tabId ?? '-'} ${JSON.stringify(entry.detail)}`;
    logEl.appendChild(div);
  }
}

async function pairFlow() {
  const httpBase = qs<HTMLInputElement>('httpBase').value.trim();
  if (!httpBase) throw new Error('Set Relay HTTP Base URL');

  const pairInfo = qs('pairInfo');
  pairInfo.textContent = 'Requesting device code…';

  // Save httpBase immediately.
  await rpc({ t: 'popup_set_settings', patch: { httpBase } });

  const clientId = (await rpc({ t: 'popup_get_state' })).settings.clientId;

  const r1 = await fetch(new URL('/pair/request', httpBase).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId })
  });
  if (!r1.ok) throw new Error(`pair/request failed: ${r1.status}`);
  const data = await r1.json();

  pairInfo.innerHTML = `On another device, open <b>${data.verificationUri}</b> and enter code <b>${data.userCode}</b>.`;

  const expiresAt = data.expiresAt as number;
  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, 1500));
    const r2 = await fetch(new URL(`/pair/poll?clientId=${encodeURIComponent(clientId)}&deviceCode=${encodeURIComponent(data.deviceCode)}` , httpBase).toString());
    if (!r2.ok) continue;
    const p = await r2.json();
    if (p.status === 'verified') {
      await rpc({ t: 'popup_set_settings', patch: { token: p.token } });
      pairInfo.textContent = 'Paired. Click Connect WS.';
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

  qs('attachBtn').addEventListener('click', async () => {
    await rpc({ t: 'attach_current_tab' });
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

  await refresh();
}

main().catch((e) => {
  setStatus(`Error: ${String(e.message || e)}`);
});
