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
  | ScreenshotRequest
  | ScreenshotResult
  | WaitForUser
  | Resume
  | ResumeAck
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

export type DocumentReadyStateLike = 'loading' | 'interactive' | 'complete';

export type ActionReceipt = {
  url?: string;
  title?: string;
  readyState?: DocumentReadyStateLike;
  /** Short (human readable) excerpt to confirm we are on the right screen. */
  excerpt?: string;
  /** Best-effort error banners / alerts. */
  errorBanners?: string[];
};

export type ActionResult = {
  t: 'action_result';
  requestId: string;
  ok: boolean;
  error?: string;
  receipt?: ActionReceipt;
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

export type PageInfo = {
  url: string;
  title: string;
  readyState: DocumentReadyStateLike;
};

export type ExtractKind = 'page_info' | 'readable_text' | 'links' | 'forms' | 'visible_clickables';

export type ExtractRequest = {
  t: 'extract_request';
  requestId: string;
  tabId: number;

  kind: ExtractKind;

  /** Max number of items to return when kind supports lists. */
  max?: number;
};

export type ExtractLink = {
  text: string;
  url: string;
};

export type ExtractFormField = {
  tag: 'input' | 'textarea' | 'select' | 'button';
  type?: string;
  name?: string;
  id?: string;
  label?: string;
  ariaLabel?: string;
  placeholder?: string;
  value?: string;
  selector: string;
};

export type ExtractClickable = {
  role: string;
  name: string;
  selector: string;
  url?: string;
};

export type ExtractResult = {
  t: 'extract_result';
  requestId: string;
  ok: boolean;
  error?: string;

  tabId: number;
  kind: ExtractKind;

  pageInfo?: PageInfo;

  readableText?: { text: string };
  links?: { links: ExtractLink[] };
  forms?: { fields: ExtractFormField[] };
  visibleClickables?: { clickables: ExtractClickable[] };
};

export type ScreenshotRequest = {
  t: 'screenshot_request';
  requestId: string;
  tabId: number;
  /** If true, attempt to capture the full page (best-effort; may fall back). */
  fullPage?: boolean;
  /** JPEG quality 0-100 (best-effort). */
  quality?: number;
};

export type ScreenshotResult = {
  t: 'screenshot_result';
  requestId: string;
  ok: boolean;
  tabId: number;
  error?: string;
  pageInfo?: PageInfo;

  /** data URL (e.g. data:image/jpeg;base64,...) */
  dataUrl?: string;
};

export type WaitForUser = {
  t: 'wait_for_user';
  requestId: string;
  tabId: number;
  message?: string;
};

export type Resume = {
  t: 'resume';
  requestId: string;
  tabId: number;
};

export type ResumeAck = {
  t: 'resume_ack';
  requestId: string;
  ok: boolean;
  tabId: number;
  error?: string;
  pageInfo?: PageInfo;
};

export type Ping = {
  t: 'ping';
  nonce: string;
};

export function makeId(prefix = 'm'): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}
