import type { Envelope, ActionRequest, OpenTabRequest, Message } from '@openclaw/shared';
import { RelayWS } from './ws';
import { appendAudit, getSettings, setSettings } from './storage';

const relay = new RelayWS();

const GROUP_TITLE = 'OpenClaw';
const GROUP_COLOR: chrome.tabGroups.ColorEnum = 'red';

let reconnectTimer: number | null = null;
let reconnectAttempt = 0;

async function scheduleReconnect(reason = 'unknown') {
  const settings = await getSettings();
  if (!settings.httpBase || !settings.token) return;
  if (settings.autoConnect === false) return;

  // Backoff: 0.5s → 1s → 2s → 4s → 8s (cap)
  const delay = Math.min(8000, 500 * Math.pow(2, reconnectAttempt));
  reconnectAttempt = Math.min(reconnectAttempt + 1, 6);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  reconnectTimer =
    (setTimeout(() => {
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
    }, delay) as unknown as number) ?? null;

  await appendAudit({ ts: Date.now(), kind: 'action', detail: { kind: 'ws_reconnect_scheduled', delayMs: delay, reason } });
}

async function ensureConnected() {
  const settings = await getSettings();
  if (!settings.httpBase || !settings.token) return;
  if (settings.autoConnect === false) return;
  if (relay.state.status === 'connected' || relay.state.status === 'connecting') return;

  const wsUrl = wsBaseFromHttp(settings.httpBase);
  reconnectAttempt = 0;
  relay.connect({ wsUrl, token: settings.token, clientId: settings.clientId });
  await updateBadge();
}

async function updateBadge() {
  const settings = await getSettings();
  const connected = relay.state.status === 'connected';

  if (settings.allowActions) {
    await chrome.action.setBadgeText({ text: connected ? 'ON*' : '*' });
    await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  } else {
    await chrome.action.setBadgeText({ text: connected ? 'ON' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: connected ? '#2e7d32' : '#777' });
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

async function isControlledTab(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const gid = (tab as any).groupId as number | undefined;
    if (typeof gid !== 'number' || gid < 0) return false;
    const g = await chrome.tabGroups.get(gid);
    return g?.title === GROUP_TITLE;
  } catch {
    return false;
  }
}

async function ensureOpenClawGroupInWindow(windowId: number): Promise<number | null> {
  try {
    const groups = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });
    if (groups?.length) return groups[0]!.id;
    return null;
  } catch {
    return null;
  }
}

async function addTabToOpenClawGroup(tabId: number): Promise<number | null> {
  const tab = await chrome.tabs.get(tabId);
  const windowId = tab.windowId;

  const existing = await ensureOpenClawGroupInWindow(windowId);
  if (existing != null) {
    await chrome.tabs.group({ groupId: existing, tabIds: [tabId] });
    // best-effort: enforce label/color
    try {
      await chrome.tabGroups.update(existing, { title: GROUP_TITLE, color: GROUP_COLOR });
    } catch {}
    return existing;
  }

  // Create by grouping the tab.
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  try {
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
  } catch {}
  return groupId;
}

async function removeTabFromGroup(tabId: number): Promise<void> {
  try {
    await chrome.tabs.ungroup([tabId]);
  } catch {
    // ignore
  }
  try {
    await chrome.tabs.sendMessage(tabId, { t: 'set_controlled', on: false });
  } catch {
    // ignore
  }
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {
    // ignore; sendMessage will surface errors
  }
}

async function ensureControlled(tabId: number): Promise<void> {
  await addTabToOpenClawGroup(tabId);
  await ensureContentScript(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, { t: 'set_controlled', on: true });
  } catch {
    // ignore
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) relay.send({ t: 'attach_tab', tabId, url: tab.url, title: tab.title }, 'agent');
    await appendAudit({ ts: Date.now(), kind: 'tab_control', tabId, detail: { kind: 'controlled', url: tab.url, title: tab.title } });
  } catch {
    // ignore
  }
}

