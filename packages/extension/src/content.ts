import type { ActionRequest, TabEvent } from '@openclaw/shared';

let IS_CONTROLLED = false;
let WAITING_OVERLAY: HTMLDivElement | null = null;

// v0.3.1: removed the in-page pill/label overlay. The red border + tab group are enough.
// v0.4.0: add a minimal, explicit "waiting for user" banner for handoff/resume.

function setControlled(on: boolean) {
  IS_CONTROLLED = on;
  if (on) {
    try {
      document.documentElement.style.outline = '3px solid rgba(200, 18, 18, 0.95)';
      document.documentElement.style.outlineOffset = '-3px';
    } catch {}
  } else {
    try {
      document.documentElement.style.outline = '';
      document.documentElement.style.outlineOffset = '';
    } catch {}
    setWaiting(false);
  }
}

function setWaiting(on: boolean, message?: string) {
  if (!IS_CONTROLLED) return;

  if (!on) {
    if (WAITING_OVERLAY) {
      try {
        WAITING_OVERLAY.remove();
      } catch {}
      WAITING_OVERLAY = null;
    }
    return;
  }

  if (!WAITING_OVERLAY) {
    const div = document.createElement('div');
    div.id = '__openclaw_waiting__';
    div.style.position = 'fixed';
    div.style.top = '12px';
    div.style.right = '12px';
    div.style.zIndex = '2147483647';
    div.style.maxWidth = '360px';
    div.style.padding = '10px 12px';
    div.style.background = 'rgba(200, 18, 18, 0.95)';
    div.style.color = 'white';
    div.style.borderRadius = '10px';
    div.style.font = '13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    div.style.boxShadow = '0 8px 24px rgba(0,0,0,0.25)';

    const title = document.createElement('div');
    title.textContent = 'OpenClaw: waiting for user';
    title.style.fontWeight = '700';
    title.style.marginBottom = '6px';

    const body = document.createElement('div');
    body.textContent = message || 'Please take over in the browser, then click Resume in your agent.';
    body.style.opacity = '0.95';

    div.appendChild(title);
    div.appendChild(body);
    document.documentElement.appendChild(div);
    WAITING_OVERLAY = div;
  } else {
    const body = WAITING_OVERLAY.querySelector('div:nth-child(2)') as HTMLDivElement | null;
    if (body) body.textContent = message || 'Please take over in the browser, then click Resume in your agent.';
  }
}

function cssPath(el: Element, opts?: { stopAt?: Element | null }): string {
  // best-effort readable selector
  const parts: string[] = [];
  let cur: Element | null = el;
  const stopAt = opts?.stopAt ?? null;
  while (cur && cur !== stopAt && parts.length < 4) {
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
}

function pierceSelector(el: Element): string {
  // Build a selector chain that can traverse shadow roots using " >>> " delimiter.
  const root = el.getRootNode();
  if (root && root instanceof ShadowRoot && root.host instanceof Element) {
    const hostSel = pierceSelector(root.host);
    const innerSel = cssPath(el, { stopAt: root.host });
    return `${hostSel} >>> ${innerSel}`;
  }
  return cssPath(el);
}

function querySelectorPierce(selector: string): Element | null {
  // Supports either:
  //  - normal selectors (querySelector)
  //  - shadow-piercing chain: "host >>> inner >>> deeper"
  const parts = selector.split('>>>').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;

  let currentRoot: Document | ShadowRoot | Element = document;
  let found: Element | null = null;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;

    const qs = (root: any): Element | null => {
      try {
        return root?.querySelector ? (root.querySelector(part) as Element | null) : null;
      } catch {
        return null;
      }
    };

    // If this is the first part and it isn't found in document, try a deep search across shadow roots.
    if (i === 0) {
      found = qs(currentRoot);
      if (!found) {
        found = querySelectorDeep(part);
      }
    } else {
      found = qs(currentRoot);
    }

    if (!found) return null;

    const nextRoot = (found as any).shadowRoot as ShadowRoot | undefined;
    currentRoot = nextRoot || found;
  }

  return found;
}

function querySelectorDeep(part: string): Element | null {
  // Best-effort: search document + open shadow roots.
  const queue: Array<Document | ShadowRoot> = [document];
  const seen = new Set<any>();
  while (queue.length) {
    const root = queue.shift()!;
    if (seen.has(root)) continue;
    seen.add(root);

    try {
      const hit = root.querySelector(part) as Element | null;
      if (hit) return hit;
    } catch {
      // ignore
    }

    // Walk elements in this root; enqueue any shadow roots.
    const tree = (root as any).querySelectorAll ? (root as any).querySelectorAll('*') : [];
    for (const el of Array.from(tree) as Element[]) {
      const sr = (el as any).shadowRoot as ShadowRoot | undefined;
      if (sr) queue.push(sr);
    }
  }
  return null;
}

function sendEvent(kind: TabEvent['kind'], data: Omit<TabEvent, 't' | 'tabId' | 'kind'>) {
  if (!IS_CONTROLLED) return;
  const event: TabEvent = { t: 'tab_event', tabId: -1, kind, ...data };
  chrome.runtime.sendMessage({ t: 'tab_event', event }).catch(() => {});
}

window.addEventListener(
  'click',
  (e) => {
    if (!IS_CONTROLLED) return;
    const t = e.target;
    if (t instanceof Element) {
      sendEvent('click', {
        selector: pierceSelector(t),
        x: (e as MouseEvent).clientX,
        y: (e as MouseEvent).clientY,
        url: location.href,
        title: document.title
      });
    }
  },
  true,
);

window.addEventListener(
  'input',
  (e) => {
    if (!IS_CONTROLLED) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
      sendEvent('input', { selector: pierceSelector(t), value: t.value.slice(0, 200), url: location.href, title: document.title });
    }
  },
  true,
);

window.addEventListener(
  'scroll',
  () => {
    if (!IS_CONTROLLED) return;
    sendEvent('scroll', { x: window.scrollX, y: window.scrollY, url: location.href, title: document.title });
  },
  { passive: true },
);

// basic navigation ping
let lastHref = location.href;
setInterval(() => {
  if (!IS_CONTROLLED) return;
  if (location.href !== lastHref) {
    lastHref = location.href;
    sendEvent('navigation', { url: location.href, title: document.title });
  }
}, 1000);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.t === 'set_controlled') {
      setControlled(!!msg.on);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'set_waiting') {
      setWaiting(!!msg.on, typeof msg.message === 'string' ? msg.message : undefined);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'do_action') {
      const req: ActionRequest = msg.req;
      if (req.action === 'scroll') {
        window.scrollTo({ left: req.x ?? window.scrollX, top: req.y ?? window.scrollY, behavior: 'auto' });
      }

      if (req.action === 'click') {
        if (!req.selector) throw new Error('click requires selector');
        const el = querySelectorPierce(req.selector) as HTMLElement | null;
        if (!el) throw new Error(`selector not found: ${req.selector}`);
        el.click();
      }

      if (req.action === 'type') {
        if (!req.selector) throw new Error('type requires selector');
        const el = querySelectorPierce(req.selector) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
        if (!el) throw new Error(`selector not found: ${req.selector}`);

        const text = req.text ?? '';
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.focus();
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          (el as HTMLElement).focus();
          document.execCommand('insertText', false, text);
        }
      }

      sendResponse({ ok: true });
      return;
    }
  })().catch((e) => {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  });

  return true;
});
