import type {
  Envelope,
  ActionRequest,
  OpenTabRequest,
  Message,
  ClientType,
  TabEvent,
  ExtractRequest,
  ExtractKind,
  ActionReceipt,
  WaitForUser,
  Resume,
  PageInfo,
  ExtractLink,
  ExtractFormField,
  ExtractClickable,
  ScreenshotRequest
} from '@openclaw/shared';
import type { WSState } from './ws';
import { appendAudit, getSettings, setSettings } from './storage';

let wsState: WSState = { status: 'disconnected' };

async function ensureOffscreenDocument() {
  // Keep WebSocket alive in an offscreen document so MV3 service worker suspension
  // doesn't tear down the connection.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offscreen: any = (chrome as any).offscreen;
  if (!offscreen?.createDocument) return;

  try {
    const has = (await offscreen.hasDocument?.()) as boolean | undefined;
    if (has) return;
  } catch {
    // ignore
  }

  try {
    await offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['IFRAME_SCRIPTING'],
      justification: 'Maintain a persistent WebSocket connection to the OpenClaw relay'
    });
  } catch {
    // ignore
  }
}

async function relayConnect(wsUrl: string, token: string, clientId: string) {
  await ensureOffscreenDocument();
  wsState = { status: 'connecting' };
  try {
    await chrome.runtime.sendMessage({ t: 'offscreen_connect', wsUrl, token, clientId });
  } catch {
    wsState = { status: 'disconnected', lastError: 'Failed to reach offscreen WebSocket host' };
    void updateBadge();
    void scheduleReconnect('offscreen_connect_failed');
  }
}

async function relayDisconnect() {
  try {
    await chrome.runtime.sendMessage({ t: 'offscreen_disconnect' });
  } catch {
    // ignore
  }
  wsState = { status: 'disconnected' };
}

function relaySend(msg: Message, to: ClientType) {
  // fire-and-forget; offscreen owns the websocket
  try {
    chrome.runtime.sendMessage({ t: 'offscreen_send', msg, to });
  } catch {
    // ignore
  }
}

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
        void relayConnect(wsUrl, token, settings.clientId);
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
  if (wsState.status === 'connected' || wsState.status === 'connecting') return;

  const wsUrl = wsBaseFromHttp(settings.httpBase);
  reconnectAttempt = 0;
  await relayConnect(wsUrl, settings.token, settings.clientId);
  await updateBadge();
}

async function updateBadge() {
  const settings = await getSettings();
  const connected = wsState.status === 'connected';

  // RAG badge: keep it simple.
  // Green = connected, Amber = connecting, Red = disconnected.
  const status = wsState.status;
  const dot = '●';

  if (status === 'connected') {
    await chrome.action.setBadgeText({ text: dot });
    await chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
    await chrome.action.setTitle({ title: 'OpenClaw (connected)' });
  } else if (status === 'connecting') {
    await chrome.action.setBadgeText({ text: dot });
    await chrome.action.setBadgeBackgroundColor({ color: '#f59f00' });
    await chrome.action.setTitle({ title: 'OpenClaw (connecting)' });
  } else {
    await chrome.action.setBadgeText({ text: dot });
    await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
    await chrome.action.setTitle({ title: wsState.lastError ? `OpenClaw (disconnected: ${wsState.lastError})` : 'OpenClaw (disconnected)' });
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
    const gid = tab.groupId;
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

  await announceAttachTab(tabId);
}

async function announceAttachTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) relaySend({ t: 'attach_tab', tabId, url: tab.url, title: tab.title }, 'agent');
    await appendAudit({ ts: Date.now(), kind: 'tab_control', tabId, detail: { kind: 'controlled', url: tab.url, title: tab.title } });
  } catch {
    // ignore
  }
}

async function reannounceControlledTabs() {
  // On reconnect, re-announce the active controlled tab (if any) so the agent regains context.
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id && (await isControlledTab(active.id))) {
      await ensureContentScript(active.id);
      try {
        await chrome.tabs.sendMessage(active.id, { t: 'set_controlled', on: true });
      } catch {}
      await announceAttachTab(active.id);
      return;
    }
  } catch {}

  // Fallback: find any controlled tab in current window.
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    for (const t of tabs) {
      if (!t.id) continue;
      if (await isControlledTab(t.id)) {
        await ensureContentScript(t.id);
        try {
          await chrome.tabs.sendMessage(t.id, { t: 'set_controlled', on: true });
        } catch {}
        await announceAttachTab(t.id);
        break;
      }
    }
  } catch {
    // ignore
  }
}