relay.onMessage(async (env: Envelope) => {
  const msg = env.msg;
  if (msg.t === 'action_request') {
    await handleActionRequest(msg);
  }
  if (msg.t === 'open_tab_request') {
    await handleOpenTabRequest(msg);
  }
  if ((msg as any).t === 'extract_request') {
    await handleExtractRequest(msg as any);
  }
});

async function isAllowedForTab(tabId: number): Promise<{ ok: boolean; reason?: string; url?: string }> {
  const settings = await getSettings();
  if (!settings.allowActions) return { ok: false, reason: 'Allow Actions is disabled' };

  if (!(await isControlledTab(tabId))) return { ok: false, reason: 'Tab is not in the OpenClaw tab group' };

  const tab = await chrome.tabs.get(tabId);
  const urlStr = tab.url || '';
  try {
    new URL(urlStr);
  } catch {
    return { ok: false, reason: 'Tab URL is not a valid URL', url: urlStr };
  }

  // v0.3.0: no allowlist (experimental); actions are allowed on any valid URL
  // as long as Allow Actions is enabled AND the tab is controlled (in the OpenClaw group).
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
      // Ensure content script exists
      await ensureContentScript(req.tabId);
      try {
        await chrome.tabs.sendMessage(req.tabId, { t: 'do_action', req });
      } catch (e: any) {
        // If the receiving end isn't there yet, inject and retry once.
        const msg = String(e?.message || e);
        if (msg.includes('Receiving end does not exist')) {
          await ensureContentScript(req.tabId);
          await chrome.tabs.sendMessage(req.tabId, { t: 'do_action', req });
        } else {
          throw e;
        }
      }
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
  const settings = await getSettings();
  if (!settings.allowActions) {
    relay.send({ t: 'open_tab_result', requestId: req.requestId, ok: false, error: 'Allow Actions is disabled' }, 'agent');
    return;
  }
  try {
    new URL(req.url);
  } catch {
    relay.send({ t: 'open_tab_result', requestId: req.requestId, ok: false, error: 'Invalid URL' }, 'agent');
    return;
  }

  try {
    const tab = await chrome.tabs.create({ url: req.url, active: true });
    await appendAudit({ ts: Date.now(), kind: 'open_tab', tabId: tab.id, detail: { url: req.url } });

    // Model 2: agent-opened tabs are controlled by default.
    if (tab.id) {
      await ensureControlled(tab.id);
    }

    relay.send({ t: 'open_tab_result', requestId: req.requestId, ok: true, tabId: tab.id }, 'agent');
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    relay.send({ t: 'open_tab_result', requestId: req.requestId, ok: false, error }, 'agent');
  }
}

async function handleExtractRequest(req: any) {
  const allowed = await isAllowedForTab(req.tabId);
  if (!allowed.ok) {
    relay.send({ t: 'extract_result', requestId: req.requestId, ok: false, tabId: req.tabId, error: allowed.reason } as any, 'agent');
    return;
  }

  const max = Math.max(1, Math.min(30, req.max ?? 12));

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: req.tabId },
      func: (kind: string, max: number) => {
        const url = location.href;
        const title = document.title;

        if (kind === 'page_info') {
          return { url, title, items: [] };
        }

        // reddit listing extractor: return threads (title + absolute url)
        const out: Array<{ title: string; url: string }> = [];
        const seen = new Set<string>();

        const anchors = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
        for (const a of anchors) {
          const href = a.href || '';
          if (!href) continue;
          if (!href.includes('/comments/')) continue;

          const text = (a.textContent || '').trim();
          if (!text) continue;

          // Skip obvious non-title links
          if (text.toLowerCase() === 'comments') continue;
          if (text.toLowerCase() === 'share') continue;

          // Normalize to canonical post url (strip query/hash)
          try {
            const u = new URL(href);
            u.search = '';
            u.hash = '';
            const key = u.toString();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ title: text.slice(0, 200), url: key });
            if (out.length >= max) break;
          } catch {
            continue;
          }
        }

        return { url, title, items: out };
      },
      args: [req.kind, max]
    });

    const payload = (result || {}) as any;
    relay.send(
      {
        t: 'extract_result',
        requestId: req.requestId,
        ok: true,
        tabId: req.tabId,
        url: payload.url,
        title: payload.title,
        items: Array.isArray(payload.items) ? payload.items : []
      } as any,
      'agent'
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    relay.send({ t: 'extract_result', requestId: req.requestId, ok: false, tabId: req.tabId, error } as any, 'agent');
  }
}

