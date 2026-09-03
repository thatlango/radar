const STRUCTURED_METADATA_KEYS = /(?:budgetYearsColumns|budgetTopicActions|expectedGrants|minContribution|maxContribution|aggregationField|facet|metadata|rawPayload|searchMetadata)/i;

function normalizeDisplayText(value) {
  if (value == null) return '';
  if (typeof value === 'object') return '';

  let text = String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || text === '[object Object]' || text === '[object Array]') return '';

  const startsStructured = /^[\[{]/.test(text);
  if (startsStructured) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return '';
    } catch {
      if (STRUCTURED_METADATA_KEYS.test(text)) return '';
    }
  }

  const structuredTail = text.search(/\s+[\[{]\s*["'][A-Za-z0-9_-]+["']\s*:/);
  if (structuredTail > 40) text = text.slice(0, structuredTail).trim();

  if (STRUCTURED_METADATA_KEYS.test(text) && /[\[{].*[:]/.test(text)) return '';
  return text;
}

function normalizeScalarText(value) {
  const text = normalizeDisplayText(value);
  if (!text || text.length > 180) return '';
  if (/[\[{].*[:]/.test(text)) return '';
  return text;
}

function sanitizeOpportunity(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    title: normalizeDisplayText(row.title) || 'Opportunity',
    organization: normalizeDisplayText(row.organization) || 'Organisation not listed',
    country: normalizeScalarText(row.country) || row.country || '',
    region: normalizeScalarText(row.region),
    summary: normalizeDisplayText(row.summary),
    description: normalizeDisplayText(row.description),
    requirements: normalizeDisplayText(row.requirements),
    compensation: normalizeScalarText(row.compensation),
    salary: normalizeScalarText(row.salary),
    source: normalizeScalarText(row.source) || row.source || '',
  };
}

function sanitizeOpportunityPayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeOpportunityPayload);
  if (!value || typeof value !== 'object') return value;

  const next = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, sanitizeOpportunityPayload(child)]),
  );

  if (next.sourceUrl && next.title && next.type) return sanitizeOpportunity(next);
  return next;
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Request failed (${response.status})`);
    error.code = body?.error?.code;
    error.details = body?.error?.details;
    error.status = response.status;
    throw error;
  }
  return sanitizeOpportunityPayload(body?.data ?? body);
}

export const list = (value) => String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
export const fmtDate = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : 'Open deadline';
export const fmtDateTime = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '';
export const daysUntil = (value) => value ? Math.ceil((new Date(value).getTime() - Date.now()) / 86400000) : null;
export const deadlineLabel = (value) => {
  const days = daysUntil(value);
  if (days === null) return 'Open deadline';
  if (days < 0) return 'Closed';
  if (days === 0) return 'Closes today';
  if (days === 1) return '1 day left';
  return `${days} days left`;
};
export const money = (minor, currency = 'USD') => minor == null ? 'Custom' : new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(minor) / 100);
export const statusLabel = (value) => String(value || 'pending').replace(/_/g, ' ');
export const fileToBase64 = async (file) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  return btoa(binary);
};