async function showNotification(opts: { title: string; message: string }) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-48.png',
      title: opts.title,
      message: opts.message
    });
  } catch {
    // ignore (permission missing or disabled)
  }
}

async function showWaitingBanner(tabId: number, message: string) {
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { t: 'set_waiting', on: true, message });
  } catch {
    // ignore
  }
}

async function handleRelayEnvelope(env: Envelope) {
  const msg = env.msg;
  if (msg.t === 'action_request') {
    await handleActionRequest(msg);
  }
  if (msg.t === 'open_tab_request') {
    await handleOpenTabRequest(msg);
  }
  if (msg.t === 'extract_request') {
    await handleExtractRequest(msg as ExtractRequest);
  }
  if (msg.t === 'screenshot_request') {
    await handleScreenshotRequest(msg as ScreenshotRequest);
  }
  if (msg.t === 'wait_for_user') {
    await handleWaitForUser(msg as WaitForUser);
  }
  if (msg.t === 'resume') {
    await handleResume(msg as Resume);
  }
}

async function isAllowedForTab(
  tabId: number,
  opts?: { requireActions?: boolean },
): Promise<{ ok: boolean; reason?: string; url?: string }> {
  const settings = await getSettings();
  const requireActions = opts?.requireActions !== false;
  if (requireActions && !settings.allowActions) return { ok: false, reason: 'Allow Actions is disabled' };

  if (!(await isControlledTab(tabId))) return { ok: false, reason: 'Tab is not in the OpenClaw tab group' };

  const tab = await chrome.tabs.get(tabId);
  const urlStr = tab.url || '';
  try {
    new URL(urlStr);
  } catch {
    return { ok: false, reason: 'Tab URL is not a valid URL', url: urlStr };
  }

  // v0.3.0+: no allowlist (experimental); actions/extraction are allowed on any valid URL
  // as long as the tab is controlled (in the OpenClaw group). Actions additionally require Allow Actions.
  return { ok: true, url: urlStr };
}

async function handleActionRequest(req: ActionRequest) {
  const allowed = await isAllowedForTab(req.tabId);
  if (!allowed.ok) {
    await appendAudit({ ts: Date.now(), kind: 'security_block', tabId: req.tabId, detail: { req, reason: allowed.reason, url: allowed.url } });

    const reason = allowed.reason || 'Blocked by extension security policy';
    let hint = reason;
    if (reason.toLowerCase().includes('allow actions')) {
      hint = `${reason}. Turn ON “Allow Actions” in the extension popup.`;
    } else if (reason.toLowerCase().includes('tab is not')) {
      hint = `${reason}. Open the extension popup and click “Start controlling this tab”.`;
    }

    // Tell the agent to hand off (so it can message the user), AND show an in-page banner.
    try {
      relaySend({ t: 'wait_for_user', requestId: req.requestId, tabId: req.tabId, message: hint }, 'agent');
    } catch {
      // ignore
    }
    await showWaitingBanner(req.tabId, hint);
    await showNotification({ title: 'OpenClaw needs you', message: hint });

    relaySend({ t: 'action_result', requestId: req.requestId, ok: false, error: reason }, 'agent');
    return;
  }

  try {
    if (req.action === 'navigate') {
      if (!req.url) throw new Error('navigate requires url');
      await chrome.tabs.update(req.tabId, { url: req.url });
      await waitForTabComplete(req.tabId, 8000).catch(() => {});
    } else {
      // Ensure content script exists
      await ensureContentScript(req.tabId);
      try {
        await chrome.tabs.sendMessage(req.tabId, { t: 'do_action', req });
      } catch (e: unknown) {
        // If the receiving end isn't there yet, inject and retry once.
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Receiving end does not exist')) {
          await ensureContentScript(req.tabId);
          await chrome.tabs.sendMessage(req.tabId, { t: 'do_action', req });
        } else {
          throw e;
        }
      }
    }

    // Best-effort post-action receipt ("hands" confirmation)
    const receipt = await collectActionReceipt(req.tabId).catch(() => undefined);

    await appendAudit({ ts: Date.now(), kind: 'action', tabId: req.tabId, detail: { req, receipt } });
    relaySend({ t: 'action_result', requestId: req.requestId, ok: true, receipt }, 'agent');
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const receipt = await collectActionReceipt(req.tabId).catch(() => undefined);
    await appendAudit({ ts: Date.now(), kind: 'action', tabId: req.tabId, detail: { req, error, receipt } });
    relaySend({ t: 'action_result', requestId: req.requestId, ok: false, error, receipt }, 'agent');
  }
}