async function getControlledInfoForActiveTab(): Promise<{
  activeTabId: number | null;
  inGroup: boolean;
  groupId?: number;
  groupTitle?: string;
  groupColor?: string;
  title?: string;
  url?: string;
  hostname?: string;
  lastError?: string;
}> {
  let activeTabId: number | null = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) activeTabId = tab.id;

    if (!tab?.id) return { activeTabId, inGroup: false };
    const gid = (tab as any).groupId as number | undefined;
    if (typeof gid !== 'number' || gid < 0) {
      return { activeTabId, inGroup: false, title: tab.title, url: tab.url, hostname: safeHostname(tab.url) };
    }
    const g = await chrome.tabGroups.get(gid);
    const inGroup = g?.title === GROUP_TITLE;
    return {
      activeTabId,
      inGroup,
      groupId: gid,
      groupTitle: g?.title,
      groupColor: (g as any)?.color,
      title: tab.title,
      url: tab.url,
      hostname: safeHostname(tab.url)
    };
  } catch {
    return { activeTabId, inGroup: false };
  }
}

function safeHostname(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return undefined;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.t === 'popup_get_state') {
      const settings = await getSettings();

      // Auto-reconnect when popup opens so UX doesn't "forget" the connection.
      if (settings.autoConnect !== false) void ensureConnected();

      // Model 2: opening popup implicitly controls the active tab by placing it in the OpenClaw group.
      // BUT: if the user just detached this tab, don't immediately re-attach it.
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id != null) {
          // Clear the skip once the user changes active tabs.
          if (settings.skipAutoControlTabId != null && settings.skipAutoControlTabId !== tab.id) {
            await setSettings({ skipAutoControlTabId: undefined });
          }

          const refreshed = await getSettings();
          const shouldAutoControl =
            refreshed.autoControlOnPopupOpen !== false &&
            (refreshed.skipAutoControlTabId == null || refreshed.skipAutoControlTabId !== tab.id);

          if (shouldAutoControl) await ensureControlled(tab.id);
        }
      } catch {
        // ignore
      }

      const after = await getSettings();
      const controlled = await getControlledInfoForActiveTab();
      sendResponse({ ws: relay.state, settings: after, controlled });
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
      await setSettings({ autoConnect: true });
      const wsUrl = wsBaseFromHttp(settings.httpBase);
      reconnectAttempt = 0;
      relay.connect({ wsUrl, token: settings.token, clientId: settings.clientId });
      await updateBadge();
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'popup_disconnect') {
      await setSettings({ autoConnect: false });
      relay.disconnect();
      await updateBadge();
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'popup_detach_active_tab') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');
      // Prevent auto-control from immediately re-attaching this tab.
      await setSettings({ skipAutoControlTabId: tab.id });
      await removeTabFromGroup(tab.id);
      relay.send({ t: 'detach_tab', tabId: tab.id }, 'agent');
      await appendAudit({ ts: Date.now(), kind: 'tab_control', tabId: tab.id, detail: { kind: 'detached' } });
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'ws_closed') {
      void scheduleReconnect('ws_closed');
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'tab_event') {
      const tabId = sender.tab?.id;
      if (!tabId) return;
      if (!(await isControlledTab(tabId))) return;
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
