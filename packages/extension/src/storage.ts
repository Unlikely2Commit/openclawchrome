export type Settings = {
  httpBase?: string;
  token?: string;
  clientId: string;

  /**
   * If false, the extension will not auto-connect the WebSocket in the background.
   * Set to false when the user explicitly clicks Disconnect.
   */
  autoConnect: boolean;

  /**
   * If true, opening the popup will automatically add the active tab to the OpenClaw tab group
   * (Model 2) and enable the content script overlay/border.
   */
  autoControlOnPopupOpen: boolean;

  /**
   * If set, we will not auto-control this tab id on popup open (so Detach actually sticks).
   * Cleared automatically once the active tab changes.
   */
  skipAutoControlTabId?: number;

  allowActions: boolean;

  /**
   * Backwards compatibility (no longer used).
   */
  attachedTabIds?: number[];
};

export type AuditEntry = {
  ts: number;
  kind: 'action' | 'open_tab' | 'security_block' | 'tab_control';
  tabId?: number;
  detail: Record<string, unknown>;
};

const DEFAULTS: Settings = {
  clientId: `ext_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`,
  autoConnect: true,
  // v0.4.4: do not implicitly control the active tab just because the popup was opened.
  autoControlOnPopupOpen: false,
  allowActions: false
};

export async function getSettings(): Promise<Settings> {
  const out = await chrome.storage.local.get(['settings']);
  return { ...DEFAULTS, ...(out.settings ?? {}) } as Settings;
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  const next = { ...cur, ...patch } as Settings;
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function appendAudit(entry: AuditEntry, max = 200): Promise<void> {
  const out = await chrome.storage.local.get(['audit']);
  const arr: AuditEntry[] = Array.isArray(out.audit) ? out.audit : [];
  arr.push(entry);
  while (arr.length > max) arr.shift();
  await chrome.storage.local.set({ audit: arr });
}

export async function getAudit(): Promise<AuditEntry[]> {
  const out = await chrome.storage.local.get(['audit']);
  return Array.isArray(out.audit) ? (out.audit as AuditEntry[]) : [];
}