async function handleOpenTabRequest(req: OpenTabRequest) {
  const settings = await getSettings();
  if (!settings.allowActions) {
    await showNotification({ title: 'OpenClaw action blocked', message: 'Allow Actions is disabled. Turn ON “Allow Actions” in the extension popup.' });
    relaySend({ t: 'open_tab_result', requestId: req.requestId, ok: false, error: 'Allow Actions is disabled' }, 'agent');
    return;
  }
  try {
    new URL(req.url);
  } catch {
    relaySend({ t: 'open_tab_result', requestId: req.requestId, ok: false, error: 'Invalid URL' }, 'agent');
    return;
  }

  try {
    const tab = await chrome.tabs.create({ url: req.url, active: true });
    await appendAudit({ ts: Date.now(), kind: 'open_tab', tabId: tab.id, detail: { url: req.url } });

    // Model 2: agent-opened tabs are controlled by default.
    if (tab.id) {
      await ensureControlled(tab.id);
    }

    relaySend({ t: 'open_tab_result', requestId: req.requestId, ok: true, tabId: tab.id }, 'agent');
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    relaySend({ t: 'open_tab_result', requestId: req.requestId, ok: false, error }, 'agent');
  }
}

async function handleExtractRequest(req: ExtractRequest) {
  // "Eyes" should work even if Allow Actions is disabled.
  const allowed = await isAllowedForTab(req.tabId, { requireActions: false });
  if (!allowed.ok) {
    relaySend({ t: 'extract_result', requestId: req.requestId, ok: false, tabId: req.tabId, kind: req.kind, error: allowed.reason }, 'agent');
    return;
  }

  const max = Math.max(1, Math.min(100, req.max ?? 25));

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: req.tabId },
      func: (kind: ExtractKind, max: number) => {
        const pageInfo = { url: location.href, title: document.title, readyState: document.readyState };

        const isVisible = (el: Element): boolean => {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };

        const cssPath = (el: Element, opts?: { stopAt?: Element | null }): string => {
          const parts: string[] = [];
          let cur: Element | null = el;
          const stopAt = opts?.stopAt ?? null;
          while (cur && cur !== stopAt && parts.length < 5) {
            let part = cur.tagName.toLowerCase();
            const id = cur.getAttribute('id');
            if (id) {
              part += `#${CSS.escape(id)}`;
              parts.unshift(part);
              break;
            }
            const cls = (cur.getAttribute('class') || '')
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((c) => `.${CSS.escape(c)}`)
              .join('');
            if (cls) part += cls;
            parts.unshift(part);
            cur = cur.parentElement;
          }
          return parts.join(' > ');
        };

        const pierceSelector = (el: Element): string => {
          const root = el.getRootNode();
          if (root && root instanceof ShadowRoot && root.host instanceof Element) {
            const hostSel = pierceSelector(root.host);
            const innerSel = cssPath(el, { stopAt: root.host });
            return `${hostSel} >>> ${innerSel}`;
          }
          return cssPath(el);
        };

        const allRoots = (): Array<Document | ShadowRoot> => {
          // Include document + open shadow roots + same-origin iframes.
          const roots: Array<Document | ShadowRoot> = [document];
          const seen = new Set<any>();
          for (let i = 0; i < roots.length; i++) {
            const r = roots[i]!;
            if (seen.has(r)) continue;
            seen.add(r);
            const nodes = (r as any).querySelectorAll ? (r as any).querySelectorAll('*') : [];
            for (const el of Array.from(nodes) as Element[]) {
              const sr = (el as any).shadowRoot as ShadowRoot | undefined;
              if (sr) roots.push(sr);

              if (el instanceof HTMLIFrameElement) {
                try {
                  const doc = el.contentDocument;
                  if (doc) roots.push(doc);
                } catch {
                  // cross-origin iframe
                }
              }
            }
          }
          return roots;
        };

        const getLabelFor = (el: Element): { label?: string; ariaLabel?: string } => {
          let label: string | undefined;
          let ariaLabel: string | undefined;

          const aria = (el.getAttribute('aria-label') || '').trim();
          if (aria) ariaLabel = aria.slice(0, 200);

          const labelledBy = (el.getAttribute('aria-labelledby') || '').trim();
          if (labelledBy) {
            const id = labelledBy.split(/\s+/)[0];
            const lab = id ? document.getElementById(id) : null;
            const txt = (lab?.textContent || '').trim();
            if (txt) ariaLabel = (ariaLabel ? `${ariaLabel} / ` : '') + txt.slice(0, 200);
          }

          if (el instanceof HTMLElement) {
            const id = el.getAttribute('id');
            if (id) {
              const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
              const txt = (l?.textContent || '').trim();
              if (txt) label = txt.slice(0, 200);
            }
            if (!label) {
              const wrap = el.closest('label');
              const txt = (wrap?.textContent || '').trim();
              if (txt) label = txt.slice(0, 200);
            }
          }

          return { label, ariaLabel };
        };

        if (kind === 'page_info') {
          return { pageInfo };
        }

        if (kind === 'readable_text') {
          const root =
            (document.querySelector('main') ||
              document.querySelector('article') ||
              document.querySelector('[role="main"]') ||
              document.body) as HTMLElement | null;
          const raw = (root?.innerText || '').trim();
          const text = raw.replace(/\s+/g, ' ').slice(0, 20000);
          return { pageInfo, readableText: { text } };
        }

        if (kind === 'links') {
          const links: Array<{ text: string; url: string }> = [];
          const seen = new Set<string>();
          for (const root of allRoots()) {
            const anchors = Array.from((root as any).querySelectorAll?.('a[href]') || []) as HTMLAnchorElement[];
            for (const a of anchors) {
              const txt = (a.textContent || '').trim().replace(/\s+/g, ' ');
              if (!txt) continue;
              const hrefRaw = a.getAttribute('href') || '';
              if (!hrefRaw) continue;
              try {
                const url = new URL(hrefRaw, location.href).toString();
                if (seen.has(url)) continue;
                seen.add(url);
                links.push({ text: txt.slice(0, 200), url });
                if (links.length >= max) break;
              } catch {
                continue;
              }
            }
            if (links.length >= max) break;
          }
          return { pageInfo, links: { links } };
        }

        if (kind === 'forms') {
          const fields: Array<{
            tag: 'input' | 'textarea' | 'select' | 'button';
            type?: string;
            name?: string;
            id?: string;
            label?: string;
            ariaLabel?: string;
            placeholder?: string;
            value?: string;
            selector: string;
          }> = [];

          for (const root of allRoots()) {
            const els = Array.from((root as any).querySelectorAll?.('input, textarea, select, button') || []) as Array<
              HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
            >;

            for (const el of els) {
              if (!isVisible(el)) continue;
              const tag = el.tagName.toLowerCase() as 'input' | 'textarea' | 'select' | 'button';
              const { label, ariaLabel } = getLabelFor(el);
              const type = el instanceof HTMLInputElement ? (el.type || undefined) : undefined;
              const name = (el.getAttribute('name') || '').trim() || undefined;
              const id = (el.getAttribute('id') || '').trim() || undefined;
              const placeholder = (el.getAttribute('placeholder') || '').trim().slice(0, 200) || undefined;
              let value: string | undefined;
              if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
                try {
                  if ('value' in el) value = String(el.value ?? '').slice(0, 200) || undefined;
                } catch {
                  // ignore
                }
              }

              fields.push({ tag, type, name, id, label, ariaLabel, placeholder, value, selector: pierceSelector(el) });
              if (fields.length >= max) break;
            }
            if (fields.length >= max) break;
          }
          return { pageInfo, forms: { fields } };
        }

        // visible_clickables
        const clickables: Array<{ role: string; name: string; selector: string; url?: string }> = [];
        for (const root of allRoots()) {
          const candidates = Array.from(
            (root as any).querySelectorAll?.('a[href], button, [role="button"], input[type="button"], input[type="submit"]') || [],
          ) as Element[];

          for (const el of candidates) {
            if (!isVisible(el)) continue;

            const role = (el.getAttribute('role') || el.tagName.toLowerCase()) as string;

            const name =
              (el.getAttribute('aria-label') || '').trim() ||
              (el instanceof HTMLInputElement ? (el.value || '').trim() : '') ||
              (el.textContent || '').trim();
            if (!name) continue;

            let url: string | undefined;
            if (el instanceof HTMLAnchorElement) {
              try {
                url = new URL(el.getAttribute('href') || '', location.href).toString();
              } catch {
                // ignore
              }
            }

            clickables.push({ role, name: name.replace(/\s+/g, ' ').slice(0, 200), selector: pierceSelector(el), url });
            if (clickables.length >= max) break;
          }
          if (clickables.length >= max) break;
        }

        return { pageInfo, visibleClickables: { clickables } };
      },
      args: [req.kind, max]
    });

    type ExtractScriptPayload = {
      pageInfo: PageInfo;
      readableText?: { text: string };
      links?: { links: ExtractLink[] };
      forms?: { fields: ExtractFormField[] };
      visibleClickables?: { clickables: ExtractClickable[] };
    };

    const payload: ExtractScriptPayload = (result ?? null) as ExtractScriptPayload;

    relaySend(
      {
        t: 'extract_result',
        requestId: req.requestId,
        ok: true,
        tabId: req.tabId,
        kind: req.kind,
        pageInfo: payload.pageInfo,
        readableText: payload.readableText,
        links: payload.links,
        forms: payload.forms,
        visibleClickables: payload.visibleClickables
      },
      'agent'
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    relaySend({ t: 'extract_result', requestId: req.requestId, ok: false, tabId: req.tabId, kind: req.kind, error }, 'agent');
  }
}

