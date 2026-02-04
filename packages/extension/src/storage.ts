export type Settings = {
  httpBase?: string;
  token?: string;
  clientId: string;
  connected?: boolean;
  allowActions: boolean;
  // allowlist removed for v0.2.2 testing; may reintroduce later
  attachedTabIds: number[];
};

export type AuditEntry = {
  ts: number;
  kind: 'action' | 'open_tab' | 'security_block';
  tabId?: number;
  detail: Record<string, unknown>;
};

const DEFAULTS: Settings = {
  clientId: `ext_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`,
  allowActions: false,
  attachedTabIds: []
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
