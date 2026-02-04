import type { Envelope, ActionRequest, OpenTabRequest, Message } from '@openclaw/shared';
import { RelayWS } from './ws';
import { appendAudit, getSettings, setSettings } from './storage';

const relay = new RelayWS();

let reconnectTimer: number | null = null;
let reconnectAttempt = 0;

async function scheduleReconnect(reason = 'unknown') {
  const settings = await getSettings();
  if (!settings.httpBase || !settings.token) return;

  // Backoff: 0.5s → 1s → 2s → 4s → 8s (cap)
  const delay = Math.min(8000, 500 * Math.pow(2, reconnectAttempt));
  reconnectAttempt = Math.min(reconnectAttempt + 1, 6);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    try {
      const httpBase = settings.httpBase;
      const token = settings.token;
      if (!httpBase || !token) return;
      const wsUrl = wsBaseFromHttp(httpBase);
      relay.connect({ wsUrl, token, clientId: settings.clientId });
      void updateBadge();
    } catch {
      // try again next wake
    }
  }, delay) as unknown as number;

  // Logged as a normal action for now (audit types are intentionally narrow in v0.2)
  await appendAudit({ ts: Date.now(), kind: 'action', detail: { kind: 'ws_reconnect_scheduled', delayMs: delay, reason } });
}

async function ensureConnected() {
  const settings = await getSettings();
  if (!settings.httpBase || !settings.token) return;
  if (relay.state.status === 'connected' || relay.state.status === 'connecting') return;

  const httpBase = settings.httpBase;
  const token = settings.token;
  if (!httpBase || !token) return;
  const wsUrl = wsBaseFromHttp(httpBase);
  relay.connect({ wsUrl, token, clientId: settings.clientId });
  await updateBadge();
}

async function updateBadge() {
  const settings = await getSettings();
  const text = relay.state.status === 'connected' ? 'ON' : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: relay.state.status === 'connected' ? '#2e7d32' : '#777' });
  if (settings.allowActions) {
    await chrome.action.setBadgeText({ text: relay.state.status === 'connected' ? 'ON*' : '*' });
    await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  }
}

function wsBaseFromHttp(httpBase: string): string {
  // http://host:port -> ws://host:port/ws
  const u = new URL(httpBase);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = '';
  return u.toString();
}

relay.onMessage(async (env: Envelope) => {
  const msg = env.msg;
  if (msg.t === 'action_request') {
    await handleActionRequest(msg);
  }
  if (msg.t === 'open_tab_request') {
    await handleOpenTabRequest(msg);
  }
});

async function isAllowedForTab(tabId: number): Promise<{ ok: boolean; reason?: string; url?: string }> {
  const settings = await getSettings();
  if (!settings.allowActions) return { ok: false, reason: 'Allow Actions is disabled' };

  const tab = await chrome.tabs.get(tabId);
  const urlStr = tab.url || '';
  let hostname = '';
  try {
    hostname = new URL(urlStr).hostname;
  } catch {
    return { ok: false, reason: 'Tab URL is not a valid URL', url: urlStr };
  }

  const allow = settings.allowlist || [];
  const ok = allow.some((d) => d === hostname || (d.startsWith('*.') && hostname.endsWith(d.slice(1))));
  if (!ok) return { ok: false, reason: `Hostname not in allowlist: ${hostname}`, url: urlStr };
  return { ok: true, url: urlStr };
}

async function handleActionRequest(req: ActionRequest) {
  const allowed = await isAllowedForTab(req.tabId);
  if (!allowed.ok) {
    await appendAudit({ ts: Date.now(), kind: 'security_block', tabId: req.tabId, detail: { req, reason: allowed.reason, url: allowed.url } });
    relay.send({ t: 'action_result', requestId: req.requestId, ok: false, error: allowed.reason }, 'agent');
    return;
  }

  try {
    if (req.action === 'navigate') {
      if (!req.url) throw new Error('navigate requires url');
      await chrome.tabs.update(req.tabId, { url: req.url });
    } else {
      await chrome.tabs.sendMessage(req.tabId, { t: 'do_action', req });
    }

    await appendAudit({ ts: Date.now(), kind: 'action', tabId: req.tabId, detail: { req } });
    relay.send({ t: 'action_result', requestId: req.requestId, ok: true }, 'agent');
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await appendAudit({ ts: Date.now(), kind: 'action', tabId: req.tabId, detail: { req, error } });
    relay.send({ t: 'action_result', requestId: req.requestId, ok: false, error }, 'agent');
  }
}