async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return await new Promise((resolve, reject) => {
    const started = Date.now();

    const timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        cleanup();
        reject(new Error('timeout'));
      }
    }, 250) as unknown as number;

    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id !== tabId) return;
      if (info.status === 'complete') {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      clearInterval(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    // Fast-path: already complete.
    void chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') {
          cleanup();
          resolve();
        }
      })
      .catch(() => {});
  });
}

async function collectActionReceipt(tabId: number): Promise<ActionReceipt> {
  // Avoid blocking on restricted pages.
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const url = location.href;
      const title = document.title;
      const readyState = document.readyState;

      const root =
        (document.querySelector('main') ||
          document.querySelector('article') ||
          document.querySelector('[role="main"]') ||
          document.body) as HTMLElement | null;

      const excerpt = (root?.innerText || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 500);

      const banners: string[] = [];
      const candidates = Array.from(
        document.querySelectorAll('[role="alert"], .alert, .alert-danger, .error, .flash-error, [data-test*="error"], [data-testid*="error"]'),
      ) as Element[];
      for (const el of candidates) {
        const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
        if (!txt) continue;
        banners.push(txt.slice(0, 300));
        if (banners.length >= 3) break;
      }

      return { url, title, readyState, excerpt, errorBanners: banners };
    }
  });

  type ReceiptScriptPayload = {
    url?: string;
    title?: string;
    readyState?: ActionReceipt['readyState'];
    excerpt?: string;
    errorBanners?: string[];
  };

  const r: ReceiptScriptPayload = (result ?? {}) as ReceiptScriptPayload;
  return {
    url: typeof r.url === 'string' ? r.url : undefined,
    title: typeof r.title === 'string' ? r.title : undefined,
    readyState: r.readyState,
    excerpt: typeof r.excerpt === 'string' ? r.excerpt : undefined,
    errorBanners: Array.isArray(r.errorBanners) ? r.errorBanners : undefined
  };
}

