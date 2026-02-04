export type ClientType = 'extension' | 'agent';

export type RelayFingerprint = {
  /** Full stable fingerprint (hex). */
  full: string;
  /** Short display form (e.g. first 4 chars of full). */
  short: string;
};

export type PairRequestResponse = {
  clientId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number; // epoch ms
  fingerprint?: RelayFingerprint;
};

export type PairPollResponse =
  | { status: 'pending' }
  | { status: 'verified'; token: string };

export type Envelope<T extends Message = Message> = {
  v: 1;
  id: string;
  ts: number;
  token: string;
  from: ClientType;
  to: ClientType;
  msg: T;
};

export type Message =
  | Hello
  | PairStatus
  | AttachTab
  | DetachTab
  | TabEvent
  | ActionRequest
  | ActionResult
  | OpenTabRequest
  | OpenTabResult
  | ExtractRequest
  | ExtractResult
  | Ping;

export type Hello = {
  t: 'hello';
  clientId: string;
  name?: string;
};

export type PairStatus = {
  t: 'pair_status';
  status: 'paired' | 'unpaired';
};

export type AttachTab = {
  t: 'attach_tab';
  tabId: number;
  url: string;
  title?: string;
};

export type DetachTab = {
  t: 'detach_tab';
  tabId: number;
};

export type TabEvent = {
  t: 'tab_event';
  tabId: number;
  kind: 'navigation' | 'click' | 'input' | 'scroll' | 'console';
  url?: string;
  title?: string;
  selector?: string;
  value?: string;
  x?: number;
  y?: number;
  meta?: Record<string, unknown>;
};

export type ActionRequest = {
  t: 'action_request';
  requestId: string;
  tabId: number;
  action: 'click' | 'type' | 'scroll' | 'navigate';
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
  url?: string;
};

export type ActionResult = {
  t: 'action_result';
  requestId: string;
  ok: boolean;
  error?: string;
};

export type OpenTabRequest = {
  t: 'open_tab_request';
  requestId: string;
  url: string;
  attach?: boolean;
};

export type OpenTabResult = {
  t: 'open_tab_result';
  requestId: string;
  ok: boolean;
  tabId?: number;
  error?: string;
};

export type ExtractRequest = {
  t: 'extract_request';
  requestId: string;
  tabId: number;

  /**
   * Keep this intentionally limited; add new kinds as needed.
   */
  kind: 'reddit_listing' | 'page_info';

  /** Max number of items to return when kind supports lists. */
  max?: number;
};

export type ExtractResult = {
  t: 'extract_result';
  requestId: string;
  ok: boolean;
  error?: string;

  tabId: number;
  url?: string;
  title?: string;

  items?: Array<{ title: string; url: string }>;
};

export type Ping = {
  t: 'ping';
  nonce: string;
};

export function makeId(prefix = 'm'): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}
