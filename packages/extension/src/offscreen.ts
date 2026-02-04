import type { Envelope, Message, ClientType } from '@openclaw/shared';
import { RelayWS } from './ws';

const relay = new RelayWS();

relay.onMessage((env: Envelope) => {
  // Forward to background service worker.
  try {
    chrome.runtime.sendMessage({ t: 'ws_env', env });
  } catch {
    // ignore
  }
});

async function connect(opts: { wsUrl: string; token: string; clientId: string }) {
  relay.connect(opts);
}

// Best-effort: ensure the offscreen context doesn't get reclaimed too aggressively.
// (Chrome can still suspend, but this helps keep the event loop warm.)
setInterval(() => {
  // no-op
}, 30_000);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.t === 'offscreen_connect') {
      await connect({ wsUrl: msg.wsUrl, token: msg.token, clientId: msg.clientId });
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'offscreen_disconnect') {
      relay.disconnect();
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'offscreen_send') {
      const m = msg.msg as Message;
      const to = msg.to as ClientType;
      relay.send(m, to);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.t === 'offscreen_get_state') {
      sendResponse({ ok: true, state: relay.state });
      return;
    }

    sendResponse({ ok: false, error: 'unknown message' });
  })();

  // keep message channel open for async response
  return true;
});