async function handleWaitForUser(req: WaitForUser) {
  const allowed = await isAllowedForTab(req.tabId, { requireActions: false });
  if (!allowed.ok) return;

  const msg = req.message || 'Waiting for user…';
  await showWaitingBanner(req.tabId, msg);
  await showNotification({ title: 'OpenClaw: waiting for you', message: msg });
}

async function handleScreenshotRequest(req: ScreenshotRequest) {
  const allowed = await isAllowedForTab(req.tabId, { requireActions: false });
  if (!allowed.ok) {
    relaySend({ t: 'screenshot_result', requestId: req.requestId, ok: false, tabId: req.tabId, error: allowed.reason }, 'agent');
    return;
  }

  // captureVisibleTab only captures the ACTIVE tab in a window. We'll best-effort activate the tab,
  // capture, then restore the previously active tab.
  try {
    const tab = await chrome.tabs.get(req.tabId);
    const windowId = tab.windowId;

    const [prevActive] = await chrome.tabs.query({ windowId, active: true });

    if (!tab.active) {
      await chrome.tabs.update(req.tabId, { active: true });
      // give the page a beat to paint
      await new Promise((r) => setTimeout(r, 250));
    }

    const quality = Math.max(10, Math.min(95, req.quality ?? 60));
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality });

    // Restore previous tab if we changed focus
    try {
      if (prevActive?.id && prevActive.id !== req.tabId) await chrome.tabs.update(prevActive.id, { active: true });
    } catch {
      // ignore
    }

    let pageInfo: PageInfo | undefined;
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: req.tabId },
        func: () => ({ url: location.href, title: document.title, readyState: document.readyState })
      });
      const pi = (r?.result || null) as any;
      if (pi?.url && pi?.title && pi?.readyState) pageInfo = pi as PageInfo;
    } catch {
      // ignore
    }

    relaySend({ t: 'screenshot_result', requestId: req.requestId, ok: true, tabId: req.tabId, dataUrl, pageInfo }, 'agent');
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    relaySend({ t: 'screenshot_result', requestId: req.requestId, ok: false, tabId: req.tabId, error }, 'agent');
  }
}

