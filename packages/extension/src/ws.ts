import type { Envelope, Message, ClientType } from '@openclaw/shared';
import { makeId } from '@openclaw/shared';

export type WSState = {
  status: 'disconnected' | 'connecting' | 'connected';
  lastError?: string;
};

export class RelayWS {
  private ws: WebSocket | null = null;
  public state: WSState = { status: 'disconnected' };
  private token: string | null = null;
  private clientId: string | null = null;
  private url: string | null = null;
  private listeners: Array<(env: Envelope) => void> = [];

  onMessage(fn: (env: Envelope) => void) {
    this.listeners.push(fn);
  }

  connect(opts: { wsUrl: string; token: string; clientId: string }) {
    this.disconnect();
    this.token = opts.token;
    this.clientId = opts.clientId;
    this.url = `${opts.wsUrl}?token=${encodeURIComponent(opts.token)}&client=extension&clientId=${encodeURIComponent(opts.clientId)}`;

    this.state = { status: 'connecting' };
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.state = { status: 'connected' };
      this.send({ t: 'hello', clientId: opts.clientId, name: 'OpenClaw Chrome Extension' }, 'agent');
    };
    ws.onclose = () => {
      this.state = { status: 'disconnected' };
      // background will decide whether to reconnect
      try {
        chrome.runtime.sendMessage({ t: 'ws_closed' });
      } catch {}
    };
    ws.onerror = () => {
      this.state = { status: 'disconnected', lastError: 'WebSocket error' };
      // Allow background to decide whether to reconnect.
      try {
        chrome.runtime.sendMessage({ t: 'ws_error' });
      } catch {}
    };
    ws.onmessage = (ev) => {
      try {
        const env = JSON.parse(String(ev.data)) as Envelope;
        for (const l of this.listeners) l(env);
      } catch {
        // ignore
      }
    };
  }

  disconnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }
    this.ws = null;
    this.state = { status: 'disconnected' };
  }

  send(msg: Message, to: ClientType) {
    if (!this.ws || this.state.status !== 'connected') return;
    if (!this.token) return;
    const env: Envelope = {
      v: 1,
      id: makeId('env'),
      ts: Date.now(),
      token: this.token,
      from: 'extension',
      to,
      msg
    };
    this.ws.send(JSON.stringify(env));
  }
}
