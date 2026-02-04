import type { ActionRequest, TabEvent } from '@openclaw/shared';

function cssPath(el: Element): string {
  // best-effort readable selector
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && parts.length < 4) {
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

function sendEvent(kind: TabEvent['kind'], data: Omit<TabEvent, 't' | 'tabId' | 'kind'>) {
  const event: TabEvent = { t: 'tab_event', tabId: -1, kind, ...data };
  chrome.runtime.sendMessage({ t: 'tab_event', event }).catch(() => {});
}

window.addEventListener('click', (e) => {
  const t = e.target;
  if (t instanceof Element) {
    sendEvent('click', { selector: cssPath(t), x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY, url: location.href, title: document.title });
  }
}, true);

window.addEventListener('input', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
    sendEvent('input', { selector: cssPath(t), value: t.value.slice(0, 200), url: location.href, title: document.title });
  }
}, true);

window.addEventListener('scroll', () => {
  sendEvent('scroll', { x: window.scrollX, y: window.scrollY, url: location.href, title: document.title });
}, { passive: true });

// basic navigation ping
let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    sendEvent('navigation', { url: location.href, title: document.title });
  }
}, 1000);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.t === 'do_action') {
      const req: ActionRequest = msg.req;
      if (req.action === 'scroll') {
        window.scrollTo({ left: req.x ?? window.scrollX, top: req.y ?? window.scrollY, behavior: 'instant' as any });
      }

      if (req.action === 'click') {
        if (!req.selector) throw new Error('click requires selector');
        const el = document.querySelector(req.selector) as HTMLElement | null;
        if (!el) throw new Error(`selector not found: ${req.selector}`);
        el.click();
      }

      if (req.action === 'type') {
        if (!req.selector) throw new Error('type requires selector');
        const el = document.querySelector(req.selector) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
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