async function handleResume(req: Resume) {
  const allowed = await isAllowedForTab(req.tabId, { requireActions: false });
  if (!allowed.ok) {
    relaySend({ t: 'resume_ack', requestId: req.requestId, ok: false, tabId: req.tabId, error: allowed.reason }, 'agent');
    return;
  }

  await ensureContentScript(req.tabId);
  try {
    await chrome.tabs.sendMessage(req.tabId, { t: 'set_waiting', on: false });
  } catch {
    // ignore
  }

  // Acknowledge + send fresh page_info extraction.
  try {
    const receipt = await collectActionReceipt(req.tabId);
    relaySend(
      {
        t: 'resume_ack',
        requestId: req.requestId,
        ok: true,
        tabId: req.tabId,
        pageInfo: receipt.url && receipt.title && receipt.readyState ? { url: receipt.url, title: receipt.title, readyState: receipt.readyState } : undefined
      },
      'agent'
    );

    // Also emit an extract_result (page_info) so agents that only listen for extracts can refresh state.
    if (receipt.url && receipt.title && receipt.readyState) {
      relaySend(
        {
          t: 'extract_result',
          requestId: req.requestId,
          ok: true,
          tabId: req.tabId,
          kind: 'page_info',
          pageInfo: { url: receipt.url, title: receipt.title, readyState: receipt.readyState }
        },
        'agent'
      );
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    relaySend({ t: 'resume_ack', requestId: req.requestId, ok: false, tabId: req.tabId, error }, 'agent');
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
    const gid = tab.groupId;
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
      groupColor: g?.color,
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

let lastAnnounce: { tabId: number; ts: number } | null = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.t === 'popup_get_state') {
      const settings = await getSettings();

      // Auto-reconnect when popup opens so UX doesn't "forget" the connection.
      if (settings.autoConnect !== false) void ensureConnected();

      // Always prefer the offscreen-reported state (source of truth).
      try {
        const r = (await chrome.runtime.sendMessage({ t: 'offscreen_get_state' })) as { ok?: boolean; state?: WSState };
        if (r?.state) wsState = r.state;
      } catch {
        // ignore
      }

      // v0.4.4: opening the popup must NOT implicitly control whatever active tab happens to be focused.
      // Tabs are only controlled when the user explicitly clicks Start, or when the agent opens a tab.

      const after = await getSettings();
      const controlled = await getControlledInfoForActiveTab();

      // If the tab is already controlled, re-announce it opportunistically while the popup is open.
      // This fixes cases where WS reconnected after Start, and the original attach_tab got dropped.
      try {
        if (wsState.status === 'connected' && controlled.inGroup && controlled.activeTabId) {
          const now = Date.now();
          const should =
            !lastAnnounce ||
            lastAnnounce.tabId !== controlled.activeTabId ||
            now - lastAnnounce.ts > 4000;
          if (should) {
            lastAnnounce = { tabId: controlled.activeTabId, ts: now };
            void announceAttachTab(controlled.activeTabId);
          }
        }
      } catch {
        // ignore
      }

      sendResponse({ ok: true, ws: wsState, settings: after, controlled });
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
      await relayConnect(wsUrl, settings.token, settings.clientId);
      await updateBadge();
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'popup_disconnect') {
      await setSettings({ autoConnect: false });
      await relayDisconnect();
      await updateBadge();
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'popup_start_control_active_tab') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');
      // If the user previously hit Stop, clear the skip so Start works immediately.
      const settings = await getSettings();
      if (settings.skipAutoControlTabId === tab.id) await setSettings({ skipAutoControlTabId: undefined });
      await ensureControlled(tab.id);
      sendResponse({ ok: true });
      return;
    }


    if (msg?.t === 'popup_detach_active_tab') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');
      // Prevent auto-control from immediately re-attaching this tab.
      await setSettings({ skipAutoControlTabId: tab.id });
      await removeTabFromGroup(tab.id);
      relaySend({ t: 'detach_tab', tabId: tab.id }, 'agent');
      await appendAudit({ ts: Date.now(), kind: 'tab_control', tabId: tab.id, detail: { kind: 'detached' } });
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'ws_env') {
      const env = msg.env as Envelope;
      await handleRelayEnvelope(env);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'ws_closed') {
      wsState = { status: 'disconnected' };
      void updateBadge();
      void scheduleReconnect('ws_closed');
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'ws_error') {
      wsState = { status: 'disconnected', lastError: 'WebSocket error' };
      void updateBadge();
      void scheduleReconnect('ws_error');
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'ws_open') {
      wsState = { status: 'connected' };
      void updateBadge();
      void reannounceControlledTabs();
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'tab_event') {
      const tabId = sender.tab?.id;
      if (!tabId) return;
      if (!(await isControlledTab(tabId))) return;

      const ev = msg.event as unknown;
      if (!ev || typeof ev !== 'object') return;
      const maybe = ev as { t?: unknown };
      if (maybe.t !== 'tab_event') return;

      const event = ev as TabEvent;
      relaySend({ ...event, tabId }, 'agent');
      return;
    }
  })()
    .then(() => true)
    .catch((e) => {
      // Don't hijack messages intended for the offscreen document.
    // chrome.runtime.sendMessage broadcasts; the first responder wins.
    // If we respond here for offscreen_* requests, the caller will see bogus "unknown message".
    if (msg?.t && typeof msg.t === 'string' && msg.t.startsWith('offscreen_')) {
      return;
    }
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });

  // For offscreen_* messages, do not keep the channel open here (let offscreen respond).
  if (msg?.t && typeof msg.t === 'string' && msg.t.startsWith('offscreen_')) {
    return false;
  }

  return true;
});

chrome.storage.onChanged.addListener(() => {
  void updateBadge();
  void ensureConnected();
});

const KEEPALIVE_ALARM = 'openclaw_keepalive';

async function ensureKeepaliveAlarm() {
  try {
    // Wake the service worker periodically so it can re-connect if Chrome suspends it.
    // (MV3 can drop long-lived connections when the worker goes idle.)
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  } catch {
    // ignore
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a?.name !== KEEPALIVE_ALARM) return;
  void ensureConnected();
  void updateBadge();
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureKeepaliveAlarm();
  void ensureConnected();
});

chrome.runtime.onStartup?.addListener(() => {
  void ensureKeepaliveAlarm();
  void ensureConnected();
});

void ensureKeepaliveAlarm();
void ensureConnected();
void updateBadge();