async function handleOpenTabRequest(req: OpenTabRequest) {
  // Opening a tab is also an action; enforce allowActions + allowlist by URL.
  const settings = await getSettings();
  if (!settings.allowActions) {
    relay.send({ t: 'open_tab_result', requestId: req.requestId, ok: false, error: 'Allow Actions is disabled' }, 'agent');
    return;
  }
  let hostname = '';
  try {
    hostname = new URL(req.url).hostname;
  } catch {
    relay.send({ t: 'open_tab_result', requestId: req.requestId, ok: false, error: 'Invalid URL' }, 'agent');
    return;
  }
  const allow = settings.allowlist || [];
  const ok = allow.some((d) => d === hostname || (d.startsWith('*.') && hostname.endsWith(d.slice(1))));
  if (!ok) {
    relay.send({ t: 'open_tab_result', requestId: req.requestId, ok: false, error: `Hostname not in allowlist: ${hostname}` }, 'agent');
    return;
  }

  try {
    const tab = await chrome.tabs.create({ url: req.url, active: true });
    await appendAudit({ ts: Date.now(), kind: 'open_tab', tabId: tab.id, detail: { url: req.url } });

    if (req.attach && tab.id) {
      const next = await setSettings({ attachedTabIds: Array.from(new Set([...(settings.attachedTabIds || []), tab.id])) });
      // notify agent
      relay.send({ t: 'attach_tab', tabId: tab.id, url: tab.url || req.url, title: tab.title }, 'agent');
      await updateBadge();
      void next;
    }

    relay.send({ t: 'open_tab_result', requestId: req.requestId, ok: true, tabId: tab.id }, 'agent');
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    relay.send({ t: 'open_tab_result', requestId: req.requestId, ok: false, error }, 'agent');
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.t === 'popup_get_state') {
      const settings = await getSettings();
      // Auto-reconnect when popup opens so UX doesn't "forget" the connection.
      void ensureConnected();
      sendResponse({
        ws: relay.state,
        settings
      });
      return;
    }

    if (msg?.t === 'popup_set_settings') {
      const next = await setSettings(msg.patch || {});
      await updateBadge();
      sendResponse({ ok: true, settings: next });
      return;
    }

    if (msg?.t === 'popup_connect') {
      const settings = await getSettings();
      if (!settings.httpBase || !settings.token) throw new Error('Missing relay URL / pairing token; pair first');
      const wsUrl = wsBaseFromHttp(settings.httpBase);
      reconnectAttempt = 0;
      relay.connect({ wsUrl, token: settings.token, clientId: settings.clientId });
      await updateBadge();
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'popup_disconnect') {
      relay.disconnect();
      await updateBadge();
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'attach_current_tab') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url) throw new Error('No active tab');
      const settings = await getSettings();
      const attached = Array.from(new Set([...(settings.attachedTabIds || []), tab.id]));
      await setSettings({ attachedTabIds: attached });
      relay.send({ t: 'attach_tab', tabId: tab.id, url: tab.url, title: tab.title }, 'agent');
      sendResponse({ ok: true, attachedTabIds: attached });
      return;
    }

    if (msg?.t === 'detach_tab') {
      const settings = await getSettings();
      const attached = (settings.attachedTabIds || []).filter((id) => id !== msg.tabId);
      await setSettings({ attachedTabIds: attached });
      relay.send({ t: 'detach_tab', tabId: msg.tabId }, 'agent');
      sendResponse({ ok: true, attachedTabIds: attached });
      return;
    }

    if (msg?.t === 'ws_closed') {
      void scheduleReconnect('ws_closed');
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'tab_event') {
      // from content script
      const tabId = sender.tab?.id;
      if (!tabId) return;
      const settings = await getSettings();
      if (!(settings.attachedTabIds || []).includes(tabId)) return;
      relay.send({ ...(msg.event as Message), tabId } as any, 'agent');
      return;
    }
  })()
    .then(() => true)
    .catch((e) => {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });

  return true;
});

chrome.storage.onChanged.addListener(() => {
  void updateBadge();
  void ensureConnected();
});

chrome.runtime.onStartup?.addListener(() => {
  void ensureConnected();
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureConnected();
});

void ensureConnected();
void updateBadge();
