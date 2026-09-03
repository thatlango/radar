import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import pdfParse from 'pdf-parse';
import nodemailer from 'nodemailer';
import {
  RADAR_PLANS,
  coreSubscriptionCatalog,
  resolvedPlan,
  usageSnapshot,
  recordUsage,
  enforceLimit,
  subscriptionEnforcementEnabled,
} from './subscriptions.mjs';

const prisma = new PrismaClient();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const CORE_INTERNAL_URL = (process.env.TUKU_CORE_INTERNAL_URL || process.env.TUKU_CORE_URL || 'https://core.tukutuku.org').replace(/\/$/, '');
const CORE_BROWSER_URL = (process.env.TUKU_CORE_BROWSER_URL || 'https://core.tukutuku.org').replace(/\/$/, '');
const AI_KEY = process.env.TUKU_AI_INTEGRATION_KEY || '';
const CLIENT_ID = 'radar-web';
const REDIRECT_URI = process.env.RADAR_REDIRECT_URI || 'https://radar.tukutuku.org/auth/tuku/callback';
const SESSION_TTL_HOURS = Math.max(1, Math.min(168, Number(process.env.SESSION_TTL_HOURS || 24)));
const COOKIE = 'radar_session';
const emailTransporter = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
}) : null;
const RADAR_FROM = process.env.RADAR_ALERT_FROM || 'Radar <radar@tukutuku.org>';

const SCAN_PRESETS = [
  { id: 'consulting-firm', name: 'Consulting & implementation opportunities', description: 'Firm, framework, roster and consortium opportunities across programme design, implementation, research, capacity building, private sector development, digital systems and MEL.' },
  { id: 'strong-fit-role', name: 'Strong-fit roles & individual consultancies', description: 'Paid roles and individual consultancies matched to your skills, experience, geography and hard eligibility requirements.' },
  { id: 'innovation-entrepreneurship', name: 'Innovation & entrepreneurship', description: 'Innovation ecosystems, incubators, accelerators, venture support, entrepreneurship programmes and MSME growth work.' },
];

const WORKSPACE_STATUSES = new Set(['drafting', 'review', 'ready', 'submitted', 'paused', 'closed']);
const DOCUMENT_STATUSES = new Set(['pending', 'drafting', 'review', 'approved', 'complete']);
const APPLICATION_STATUSES = new Set(['planning', 'applied', 'interview', 'offer', 'rejected', 'withdrawn']);
const MEMBER_ROLES = new Set(['owner', 'editor', 'reviewer', 'viewer']);
const DOCUMENT_CATEGORIES = new Set(['profile', 'cv', 'bio', 'capability', 'reference', 'certificate', 'financial', 'legal', 'portfolio', 'other']);
const WORKSPACE_TRANSITIONS = {
  drafting: new Set(['drafting','review','paused','closed']),
  review: new Set(['review','drafting','ready','paused','closed']),
  ready: new Set(['ready','review','submitted','paused','closed']),
  submitted: new Set(['submitted','closed']),
  paused: new Set(['paused','drafting','review','closed']),
  closed: new Set(['closed']),
};
const DOCUMENT_TRANSITIONS = {
  pending: new Set(['pending','drafting']),
  drafting: new Set(['drafting','review','pending']),
  review: new Set(['review','drafting','approved']),
  approved: new Set(['approved','review','complete']),
  complete: new Set(['complete','review']),
};
function validTransition(map, from, to) { return Boolean(map[String(from)]?.has(String(to))); }

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }));
const ALLOWED_ORIGINS = new Set((process.env.RADAR_ALLOWED_ORIGINS || 'https://radar.tukutuku.org').split(',').map((value) => value.trim()).filter(Boolean));
const rateBuckets = new Map();
function rateLimit(name, limit, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const now = Date.now();
    const current = rateBuckets.get(key);
    if (!current || current.resetAt <= now) { rateBuckets.set(key, { count: 1, resetAt: now + windowMs }); return next(); }
    if (current.count >= limit) return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' } });
    current.count += 1; next();
  };
}
setInterval(() => { const now = Date.now(); for (const [key, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(key); }, 10 * 60 * 1000).unref();
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
  if (req.path.startsWith('/api/') && !['GET','HEAD','OPTIONS'].includes(req.method)) {
    const origin = String(req.headers.origin || '');
    if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: { code: 'ORIGIN_DENIED', message: 'Request origin is not allowed.' } });
  }
  next();
});

function cookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
}
function setSessionCookie(res, id, expiresAt) {
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expiresAt.toUTCString()}`);
}
function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
async function sessionFor(req) {
  const id = cookie(req, COOKIE);
  if (!id) return null;
  const found = await prisma.radarSession.findUnique({ where: { id }, include: { user: true } });
  if (!found || found.expiresAt <= new Date()) {
    if (found) await prisma.radarSession.delete({ where: { id } }).catch(() => undefined);
    return null;
  }
  await prisma.radarSession.update({ where: { id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  return found;
}
async function requireSession(req, res, next) {
  try {
    const s = await sessionFor(req);
    if (!s) return res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in with Tuku to continue.' } });
    req.radarSession = s;
    next();
  } catch (error) { next(error); }
}
function cleanList(value, max = 30) {
  return Array.isArray(value) ? value.map((x) => String(x).trim()).filter(Boolean).slice(0, max) : [];
}
function safePrefs(user) {
  return user?.preferences && typeof user.preferences === 'object' ? user.preferences : {};
}
function safeJson(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function capabilityView(row) {
  if (!row) return null;
  return { id: row.id, profileType: row.profileType, legalName: row.legalName, registrationNumber: row.registrationNumber, registrationCountry: row.registrationCountry, yearsOperating: row.yearsOperating, turnoverBand: row.turnoverBand, sectors: row.sectors || [], countries: row.countries || [], donorExperience: row.donorExperience || [], licences: row.licences || [], referenceCount: row.referenceCount, canRecruitSpecialists: row.canRecruitSpecialists, metadata: row.metadata || {}, updatedAt: row.updatedAt };
}
async function capabilityContext(userId) {
  return capabilityView(await prisma.capabilityProfile.findUnique({ where: { userId } }));
}
function publicUser(user) {
  const preferences = safePrefs(user);
  return {
    id: user.id, name: user.name, email: user.email, phone: user.phone,
    skills: user.parsedSkills, industries: user.parsedIndustries,
    onboardingComplete: user.onboardingComplete, preferences, isPro: user.isPro,
    resume: { uploaded: Boolean(user.resumeText), fileName: user.resumeUrl || null },
  };
}

async function coreRequest(pathname, init = {}) {
  const response = await fetch(`${CORE_INTERNAL_URL}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = raw?.error ?? raw?.data?.error ?? raw;
    throw Object.assign(new Error(detail?.message || raw?.message || 'Tuku Auth could not complete this request.'), { status: response.status, code: detail?.code || 'TUKU_AUTH_FAILED' });
  }
  return raw?.data ?? raw;
}
async function persistRadarCoreSession(core, res) {
  if (!core?.authenticated || core?.authorization?.productCode !== 'radar' || !core?.identity?.coreUserId || !core?.identity?.email) {
    throw Object.assign(new Error('Tuku Core returned an invalid Radar identity.'), { status: 403, code: 'PRODUCT_ACCESS_DENIED' });
  }
  let user = await prisma.user.findUnique({ where: { coreUserId: core.identity.coreUserId } });
  if (!user) user = await prisma.user.findUnique({ where: { email: String(core.identity.email).toLowerCase() } });
  const data = {
    coreUserId: core.identity.coreUserId,
    email: String(core.identity.email).toLowerCase(),
    emailVerified: core.identity.emailVerified === true,
    phone: core.identity.phone || undefined,
    lastLoginAt: new Date(),
  };
  user = user
    ? await prisma.user.update({ where: { id: user.id }, data })
    : await prisma.user.create({ data: { ...data, name: String(core.identity.name || core.identity.email).split('@')[0], parsedSkills: [], parsedIndustries: [] } });
  await prisma.workspaceMember.updateMany({ where: { email: user.email.toLowerCase(), status: 'invited' }, data: { userId: user.id, status: 'accepted' } }).catch(() => undefined);
  const id = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600000);
  await prisma.radarSession.create({ data: { id, userId: user.id, coreOrganizationId: core.authorization.organizationId || null, coreBusinessId: core.authorization.businessId || null, coreAccess: core.authorization.access || undefined, corePermissionCodes: cleanList(core.authorization.permissionCodes, 120), expiresAt } });
  setSessionCookie(res, id, expiresAt);
  return { authenticated: true, user: publicUser(user), organizationId: core.authorization.organizationId, businessId: core.authorization.businessId || null };
}
async function exchangeRadarCode(code, codeVerifier) {
  return coreRequest('/api/v1/sso/exchange', {
    method: 'POST',
    body: JSON.stringify({ clientId: CLIENT_ID, code, redirectUri: REDIRECT_URI, codeVerifier }),
  });
}
async function embeddedRadarAuth({ mode, email, password, name }) {
  const auth = mode === 'signup'
    ? await coreRequest('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: String(email).trim().toLowerCase(), password, name: String(name || '').trim(), language: 'en', country: 'UG', consent: true, intent: 'exploring' }) })
    : await coreRequest('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: String(email).trim().toLowerCase(), password }) });
  if (!auth?.session?.accessToken) {
    if (mode === 'signup' && auth?.emailConfirmationRequired) return { verificationRequired: true, core: null };
    throw Object.assign(new Error('Tuku Auth did not establish an active account session.'), { status: 401, code: 'TUKU_SESSION_MISSING' });
  }
  const verifier = crypto.randomBytes(48).toString('base64url');
  const state = crypto.randomBytes(24).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorization = await coreRequest('/api/v1/sso/authorize', {
    method: 'POST', headers: { authorization: `Bearer ${auth.session.accessToken}` },
    body: JSON.stringify({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, state, codeChallenge, codeChallengeMethod: 'S256' }),
  });
  const returned = new URL(String(authorization?.redirectUrl || ''));
  const expected = new URL(REDIRECT_URI);
  if (returned.origin !== expected.origin || returned.pathname !== expected.pathname || returned.searchParams.get('state') !== state) {
    throw Object.assign(new Error('Tuku Auth returned an invalid Radar hand-off.'), { status: 401, code: 'TUKU_AUTHORIZE_FAILED' });
  }
  return { verificationRequired: false, core: await exchangeRadarCode(returned.searchParams.get('code') || '', verifier) };
}

function cleanOpportunityText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
function clipAtWord(value, max = 100) {
  const text = cleanOpportunityText(value);
  if (text.length <= max) return text;
  const slice = text.slice(0, max + 1);
  const cut = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('–'), slice.lastIndexOf('-'));
  return `${slice.slice(0, cut > max * .62 ? cut : max).replace(/[\s,;:–—-]+$/, '')}…`;
}
const RADAR_ACRONYMS = ['ICT','AI','AATL','PKI','MSME','SME','BDS','MEL','RFP','EOI','TOR','RFQ','UN','UNDP','UNICEF','UNIDO','UNOPS','IOM','ILO','IFAD','IFC','GIZ','NITA-U','UCC','PPDA','EAC','COMESA','IGAD','GSMA'];
const RADAR_PROPER_TERMS = ['Uganda','Kenya','Rwanda','Tanzania','Ghana','Nigeria','Africa','WebTrust'];
function sentenceCaseOpportunityTitle(value) {
  let text = cleanOpportunityText(value);
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length > 8 && (letters.match(/[A-Z]/g) || []).length / letters.length > .72) {
    text = text.toLowerCase();
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  for (const acronym of RADAR_ACRONYMS) {
    const escaped = acronym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\-/g, '-');
    text = text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), acronym);
  }
  for (const term of RADAR_PROPER_TERMS) text = text.replace(new RegExp(`\\b${term}\\b`, 'gi'), term);
  return text;
}
function compactOpportunityTitle(rawTitle) {
  let title = cleanOpportunityText(rawTitle);
  title = title
    .replace(/\(\s*\d+(?:\.\d+)?\s*(?:KB|MB)\s*\)/gi, ' ')
    .replace(/\b(?:Bid Expiry|Bid Closing|Closing Date|Submission Deadline|Deadline|Apply By)\s*[:\-–—]\s*.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const marker = title.search(/(?:[,;|–—-]\s*)?(?:TERMS? OF REFERENCE|TOR\b|TENDER DOCUMENT|BID DOCUMENT|DOWNLOAD\b|ATTACHMENT\b|REQUEST FOR QUOTATION\b)/i);
  if (marker > 32) title = title.slice(0, marker).trim();
  title = title
    .replace(/^[A-Z0-9][A-Z0-9._-]*(?:\/[A-Z0-9._-]+){2,}\s*[-:–—]?\s*/i, '')
    .replace(/^\(?\s*(?:EOI|RFP|RFQ|TOR)\s*\)?\s*[-:–—]?\s*/i, '')
    .replace(/^(?:expression of interest(?:\s*\([^)]*\))?\s*(?:for|to provide)?\s*)/i, '')
    .replace(/^(?:request for (?:proposals?|expressions? of interest|quotations?)\s*(?:for)?\s*)/i, '')
    .replace(/^(?:invitation (?:to tender|for bids?)\s*(?:for)?\s*)/i, '')
    .replace(/^(?:terms? of reference\s*(?:for)?\s*)/i, '')
    .replace(/^(?:consultancy services?\s*(?:for|to)?\s*)/i, '')
    .replace(/^(?:procurement of\s*)/i, '')
    .replace(/^for\s+/i, '')
    .replace(/[\s,;:–—-]+$/, '')
    .trim();
  const halves = title.split(/\s+(?:\||—|–|;|,)\s+/).filter(Boolean);
  if (halves.length > 1 && halves[0].length >= 24) {
    const first = halves[0].toLowerCase();
    const next = halves[1].toLowerCase();
    const firstWords = first.split(/\s+/).filter((x) => x.length > 4).slice(0, 5);
    if (firstWords.filter((word) => next.includes(word)).length >= 3) title = halves[0];
  }
  if (!title) title = cleanOpportunityText(rawTitle);
  title = sentenceCaseOpportunityTitle(title)
    .replace(/\bconsultancy services?\b/gi, 'consultancy')
    .replace(/\band\b/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length > 72) {
    const forIndex = title.toLowerCase().indexOf(' for ', 28);
    if (forIndex > 28 && forIndex < 78) {
      const lead = title.slice(0, forIndex).trim();
      const generic = /^(?:consultancy|consultancy services|services|procurement|supply|works|goods|assignment)$/i.test(lead);
      if (!generic && lead.split(/\s+/).length >= 4) title = lead;
    }
  }
  return clipAtWord(title, 82);
}
function conciseOpportunitySummary(row, displayTitle) {
  const candidates = [row.aiSummary, row.description, row.requirements].map(cleanOpportunityText).filter(Boolean);
  for (let text of candidates) {
    text = text
      .replace(/\(\s*\d+(?:\.\d+)?\s*(?:KB|MB)\s*\)/gi, ' ')
      .replace(/\b(?:TERMS? OF REFERENCE|TENDER DOCUMENT|BID DOCUMENT)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (displayTitle) {
      const normalizedTitle = displayTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`^${normalizedTitle}[\\s.:–—-]*`, 'i'), '').trim();
    }
    text = text.replace(/^[A-Z0-9][A-Z0-9._-]*(?:\/[A-Z0-9._-]+){2,}\s*[-:–—]?\s*/i, '').trim();
    const parts = text.split(/(?<=[.!?])\s+|\s+[•·]\s+/).map((x) => x.trim()).filter((x) => x.length >= 28);
    const useful = parts.find((part) => !/^(?:reference|deadline|closing date|source|download|terms? of reference|expression of interest|request for proposal)\b/i.test(part));
    if (useful) {
      const titleWords = new Set(displayTitle.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 4));
      const usefulWords = new Set(useful.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 4));
      const overlap = titleWords.size ? [...titleWords].filter((word) => usefulWords.has(word)).length / titleWords.size : 0;
      if (overlap < .7) return clipAtWord(sentenceCaseOpportunityTitle(useful), 210);
    }
  }
  const org = cleanOpportunityText(row.organization || 'The organisation');
  const type = String(row.type || '').toLowerCase();
  const country = cleanOpportunityText(row.country || '');
  if (type === 'consultancy') return `${org} is seeking consultants or firms for this assignment${country ? ` in ${country}` : ''}.`;
  if (type === 'tender') return `${org} is inviting qualified bidders for this procurement${country ? ` in ${country}` : ''}.`;
  if (type === 'grant') return `${org} is offering funding through this opportunity${country ? ` for ${country}` : ''}.`;
  if (type === 'job') return `${org} is recruiting for this role${country ? ` in ${country}` : ''}.`;
  if (type === 'fellowship') return `${org} is accepting applications for this programme${country ? ` in ${country}` : ''}.`;
  return `${org} is accepting applications for this opportunity${country ? ` in ${country}` : ''}.`;
}
function opportunityPresentation(row) {
  const title = compactOpportunityTitle(row.title);
  return { title, officialTitle: cleanOpportunityText(row.title), summary: conciseOpportunitySummary(row, title) };
}

function opportunityFreshness(row) {
  const now = Date.now();
  const discovered = new Date(row?.discoveredAt || row?.createdAt || 0).getTime();
  const verified = new Date(row?.lastVerifiedAt || 0).getTime();
  const ageHours = Number.isFinite(discovered) && discovered > 0 ? Math.max(0, (now - discovered) / 3600000) : null;
  const verifiedHours = Number.isFinite(verified) && verified > 0 ? Math.max(0, (now - verified) / 3600000) : null;
  const deadlineDays = row?.deadline ? Math.ceil((new Date(row.deadline).getTime() - now) / 86400000) : null;
  if (row?.sourceStatus === 'stale' || row?.verificationStatus === 'needs_review') return { label: 'Needs re-check', tone: 'warn', ageHours };
  if (deadlineDays !== null && deadlineDays >= 0 && deadlineDays <= 5) return { label: 'Closing soon', tone: 'urgent', ageHours };
  if (ageHours !== null && ageHours <= 6) return { label: 'Just found', tone: 'new', ageHours };
  if (ageHours !== null && ageHours <= 24) return { label: 'New today', tone: 'new', ageHours };
  if (verifiedHours !== null && verifiedHours <= 24) return { label: 'Recently verified', tone: 'verified', ageHours };
  return { label: 'In Radar', tone: 'neutral', ageHours };
}
function feedPriorityScore(row, fitScore) {
  const fit = Math.max(0, Math.min(100, Number(fitScore || 0)));
  const quality = Math.max(0, Math.min(100, Number(row?.qualityScore || 0)));
  const ageHours = Math.max(0, (Date.now() - new Date(row?.discoveredAt || row?.createdAt || 0).getTime()) / 3600000);
  const freshness = ageHours <= 6 ? 100 : ageHours <= 24 ? 86 : ageHours <= 72 ? 66 : ageHours <= 168 ? 46 : 25;
  const days = row?.deadline ? Math.ceil((new Date(row.deadline).getTime() - Date.now()) / 86400000) : null;
  const urgency = days === null ? 48 : days < 0 ? 0 : days <= 2 ? 68 : days <= 7 ? 96 : days <= 14 ? 86 : days <= 30 ? 70 : 50;
  return Math.round(fit * .55 + quality * .15 + freshness * .15 + urgency * .15);
}
function feedSince(user) {
  const raw = safePrefs(user).lastFeedSeenAt;
  const parsed = raw ? new Date(raw) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(Date.now() - 24 * 3600000);
}

function opportunityView(row, extra = {}) {
  const presentation = opportunityPresentation(row);
  return {
    id: row.id, title: presentation.title, officialTitle: presentation.officialTitle, organization: row.organization, country: row.country, region: row.region,
    type: row.type, remote: row.remote, description: row.description, requirements: row.requirements,
    compensation: row.salary, deadline: row.deadline, source: row.source, sourceUrl: row.sourceUrl,
    applicationUrl: row.applicationUrl, applicationEmail: row.applicationEmail, applicationInstructions: row.applicationInstructions, applicationVerifiedAt: row.applicationVerifiedAt,
    referenceNumber: row.referenceNumber, sector: row.sector, currency: row.currency, valueMin: row.valueMin, valueMax: row.valueMax,
    contractDuration: row.contractDuration, submissionMethod: row.submissionMethod, languages: row.languages || [], eligibilityCountries: row.eligibilityCountries || [],
    publishedAt: row.publishedAt, discoveredAt: row.discoveredAt, lastVerifiedAt: row.lastVerifiedAt, sourceStatus: row.sourceStatus,
    verificationStatus: row.verificationStatus, sourceCount: row._count?.sources ?? (Array.isArray(row.sources) ? row.sources.length : 1),
    sources: Array.isArray(row.sources) ? row.sources.map((source) => ({ name: source.sourceName, url: source.sourceUrl, status: source.status, lastVerifiedAt: source.lastVerifiedAt })) : undefined,
    summary: presentation.summary, aiSummary: row.aiSummary, keywords: row.aiKeywords, qualityScore: row.qualityScore, freshness: opportunityFreshness(row), createdAt: row.createdAt,
    ...extra,
  };
}
function compactAiOpportunity(row, textLimit = 1000) {
  const view = opportunityView(row);
  return {
    id: view.id, title: view.title, organization: view.organization, country: view.country, region: view.region, type: view.type, remote: view.remote,
    deadline: view.deadline, referenceNumber: view.referenceNumber, sector: view.sector, contractDuration: view.contractDuration, submissionMethod: view.submissionMethod,
    summary: cleanOpportunityText(view.summary).slice(0, textLimit),
    description: cleanOpportunityText(view.description).slice(0, textLimit),
    requirements: cleanOpportunityText(view.requirements).slice(0, textLimit),
  };
}

function compactLibrary(docs, contentLimit = 900) {
  return docs.map((d) => ({
    title: d.title,
    category: d.category,
    verificationStatus: d.verificationStatus || 'unverified',
    claims: Array.isArray(d.extractedClaims?.claims) ? d.extractedClaims.claims.slice(0, 8).map((item) => ({ claim: String(item?.claim || '').slice(0, 240), evidence: String(item?.evidence || '').slice(0, 320), confidence: item?.confidence })) : [],
    content: String(d.content || '').slice(0, contentLimit),
  }));
}

function documentView(row) {
  return {
    id: row.id, title: row.title, kind: row.kind, status: row.status, content: row.content,
    generatedByAi: row.generatedByAi, version: row.version, checksum: row.checksum, evidenceRefs: row.evidenceRefs, lastSavedByUserId: row.lastSavedByUserId, metadata: row.metadata,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}
function workspaceView(row) {
  return {
    id: row.id, name: row.name, status: row.status, progress: row.progress,
    submissionDeadline: row.submissionDeadline, aiPlan: row.aiPlan, aiPlanStructured: row.aiPlanStructured,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    opportunity: row.opportunity ? opportunityView(row.opportunity) : undefined,
    documents: Array.isArray(row.documents) ? row.documents.map(documentView) : undefined,
    members: Array.isArray(row.members) ? row.members.map((m) => ({ id: m.id, userId: m.userId, name: m.name, email: m.email, role: m.role, status: m.status, createdAt: m.createdAt })) : undefined,
    comments: Array.isArray(row.comments) ? row.comments.map((c) => ({ id: c.id, documentId: c.documentId, authorUserId: c.authorUserId, authorName: c.authorName, body: c.body, status: c.status, createdAt: c.createdAt, resolvedAt: c.resolvedAt })) : undefined,
  };
}
function userDocumentView(row, includeContent = false) {
  return {
    id: row.id, title: row.title, category: row.category, fileName: row.fileName, mimeType: row.mimeType,
    sourceType: row.sourceType, checksum: row.checksum, verificationStatus: row.verificationStatus, extractedClaims: row.extractedClaims,
    version: row.version, metadata: row.metadata, expiresAt: row.expiresAt, lastReviewedAt: row.lastReviewedAt,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...(includeContent ? { content: row.content } : { hasContent: Boolean(row.content) }),
  };
}
function daysUntil(date) {
  if (!date) return null;
  return Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
}
function textTokens(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9+#.-]+/).map((x) => x.trim()).filter((x) => x.length > 2);
}
function deterministicFit(user, opportunity) {
  const prefs = safePrefs(user);
  const haystack = `${opportunity.title} ${opportunity.organization} ${opportunity.description} ${opportunity.requirements || ''} ${(opportunity.aiKeywords || []).join(' ')}`.toLowerCase();
  const skills = [...(user.parsedSkills || []), ...(user.parsedIndustries || [])];
  const intentTokens = textTokens(prefs.whatLookingFor || '').slice(0, 30);
  const skillHits = skills.filter((s) => haystack.includes(String(s).toLowerCase())).length;
  const intentHits = intentTokens.filter((token) => haystack.includes(token)).length;
  let score = 38;
  if (skills.length) score += Math.min(28, Math.round((skillHits / Math.max(1, Math.min(skills.length, 18))) * 45));
  if (intentTokens.length) score += Math.min(22, Math.round((intentHits / Math.max(1, Math.min(intentTokens.length, 18))) * 38));
  const wantedTypes = Array.isArray(prefs.types) ? prefs.types.map(String) : [];
  if (wantedTypes.includes(opportunity.type)) score += 8;
  if (prefs.remote === true && opportunity.remote) score += 7;
  const countries = Array.isArray(prefs.countries) ? prefs.countries.map((x) => String(x).toLowerCase()) : [];
  const regions = Array.isArray(prefs.regions) ? prefs.regions.map((x) => String(x).toLowerCase()) : [];
  const country = String(opportunity.country || '').toLowerCase();
  if (country && countries.some((x) => country.includes(x) || x.includes(country))) score += 8;
  else if (country && regions.some((x) => country.includes(x))) score += 5;
  const d = daysUntil(opportunity.deadline);
  const minDays = Math.max(0, Math.min(60, Number(prefs.minDaysToDeadline ?? 7)));
  if (d !== null && d < 0) return 0;
  if (d !== null && d < minDays) score -= 12;
  if (d !== null && d >= minDays && d <= 30) score += 4;
  if ((prefs.profileType === 'firm' || prefs.profileType === 'both') && prefs.canRecruitSpecialists === true && ['consultancy', 'tender', 'grant'].includes(opportunity.type)) score += 4;
  return Math.max(0, Math.min(100, score));
}
async function aiAssist(instruction, context, subjectRef, capability = 'analyze', maxOutputTokens = 320, mode = 'interactive') {
  if (!AI_KEY) throw Object.assign(new Error('Radar AI integration is not configured.'), { status: 503 });
  const response = await fetch(`${CORE_INTERNAL_URL}/api/v1/integrations/ai/assist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tuku-product-code': 'radar', 'x-tuku-integration-key': AI_KEY },
    body: JSON.stringify({ capability, instruction, context, subjectRef, maxOutputTokens, mode }),
    signal: AbortSignal.timeout(Math.max(30000, Math.min(120000, Number(process.env.TUKU_AI_TIMEOUT_MS || 120000)))),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || `Tuku AI returned ${response.status}`), { status: 503 });
  return payload?.data ?? payload;
}
function parsePossibleJson(value) {
  try {
    const cleaned = String(value || '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch { return null; }
}
async function upsertDailyAlert(userId, preferences) {
  const existing = await prisma.alert.findFirst({ where: { userId, frequency: 'daily' }, orderBy: { createdAt: 'asc' } });
  const keywords = String(preferences.whatLookingFor || '').slice(0, 1000);
  const locationPreference = cleanList(preferences.countries, 10).join(', ') || null;
  const data = { keywords, locationPreference, typePreference: null, frequency: 'daily', active: preferences.dailyBriefEnabled === true };
  if (existing) return prisma.alert.update({ where: { id: existing.id }, data });
  return prisma.alert.create({ data: { userId, ...data } });
}
async function briefingPreview(user, overrides = {}) {
  const prefs = { ...safePrefs(user), ...safeJson(overrides) };
  const minDays = Math.max(0, Math.min(60, Number(prefs.minDaysToDeadline ?? 7)));
  const minFit = Math.max(0, Math.min(100, Number(prefs.minFitScore ?? 60)));
  const now = new Date();
  const rows = await prisma.opportunity.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 7 * 86400000) }, OR: [{ deadline: null }, { deadline: { gte: new Date(Date.now() + minDays * 86400000) } }] },
    orderBy: [{ createdAt: 'desc' }, { qualityScore: 'desc' }], take: 100,
  });
  return rows.map((row) => ({ row, score: deterministicFit(user, row) }))
    .filter((item) => item.score >= minFit && (!item.row.deadline || new Date(item.row.deadline) >= now))
    .sort((a, b) => b.score - a.score).slice(0, 10)
    .map((item) => opportunityView(item.row, { fitScore: item.score }));
}
function seededDocumentSpecs(type) {
  if (['tender', 'consultancy', 'grant'].includes(type)) {
    return [
      ['Technical Proposal', 'technical_proposal'], ['Compliance Matrix', 'compliance_matrix'],
      ['Detailed Budget', 'budget'], ['Team & References', 'team_references'], ['Submission Checklist', 'submission_checklist'],
    ];
  }
  if (['job', 'internship', 'fellowship'].includes(type)) {
    return [['Tailored CV', 'cv'], ['Cover Letter', 'cover_letter'], ['Application Questions', 'application_questions'], ['Submission Checklist', 'submission_checklist']];
  }
  return [['Application Narrative', 'application_narrative'], ['Supporting Documents', 'supporting_documents'], ['Submission Checklist', 'submission_checklist']];
}
function workspaceProgress(documents) {
  if (!documents?.length) return 0;
  const weights = { pending: 0, drafting: 25, review: 60, approved: 90, complete: 100 };
  return Math.round(documents.reduce((sum, d) => sum + (weights[d.status] ?? 0), 0) / documents.length);
}
function workspaceReadinessAssessment(workspace, match = null) {
  const documents = workspace?.documents || [];
  const comments = workspace?.comments || [];
  const opportunity = workspace?.opportunity || {};
  const blockers = [];
  const warnings = [];
  const checks = [];
  const nonReady = documents.filter((d) => !['approved','complete'].includes(d.status));
  const empty = documents.filter((d) => !String(d.content || '').trim());
  const placeholders = documents.filter((d) => /\[NEEDS INPUT[^\]]*\]/i.test(String(d.content || '')));
  const unresolvedComments = comments.filter((c) => c.status !== 'resolved');
  const hardConstraints = Array.isArray(match?.hardConstraints) ? match.hardConstraints : [];
  const missingRequirements = Array.isArray(match?.missingRequirements) ? match.missingRequirements : [];
  const days = daysUntil(workspace?.submissionDeadline || opportunity?.deadline);
  if (!documents.length) blockers.push({ code: 'NO_DOCUMENTS', message: 'No required application documents are in this workspace yet.' });
  if (nonReady.length) blockers.push({ code: 'DOCUMENTS_NOT_APPROVED', message: `${nonReady.length} required document${nonReady.length === 1 ? '' : 's'} still need approval or completion.`, items: nonReady.map((d) => d.title) });
  if (empty.length) blockers.push({ code: 'EMPTY_DOCUMENTS', message: `${empty.length} required document${empty.length === 1 ? '' : 's'} are still empty.`, items: empty.map((d) => d.title) });
  if (placeholders.length) blockers.push({ code: 'NEEDS_INPUT', message: `${placeholders.length} document${placeholders.length === 1 ? '' : 's'} still contain [NEEDS INPUT] placeholders.`, items: placeholders.map((d) => d.title) });
  if (unresolvedComments.length) blockers.push({ code: 'OPEN_REVIEW_COMMENTS', message: `${unresolvedComments.length} review comment${unresolvedComments.length === 1 ? '' : 's'} remain unresolved.` });
  if (hardConstraints.length) blockers.push({ code: 'ELIGIBILITY_BLOCKER', message: `${hardConstraints.length} eligibility blocker${hardConstraints.length === 1 ? '' : 's'} remain unresolved.`, items: hardConstraints.slice(0, 6) });
  if (days !== null && days < 0) blockers.push({ code: 'DEADLINE_PASSED', message: 'The listed submission deadline has passed.' });
  else if (days !== null && days <= 2) warnings.push({ code: 'DEADLINE_CRITICAL', message: `Only ${Math.max(0, days)} day${days === 1 ? '' : 's'} remain before the deadline.` });
  else if (days !== null && days <= 5) warnings.push({ code: 'DEADLINE_CLOSE', message: `${days} days remain before the deadline.` });
  if (missingRequirements.length) warnings.push({ code: 'EVIDENCE_GAPS', message: `${missingRequirements.length} evidence gap${missingRequirements.length === 1 ? '' : 's'} are still recorded against this opportunity.`, items: missingRequirements.slice(0, 6) });
  if (opportunity?.sourceStatus === 'stale' || opportunity?.verificationStatus === 'needs_review') warnings.push({ code: 'SOURCE_RECHECK', message: 'The source listing should be re-checked before submission.' });
  checks.push({ label: 'Required documents approved', passed: nonReady.length === 0 && documents.length > 0, count: documents.length - nonReady.length, total: documents.length });
  checks.push({ label: 'No unresolved placeholders', passed: placeholders.length === 0, count: placeholders.length });
  checks.push({ label: 'Review comments resolved', passed: unresolvedComments.length === 0, count: unresolvedComments.length });
  checks.push({ label: 'No hard eligibility blockers', passed: hardConstraints.length === 0, count: hardConstraints.length });
  checks.push({ label: 'Deadline still viable', passed: days === null || days >= 0, daysRemaining: days });
  let score = 100;
  score -= Math.min(40, nonReady.length * 8);
  score -= Math.min(30, empty.length * 10);
  score -= Math.min(36, placeholders.length * 12);
  score -= Math.min(20, unresolvedComments.length * 5);
  score -= Math.min(40, hardConstraints.length * 20);
  score -= Math.min(16, missingRequirements.length * 4);
  if (days !== null && days < 0) score -= 50;
  else if (days !== null && days <= 2) score -= 15;
  else if (days !== null && days <= 5) score -= 8;
  if (opportunity?.sourceStatus === 'stale' || opportunity?.verificationStatus === 'needs_review') score -= 8;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const canFinalize = blockers.length === 0;
  const status = canFinalize ? (warnings.length ? 'ready_with_warnings' : 'ready') : score >= 60 ? 'needs_attention' : 'blocked';
  return { score, status, canFinalize, blockers, warnings, checks, daysRemaining: days, generatedAt: new Date() };
}
async function ownedWorkspace(userId, id, include = {}) {
  return prisma.opportunityWorkspace.findFirst({ where: { id, userId }, include });
}
async function accessibleWorkspace(userId, id, include = {}) {
  return prisma.opportunityWorkspace.findFirst({
    where: { id, OR: [{ userId }, { members: { some: { userId, status: 'accepted' } } }] },
    include: { ...include, members: include.members || true },
  });
}
function workspaceRole(workspace, userId) {
  if (!workspace) return null;
  if (workspace.userId === userId) return 'owner';
  return workspace.members?.find((member) => member.userId === userId && member.status === 'accepted')?.role || null;
}
function requireWorkspaceRole(workspace, userId, allowed) {
  const role = workspaceRole(workspace, userId);
  if (!role || !allowed.includes(role)) throw Object.assign(new Error('You do not have permission for this workspace action.'), { status: 403, code: 'WORKSPACE_PERMISSION_DENIED', details: { role, allowed } });
  return role;
}
async function enqueueUserRematch(userId) {
  return prisma.radarJob.upsert({
    where: { dedupeKey: `match-user:${userId}` },
    create: { type: 'match_user', payload: { userId }, dedupeKey: `match-user:${userId}`, status: 'queued' },
    update: { status: 'queued', runAt: new Date(), completedAt: null, lastError: null },
  }).catch(() => null);
}
async function createNotification(userId, type, title, body, metadata = {}) {
  return prisma.notification.create({ data: { userId, type, title: String(title).slice(0, 180), body: String(body).slice(0, 4000), metadata } }).catch(() => null);
}
function htmlEscape(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
async function sendWorkspaceInviteEmail({ email, inviter, workspace, role }) {
  if (!emailTransporter || !email) return { delivered: false, reason: 'smtp_unavailable' };
  const title = compactOpportunityTitle(workspace?.opportunity?.title || workspace?.name || 'Radar application workspace');
  const organisation = cleanOpportunityText(workspace?.opportunity?.organization || '');
  const url = `https://radar.tukutuku.org/app?workspace=${encodeURIComponent(workspace.id)}`;
  await emailTransporter.sendMail({
    from: RADAR_FROM,
    to: email,
    subject: `${inviter || 'A teammate'} invited you to a Radar workspace`,
    text: `${inviter || 'A teammate'} invited you as ${role} to work on ${title}${organisation ? ` for ${organisation}` : ''}. Open Radar: ${url}. Sign in with this email address to access the workspace.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#173247"><p style="font-size:12px;font-weight:700;letter-spacing:.08em;color:#087263">RADAR · TEAM REVIEW</p><h2 style="font-size:24px;margin:8px 0">You have been invited to an application workspace</h2><p><strong>${htmlEscape(inviter || 'A teammate')}</strong> invited you as <strong>${htmlEscape(role)}</strong> to help prepare:</p><div style="padding:16px;border-radius:14px;background:#f2f7f6"><strong>${htmlEscape(title)}</strong>${organisation ? `<div style="margin-top:4px;color:#647485">${htmlEscape(organisation)}</div>` : ''}</div><p style="margin:18px 0">Sign in to Radar with <strong>${htmlEscape(email)}</strong>. Access is tied to the invited email address.</p><a href="${htmlEscape(url)}" style="display:inline-block;background:#087263;color:#fff;text-decoration:none;padding:11px 16px;border-radius:10px;font-weight:700">Open workspace</a><p style="margin-top:22px;color:#7a8795;font-size:12px">Radar keeps drafting, evidence and review activity inside the workspace. External submission remains user-controlled.</p></div>`,
  });
  return { delivered: true };
}
async function libraryContext(userId, limit = 10) {
  const docs = await prisma.userDocument.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' }, take: limit });
  return docs.map((d) => ({ title: d.title, category: d.category, content: String(d.content || '').slice(0, 5000), extractedClaims: d.extractedClaims, verificationStatus: d.verificationStatus, expiresAt: d.expiresAt, lastReviewedAt: d.lastReviewedAt }));
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'radar', runtime: 'vps', milestone: 'opportunity-os' }));
app.get('/ready', async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true, service: 'radar', database: 'ok', aiConfigured: Boolean(AI_KEY), milestone: 'opportunity-os' }); }
  catch { res.status(503).json({ ok: false, service: 'radar', database: 'unavailable' }); }
});
app.get('/api/config', (_req, res) => res.json({ coreUrl: CORE_BROWSER_URL, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, milestone: 'opportunity-os', aiConfigured: Boolean(AI_KEY) }));
app.get('/api/scan-profiles', (_req, res) => res.json({ items: SCAN_PRESETS }));

app.get('/api/subscriptions/plans', async (_req, res) => {
  const core = await coreSubscriptionCatalog(CORE_INTERNAL_URL);
  res.json({
    providerConfigured: core.providerConfigured,
    checkoutAvailable: core.checkoutAvailable,
    enforcementEnabled: subscriptionEnforcementEnabled(),
    authority: 'tuku-core',
    plans: RADAR_PLANS,
    corePlans: core.corePlans,
  });
});
app.post('/api/subscriptions/checkout', requireSession, async (req, res, next) => {
  try {
    const planCode = String(req.body?.planCode || '');
    const plan = RADAR_PLANS.find((item) => item.code === planCode);
    if (!plan || !plan.checkout) return res.status(400).json({ error: { code: 'PLAN_NOT_CHECKOUTABLE', message: 'Choose a checkout-enabled Radar plan.' } });
    const core = await coreSubscriptionCatalog(CORE_INTERNAL_URL);
    if (!core.checkoutAvailable) {
      return res.status(503).json({ error: { code: 'CHECKOUT_NOT_CONFIGURED', message: 'Radar subscription checkout is scaffolded but the Tuku billing provider is not configured yet.', details: { planCode } } });
    }
    return res.status(501).json({ error: { code: 'CHECKOUT_PROVIDER_PENDING', message: 'Tuku billing reports checkout availability, but the Radar checkout adapter has not been enabled in this deployment.' } });
  } catch (error) { next(error); }
});

app.post('/api/auth/credentials', rateLimit('auth-credentials', 12, 15 * 60 * 1000), async (req, res, next) => {
  try {
    const mode = req.body?.mode === 'signup' ? 'signup' : 'signin';
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim();
    if (!email.includes('@')) return res.status(400).json({ error: { code: 'INVALID_EMAIL', message: 'Enter a valid email address.' } });
    if (password.length < 8) return res.status(400).json({ error: { code: 'WEAK_PASSWORD', message: 'Use at least 8 characters for your password.' } });
    if (mode === 'signup' && name.length < 2) return res.status(400).json({ error: { code: 'NAME_REQUIRED', message: 'Enter your name.' } });
    const result = await embeddedRadarAuth({ mode, email, password, name });
    if (result.verificationRequired || !result.core) return res.status(202).json({ authenticated: false, verificationRequired: true });
    res.json({ ...(await persistRadarCoreSession(result.core, res)), verificationRequired: false });
  } catch (error) { next(error); }
});
app.post('/api/auth/forgot-password', rateLimit('auth-forgot', 6, 30 * 60 * 1000), async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email.includes('@')) return res.status(400).json({ error: { code: 'INVALID_EMAIL', message: 'Enter a valid email address.' } });
    await coreRequest('/api/v1/auth/forgot-password', { method: 'POST', body: JSON.stringify({ channel: 'email', identifier: email, redirectTo: 'https://radar.tukutuku.org/app?reset_password=1' }) });
    res.status(202).json({ accepted: true });
  } catch (error) { next(error); }
});
app.post('/api/auth/reset-password', rateLimit('auth-reset', 8, 30 * 60 * 1000), async (req, res, next) => {
  try {
    const recoveryToken = String(req.body?.recoveryToken || '').trim();
    const password = String(req.body?.password || '');
    if (!recoveryToken || password.length < 8) return res.status(400).json({ error: { code: 'INVALID_RESET', message: 'This reset link is invalid or the new password is too short.' } });
    await coreRequest('/api/v1/auth/reset-password', { method: 'POST', body: JSON.stringify({ recoveryToken, password }) });
    res.json({ completed: true });
  } catch (error) { next(error); }
});

app.post('/api/auth/tuku/exchange', async (req, res, next) => {
  try {
    const { code, codeVerifier } = req.body || {};
    if (!code || !codeVerifier) return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Authorization code and verifier are required.' } });
    const response = await fetch(`${CORE_INTERNAL_URL}/api/v1/sso/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, code, redirectUri: REDIRECT_URI, codeVerifier }), signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({}));
    const core = payload?.data ?? payload;
    if (!response.ok) return res.status(response.status).json(payload);
    if (!core?.authenticated || core?.authorization?.productCode !== 'radar' || !core?.identity?.coreUserId || !core?.identity?.email) {
      return res.status(403).json({ error: { code: 'PRODUCT_ACCESS_DENIED', message: 'Tuku Core returned an invalid Radar identity.' } });
    }
    let user = await prisma.user.findUnique({ where: { coreUserId: core.identity.coreUserId } });
    if (!user) user = await prisma.user.findUnique({ where: { email: String(core.identity.email).toLowerCase() } });
    const data = { coreUserId: core.identity.coreUserId, email: String(core.identity.email).toLowerCase(), emailVerified: core.identity.emailVerified === true, phone: core.identity.phone || undefined, lastLoginAt: new Date() };
    user = user ? await prisma.user.update({ where: { id: user.id }, data }) : await prisma.user.create({ data: { ...data, name: String(core.identity.email).split('@')[0], parsedSkills: [], parsedIndustries: [] } });
    await prisma.workspaceMember.updateMany({ where: { email: user.email.toLowerCase(), status: 'invited' }, data: { userId: user.id, status: 'accepted' } }).catch(() => undefined);
    const id = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600000);
    await prisma.radarSession.create({ data: { id, userId: user.id, coreOrganizationId: core.authorization.organizationId || null, coreBusinessId: core.authorization.businessId || null, coreAccess: core.authorization.access || undefined, corePermissionCodes: cleanList(core.authorization.permissionCodes, 120), expiresAt } });
    setSessionCookie(res, id, expiresAt);
    res.json({ authenticated: true, user: publicUser(user), organizationId: core.authorization.organizationId, businessId: core.authorization.businessId || null });
  } catch (error) { next(error); }
});
app.post('/api/auth/logout', async (req, res) => {
  const id = cookie(req, COOKIE);
  if (id) await prisma.radarSession.delete({ where: { id } }).catch(() => undefined);
  clearSessionCookie(res); res.status(204).end();
});
app.get('/api/session', async (req, res) => {
  const s = await sessionFor(req);
  if (!s) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: publicUser(s.user), organizationId: s.coreOrganizationId, businessId: s.coreBusinessId, access: s.coreAccess || null, permissionCodes: s.corePermissionCodes || [] });
});

app.get('/api/opportunities', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || '').trim();
    const country = String(req.query.country || '').trim();
    const remote = String(req.query.remote || '').trim();
    const verifiedOnly = String(req.query.verified || '').trim() === 'true';
    const deadlineDays = Math.max(0, Math.min(365, Number(req.query.deadlineDays || 0)));
    const sector = String(req.query.sector || '').trim();
    const source = String(req.query.source || '').trim();
    const minValue = Number(req.query.minValue || 0);
    const take = Math.max(1, Math.min(100, Number(req.query.limit || 40)));
    const cursor = String(req.query.cursor || '').trim();
    const now = new Date();
    const where = { AND: [
      { OR: [{ deadline: null }, { deadline: { gte: now } }] },
      ...(q ? [{ OR: [{ title: { contains: q, mode: 'insensitive' } }, { organization: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] }] : []),
      ...(type ? [{ type }] : []), ...(country ? [{ country: { contains: country, mode: 'insensitive' } }] : []),
      ...(remote === 'true' ? [{ remote: true }] : []),
      ...(verifiedOnly ? [{ sourceStatus: 'live', verificationStatus: 'verified' }] : []),
      ...(deadlineDays > 0 ? [{ deadline: { gte: now, lte: new Date(Date.now() + deadlineDays * 86400000) } }] : []),
      ...(sector ? [{ sector: { contains: sector, mode: 'insensitive' } }] : []),
      ...(source ? [{ source: { contains: source, mode: 'insensitive' } }] : []),
    ] };
    const session = await sessionFor(req);
    if (session) {
      const usage = await usageSnapshot(prisma, session.userId);
      await enforceLimit({ prisma, session, metric: 'searches', currentCount: usage.searches });
      await recordUsage(prisma, session.userId, 'searches');
    }
    const rows = await prisma.opportunity.findMany({
      where,
      orderBy: [{ qualityScore: 'desc' }, { deadline: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(101, take * 2 + 1),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { _count: { select: { sources: true } } },
    });
    const filtered = minValue > 0 ? rows.filter((r) => Number(String(r.salary || '').replace(/[^0-9.]/g, '')) >= minValue) : rows;
    const saved = session ? new Set((await prisma.savedOpportunity.findMany({ where: { userId: session.userId }, select: { opportunityId: true } })).map((x) => x.opportunityId)) : new Set();
    const workspaceMap = session ? new Map((await prisma.opportunityWorkspace.findMany({ where: { userId: session.userId, opportunityId: { in: filtered.map((x) => x.id) } }, select: { id: true, opportunityId: true, status: true } })).map((x) => [x.opportunityId, x])) : new Map();
    const matches = session ? new Map((await prisma.match.findMany({ where: { userId: session.userId, opportunityId: { in: filtered.map((x) => x.id) } } })).map((x) => [x.opportunityId, x])) : new Map();
    const lastFeedSeenAt = session ? feedSince(session.user) : null;
    const mapped = filtered.map((row) => {
      const match = matches.get(row.id);
      const fitScore = match?.finalRank ?? (session ? deterministicFit(session.user, row) : null);
      return opportunityView(row, {
        saved: saved.has(row.id), workspace: workspaceMap.get(row.id) || null,
        fitScore,
        feedScore: session ? feedPriorityScore(row, fitScore) : null,
        newToUser: Boolean(session && lastFeedSeenAt && new Date(row.discoveredAt || row.createdAt) > lastFeedSeenAt),
        fitEvidence: match ? { explanation: match.explanation, keySkillMatches: match.keySkillMatches || [], missingRequirements: match.missingRequirements || [], hardConstraints: match.hardConstraints || [], specialistNeeds: match.specialistNeeds || [], confidence: match.confidence } : null,
      });
    });
    if (session) mapped.sort((a, b) => Number(b.feedScore || 0) - Number(a.feedScore || 0) || Number(b.fitScore || 0) - Number(a.fitScore || 0) || Number(b.qualityScore || 0) - Number(a.qualityScore || 0));
    const seenPresentation = new Set();
    const uniqueMapped = mapped.filter((item) => {
      const key = [item.title, item.organization, item.country, item.source].map((value) => cleanOpportunityText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).join('|');
      if (!key || seenPresentation.has(key)) return false;
      seenPresentation.add(key);
      return true;
    });
    const items = uniqueMapped.slice(0, take);
    res.json({ items, pageInfo: { nextCursor: uniqueMapped.length > take ? items.at(-1)?.id || null : null, hasMore: uniqueMapped.length > take } });
  } catch (error) { next(error); }
});
app.get('/api/opportunities/:id', async (req, res) => {
  const row = await prisma.opportunity.findUnique({ where: { id: req.params.id }, include: { sources: { orderBy: { lastVerifiedAt: 'desc' } }, _count: { select: { sources: true } } } });
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } });
  const s = await sessionFor(req);
  const [saved, workspace, match] = s ? await Promise.all([
    prisma.savedOpportunity.findUnique({ where: { userId_opportunityId: { userId: s.userId, opportunityId: row.id } } }),
    prisma.opportunityWorkspace.findUnique({ where: { userId_opportunityId: { userId: s.userId, opportunityId: row.id } }, select: { id: true, status: true, progress: true } }),
    prisma.match.findUnique({ where: { userId_opportunityId: { userId: s.userId, opportunityId: row.id } } }),
  ]) : [null, null, null];
  res.json(opportunityView(row, {
    saved: Boolean(saved), workspace,
    fitScore: match?.finalRank ?? (s ? deterministicFit(s.user, row) : null),
    fitEvidence: match ? { explanation: match.explanation, keySkillMatches: match.keySkillMatches || [], missingRequirements: match.missingRequirements || [], hardConstraints: match.hardConstraints || [], specialistNeeds: match.specialistNeeds || [], confidence: match.confidence } : null,
  }));
});
app.post('/api/internal/opportunities/reconcile-freshness', async (req, res) => {
  const key = String(req.headers['x-radar-internal-key'] || '');
  if (!process.env.RADAR_INTERNAL_KEY || key !== process.env.RADAR_INTERNAL_KEY) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Internal key required.' } });
  const now = new Date();
  const staleBefore = new Date(Date.now() - 72 * 3600000);
  const [expired, stale] = await Promise.all([
    prisma.opportunity.updateMany({ where: { deadline: { lt: now }, sourceStatus: { not: 'expired' } }, data: { sourceStatus: 'expired', verificationStatus: 'expired', closedAt: now } }),
    prisma.opportunity.updateMany({ where: { deadline: null, lastVerifiedAt: { lt: staleBefore }, sourceStatus: 'live' }, data: { sourceStatus: 'stale', verificationStatus: 'needs_review' } }),
  ]);
  res.json({ expired: expired.count, stale: stale.count, reconciledAt: now });
});

app.get('/api/stats', async (_req, res) => {
  const now = new Date();
  const sixHoursAgo = new Date(Date.now() - 6 * 3600000);
  const oneDayAgo = new Date(Date.now() - 24 * 3600000);
  const [live, remote, closingSoon, sourceRows, newLast6h] = await Promise.all([
    prisma.opportunity.count({ where: { OR: [{ deadline: null }, { deadline: { gte: now } }] } }),
    prisma.opportunity.count({ where: { remote: true, OR: [{ deadline: null }, { deadline: { gte: now } }] } }),
    prisma.opportunity.count({ where: { deadline: { gte: now, lte: new Date(Date.now() + 14 * 86400000) } } }),
    prisma.scraperSource.findMany({ where: { active: true }, select: { name: true, frequency: true, lastRun: true, lastSuccess: true } }),
    prisma.opportunity.count({ where: { discoveredAt: { gte: sixHoursAgo }, sourceStatus: 'live' } }),
  ]);
  const lastScanAt = sourceRows.map((row) => row.lastRun?.getTime() || 0).reduce((a, b) => Math.max(a, b), 0);
  res.json({
    live, remote, closingSoon, activeSources: sourceRows.length,
    feed: {
      lastScanAt: lastScanAt ? new Date(lastScanAt) : null,
      sourcesChecked24h: sourceRows.filter((row) => row.lastRun && row.lastRun >= oneDayAgo).length,
      hotSources: sourceRows.filter((row) => row.frequency === 'hot').length,
      newLast6h,
    },
  });
});

app.get('/api/me/feed-summary', requireSession, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
    const since = feedSince(user);
    const minFit = Math.max(0, Math.min(100, Number(safePrefs(user).minFitScore ?? 60)));
    const matches = await prisma.match.findMany({
      where: { userId: req.radarSession.userId, finalRank: { gte: minFit }, opportunity: { discoveredAt: { gt: since }, sourceStatus: 'live', OR: [{ deadline: null }, { deadline: { gte: new Date() } }] } },
      include: { opportunity: { include: { _count: { select: { sources: true } } } } },
      orderBy: { finalRank: 'desc' }, take: 200,
    });
    const [verifiedRoutes, changes] = await Promise.all([
      prisma.match.count({ where: { userId: req.radarSession.userId, finalRank: { gte: minFit }, opportunity: { applicationVerifiedAt: { gt: since }, sourceStatus: 'live' } } }),
      prisma.systemLog.findMany({ where: { source: 'opportunity-change', createdAt: { gt: since } }, orderBy: { createdAt: 'desc' }, take: 500 }),
    ]);
    const deadlineIds = [...new Set(changes.filter((log) => ['deadline_changed','deadline_added'].includes(String(log.metadata?.kind || ''))).map((log) => String(log.metadata?.opportunityId || '')).filter(Boolean))];
    const matchedDeadlineChanges = deadlineIds.length ? await prisma.match.count({ where: { userId: req.radarSession.userId, finalRank: { gte: minFit }, opportunityId: { in: deadlineIds } } }) : 0;
    res.json({
      since,
      counts: { newMatches: matches.length, strongMatches: matches.filter((item) => Number(item.finalRank) >= 72).length, applicationRoutesVerified: verifiedRoutes, deadlineChanges: matchedDeadlineChanges },
      items: matches.slice(0, 8).map((match) => opportunityView(match.opportunity, { fitScore: match.finalRank, feedScore: feedPriorityScore(match.opportunity, match.finalRank), newToUser: true })),
      checkedAt: new Date(),
    });
  } catch (error) { next(error); }
});
app.post('/api/me/feed-seen', requireSession, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
    const seenAt = new Date();
    const preferences = { ...safePrefs(user), lastFeedSeenAt: seenAt.toISOString() };
    await prisma.user.update({ where: { id: req.radarSession.userId }, data: { preferences } });
    res.json({ seenAt });
  } catch (error) { next(error); }
});

app.get('/api/me/priority-queue', requireSession, async (req, res, next) => {
  try {
    const userId = req.radarSession.userId;
    const now = new Date();
    const horizon = new Date(Date.now() + 30 * 86400000);
    const [workspaces, matches, applications, savedRows] = await Promise.all([
      prisma.opportunityWorkspace.findMany({
        where: { userId, status: { notIn: ['submitted','closed'] } },
        include: { opportunity: true, documents: true },
        orderBy: { updatedAt: 'desc' }, take: 20,
      }),
      prisma.match.findMany({
        where: { userId, opportunity: { AND: [{ OR: [{ deadline: null }, { deadline: { gte: now } }] }, { OR: [{ deadline: null }, { deadline: { lte: horizon } }] }] } },
        include: { opportunity: true }, orderBy: { finalRank: 'desc' }, take: 40,
      }),
      prisma.application.findMany({ where: { userId }, select: { opportunityId: true, status: true, updatedAt: true } }),
      prisma.savedOpportunity.findMany({ where: { userId }, select: { opportunityId: true } }),
    ]);
    const appMap = new Map(applications.map((item) => [item.opportunityId, item]));
    const workspaceIds = new Set(workspaces.map((item) => item.opportunityId));
    const savedIds = new Set(savedRows.map((item) => item.opportunityId));
    const seen = new Set();
    const items = [];
    const add = (item) => {
      if (!item?.opportunity?.id || seen.has(item.opportunity.id)) return;
      seen.add(item.opportunity.id); items.push(item);
    };
    for (const workspace of workspaces) {
      const deadline = workspace.submissionDeadline || workspace.opportunity?.deadline;
      const days = daysUntil(deadline);
      const incomplete = (workspace.documents || []).filter((d) => !['approved','complete'].includes(d.status)).length;
      const progress = workspaceProgress(workspace.documents || []);
      if ((days !== null && days <= 10) || incomplete > 0) {
        add({
          kind: days !== null && days <= 5 ? 'act_now' : 'application',
          urgency: days !== null && days <= 2 ? 'critical' : days !== null && days <= 5 ? 'high' : 'normal',
          title: days !== null && days <= 5 ? `${Math.max(0, days)} days left — application needs attention` : 'Continue application package',
          reason: incomplete ? `${incomplete} document${incomplete === 1 ? '' : 's'} still need work.` : `${progress}% of the package is ready.`,
          action: incomplete ? 'Open workspace and resolve the next incomplete document.' : 'Review and finalize the package.',
          workspaceId: workspace.id,
          progress,
          opportunity: opportunityView(workspace.opportunity),
        });
      }
    }
    for (const match of matches) {
      const opportunity = match.opportunity;
      if (!opportunity || workspaceIds.has(opportunity.id)) continue;
      const hard = match.hardConstraints || [];
      const missing = match.missingRequirements || [];
      const specialists = match.specialistNeeds || [];
      const days = daysUntil(opportunity.deadline);
      const app = appMap.get(opportunity.id);
      if (app && ['applied','interview','offer','rejected'].includes(app.status)) continue;
      const fitEvidence = { explanation: match.explanation, keySkillMatches: match.keySkillMatches || [], missingRequirements: missing, hardConstraints: hard, specialistNeeds: specialists, confidence: match.confidence };
      if (hard.length === 0 && Number(match.finalRank) >= 72) {
        add({
          kind: 'strong_match', urgency: days !== null && days <= 7 ? 'high' : 'normal',
          title: 'Strong match worth a decision',
          reason: `${Math.round(match.finalRank)}% fit${days !== null ? ` · ${Math.max(0, days)} days left` : ''}${savedIds.has(opportunity.id) ? ' · saved' : ''}.`,
          action: missing[0] ? `Verify evidence for: ${cleanOpportunityText(missing[0]).slice(0, 160)}` : 'Review eligibility and make the pursue/skip decision.',
          opportunity: opportunityView(opportunity, { fitScore: match.finalRank, fitEvidence }),
        });
      } else if (Number(match.finalRank) >= 60 && (missing.length || specialists.length) && hard.length === 0) {
        add({
          kind: 'evidence_gap', urgency: days !== null && days <= 7 ? 'high' : 'normal',
          title: specialists.length ? 'A partner could unlock this opportunity' : 'Evidence gap is blocking confidence',
          reason: specialists[0] || missing[0],
          action: specialists[0] ? `Find or assign: ${cleanOpportunityText(specialists[0]).slice(0, 160)}` : `Locate evidence for: ${cleanOpportunityText(missing[0]).slice(0, 160)}`,
          opportunity: opportunityView(opportunity, { fitScore: match.finalRank, fitEvidence }),
        });
      }
      if (items.length >= 8) break;
    }
    const ordered = items.sort((a, b) => {
      const weight = { critical: 4, high: 3, normal: 2, low: 1 };
      return (weight[b.urgency] || 0) - (weight[a.urgency] || 0) || Number(b.opportunity?.fitScore || 0) - Number(a.opportunity?.fitScore || 0);
    }).slice(0, 8);
    res.json({
      items: ordered,
      summary: {
        actNow: ordered.filter((item) => ['act_now','application'].includes(item.kind) && ['critical','high'].includes(item.urgency)).length,
        strongMatches: ordered.filter((item) => item.kind === 'strong_match').length,
        evidenceGaps: ordered.filter((item) => item.kind === 'evidence_gap').length,
        activeApplications: workspaces.length,
      },
      generatedAt: new Date(),
    });
  } catch (error) { next(error); }
});

app.get('/api/me/capability', requireSession, async (req, res, next) => {
  try { res.json({ capability: await capabilityContext(req.radarSession.userId) }); }
  catch (error) { next(error); }
});
app.put('/api/me/capability', requireSession, async (req, res, next) => {
  try {
    const input = req.body || {};
    const profileType = ['individual','firm','both'].includes(String(input.profileType)) ? String(input.profileType) : 'individual';
    const data = {
      profileType,
      legalName: String(input.legalName || '').trim().slice(0,180) || null,
      registrationNumber: String(input.registrationNumber || '').trim().slice(0,120) || null,
      registrationCountry: String(input.registrationCountry || '').trim().slice(0,120) || null,
      yearsOperating: input.yearsOperating === '' || input.yearsOperating == null ? null : Math.max(0, Math.min(200, Number(input.yearsOperating))),
      turnoverBand: String(input.turnoverBand || '').trim().slice(0,120) || null,
      sectors: cleanList(input.sectors, 40), countries: cleanList(input.countries, 60), donorExperience: cleanList(input.donorExperience, 50), licences: cleanList(input.licences, 50),
      referenceCount: Math.max(0, Math.min(10000, Number(input.referenceCount || 0))),
      canRecruitSpecialists: input.canRecruitSpecialists === true,
      metadata: safeJson(input.metadata),
    };
    const row = await prisma.capabilityProfile.upsert({ where: { userId: req.radarSession.userId }, create: { userId: req.radarSession.userId, ...data }, update: data });
    const user = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
    const prefs = safePrefs(user);
    await prisma.user.update({ where: { id: user.id }, data: { preferences: { ...prefs, profileType, canRecruitSpecialists: data.canRecruitSpecialists, countries: data.countries.length ? data.countries : prefs.countries, industries: data.sectors.length ? data.sectors : prefs.industries } } }).catch(() => undefined);
    await enqueueUserRematch(req.radarSession.userId);
    res.json({ capability: capabilityView(row) });
  } catch (error) { next(error); }
});

app.get('/api/me/profile', requireSession, (req, res) => res.json(publicUser(req.radarSession.user)));
app.put('/api/me/profile', requireSession, async (req, res, next) => {
  try {
    const input = req.body || {};
    const existingPrefs = safePrefs(req.radarSession.user);
    const incomingPrefs = safeJson(input.preferences);
    const preferences = { ...existingPrefs, ...incomingPrefs };
    const user = await prisma.user.update({ where: { id: req.radarSession.userId }, data: {
      name: input.name ? String(input.name).trim().slice(0, 120) : req.radarSession.user.name,
      phone: input.phone !== undefined ? String(input.phone || '').trim().slice(0, 40) || null : req.radarSession.user.phone,
      parsedSkills: input.skills ? cleanList(input.skills, 60) : req.radarSession.user.parsedSkills,
      parsedIndustries: input.industries ? cleanList(input.industries, 30) : req.radarSession.user.parsedIndustries,
      preferences, onboardingComplete: true,
    } });
    if (preferences.dailyBriefEnabled !== undefined) await upsertDailyAlert(user.id, preferences);
    await enqueueUserRematch(user.id);
    res.json(publicUser(user));
  } catch (error) { next(error); }
});
app.post('/api/me/resume', requireSession, async (req, res, next) => {
  try {
    const fileName = String(req.body?.fileName || 'profile.pdf').slice(0, 180);
    const mimeType = String(req.body?.mimeType || 'application/pdf');
    const base64 = String(req.body?.base64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!base64) return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Choose a CV or profile file first.' } });
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 5 * 1024 * 1024) return res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'CV files must be 5 MB or smaller.' } });
    let text = '';
    if (mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) text = String((await pdfParse(buffer)).text || '');
    else if (mimeType.startsWith('text/') || fileName.toLowerCase().endsWith('.txt')) text = buffer.toString('utf8');
    else return res.status(415).json({ error: { code: 'UNSUPPORTED_FILE', message: 'Radar currently accepts PDF or plain-text CV/profile files.' } });
    text = text.replace(/\u0000/g, '').trim().slice(0, 120000);
    if (text.length < 80) return res.status(422).json({ error: { code: 'CV_TEXT_UNREADABLE', message: 'Radar could not extract enough text from this file.' } });
    let extracted = null;
    if (AI_KEY) {
      try {
        const ai = await aiAssist('Extract an opportunity-matching profile from this CV. Return JSON only with keys skills (array max 25), industries (array max 12), summary (string max 500 chars). Do not invent experience.', { resumeText: text.slice(0, 24000) }, `radar-resume:${req.radarSession.userId}`, 'extract', 700);
        extracted = parsePossibleJson(ai.text);
      } catch (error) { console.warn('[radar] resume profile extraction failed', error); }
    }
    const current = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
    const skills = cleanList(extracted?.skills, 60), industries = cleanList(extracted?.industries, 30);
    const user = await prisma.user.update({ where: { id: req.radarSession.userId }, data: { resumeText: text, resumeUrl: fileName, parsedSkills: skills.length ? skills : current?.parsedSkills || [], parsedIndustries: industries.length ? industries : current?.parsedIndustries || [], onboardingComplete: true } });
    await enqueueUserRematch(user.id);
    res.json({ user: publicUser(user), extracted: extracted || null, characters: text.length });
  } catch (error) { next(error); }
});
app.delete('/api/me/resume', requireSession, async (req, res, next) => {
  try {
    const user = await prisma.user.update({ where: { id: req.radarSession.userId }, data: { resumeText: null, resumeUrl: null } });
    await enqueueUserRematch(user.id);
    res.json(publicUser(user));
  } catch (error) { next(error); }
});
app.get('/api/me/briefing', requireSession, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
  const alert = await prisma.alert.findFirst({ where: { userId: req.radarSession.userId, frequency: 'daily' } });
  res.json({ phone: user?.phone || null, preferences: safePrefs(user), alert: alert ? { id: alert.id, active: alert.active, lastSent: alert.lastSent, sendCount: alert.sendCount } : null });
});
app.put('/api/me/briefing', requireSession, async (req, res, next) => {
  try {
    const current = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
    const oldPrefs = safePrefs(current), input = req.body || {};
    const deliveryHour = [8, 9].includes(Number(input.deliveryHour)) ? Number(input.deliveryHour) : 8;
    const preferences = { ...oldPrefs, dailyBriefEnabled: input.enabled !== false, deliveryHour, timezone: String(input.timezone || oldPrefs.timezone || 'Africa/Kampala').slice(0, 80), emailBrief: input.email !== false, whatsappBrief: input.whatsapp === true, minFitScore: Math.max(0, Math.min(100, Number(input.minFitScore ?? oldPrefs.minFitScore ?? 60))), minDaysToDeadline: Math.max(0, Math.min(60, Number(input.minDaysToDeadline ?? oldPrefs.minDaysToDeadline ?? 7))) };
    const user = await prisma.user.update({ where: { id: req.radarSession.userId }, data: { phone: input.phone !== undefined ? String(input.phone || '').trim().slice(0, 40) || null : current?.phone, preferences } });
    const alert = await upsertDailyAlert(user.id, preferences);
    res.json({ phone: user.phone || null, preferences, alert: { id: alert.id, active: alert.active, lastSent: alert.lastSent, sendCount: alert.sendCount } });
  } catch (error) { next(error); }
});
app.get('/api/me/briefing/preview', requireSession, async (req, res, next) => {
  try { const user = await prisma.user.findUnique({ where: { id: req.radarSession.userId } }); res.json({ items: await briefingPreview(user) }); }
  catch (error) { next(error); }
});
app.post('/api/me/briefing/preview', requireSession, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
    const input = req.body || {};
    const overrides = {
      minFitScore: Math.max(0, Math.min(100, Number(input.minFitScore ?? 60))),
      minDaysToDeadline: Math.max(0, Math.min(60, Number(input.minDaysToDeadline ?? 7))),
      types: Array.isArray(input.types) ? cleanList(input.types, 20) : undefined,
      remote: input.remote === true,
    };
    res.json({ items: await briefingPreview(user, overrides), preview: true });
  } catch (error) { next(error); }
});

app.post('/api/opportunities/:id/save', requireSession, async (req, res) => {
  await prisma.savedOpportunity.upsert({ where: { userId_opportunityId: { userId: req.radarSession.userId, opportunityId: req.params.id } }, update: {}, create: { userId: req.radarSession.userId, opportunityId: req.params.id } });
  res.json({ saved: true });
});
app.delete('/api/opportunities/:id/save', requireSession, async (req, res) => {
  await prisma.savedOpportunity.deleteMany({ where: { userId: req.radarSession.userId, opportunityId: req.params.id } }); res.json({ saved: false });
});
app.get('/api/me/saved', requireSession, async (req, res) => {
  const rows = await prisma.savedOpportunity.findMany({ where: { userId: req.radarSession.userId }, include: { opportunity: true }, orderBy: { savedAt: 'desc' } });
  res.json({ items: rows.map((x) => opportunityView(x.opportunity, { saved: true, fitScore: deterministicFit(req.radarSession.user, x.opportunity) })) });
});
app.get('/api/me/applications', requireSession, async (req, res) => {
  const rows = await prisma.application.findMany({ where: { userId: req.radarSession.userId }, include: { opportunity: true }, orderBy: { updatedAt: 'desc' } });
  const workspaceMap = new Map((await prisma.opportunityWorkspace.findMany({ where: { userId: req.radarSession.userId, opportunityId: { in: rows.map((x) => x.opportunityId) } }, select: { id: true, opportunityId: true, status: true, progress: true } })).map((x) => [x.opportunityId, x]));
  res.json({ items: rows.map((x) => ({ id: x.id, status: x.status, notes: x.notes, coverLetter: x.coverLetter, aiGenerated: x.aiGenerated, appliedAt: x.appliedAt, updatedAt: x.updatedAt, workspaceId: workspaceMap.get(x.opportunityId)?.id || null, workspaceStatus: workspaceMap.get(x.opportunityId)?.status || null, workspaceProgress: workspaceMap.get(x.opportunityId)?.progress ?? null, opportunity: opportunityView(x.opportunity) })) });
});
app.post('/api/opportunities/:id/applications', requireSession, async (req, res) => {
  const status = APPLICATION_STATUSES.has(String(req.body?.status)) ? String(req.body.status) : 'planning';
  const data = { status, notes: String(req.body?.notes || '').slice(0, 8000), ...(status === 'applied' ? { appliedAt: new Date() } : {}) };
  const row = await prisma.application.upsert({ where: { userId_opportunityId: { userId: req.radarSession.userId, opportunityId: req.params.id } }, update: data, create: { userId: req.radarSession.userId, opportunityId: req.params.id, ...data } });
  res.json(row);
});
app.post('/api/opportunities/:id/eligibility', requireSession, async (req, res, next) => {
  try {
    const opportunity = await prisma.opportunity.findUnique({ where: { id: req.params.id } });
    if (!opportunity) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } });
    const user = req.radarSession.user;
    const preferences = safePrefs(user);
    const capability = await capabilityContext(user.id);
    const library = await libraryContext(user.id, 8);
    const baseScore = deterministicFit(user, opportunity);
    const ai = await aiAssist(
      'Act as a strict opportunity eligibility analyst. Return valid JSON only with keys: decision (pursue|consider|skip), fitScore (0-100), confidence (0-1), summary (max 45 words), keySkillMatches (array), missingRequirements (array), hardConstraints (array), specialistNeeds (array), requirements (array of objects with requirement, status, evidence, action). Allowed status values: met, likely_met, missing_evidence, not_met, partner_solvable. Test explicit requirements against supplied profile/capability/evidence only. Never infer a credential, reference, registration, turnover, licence, qualification, geography, language or experience that is not evidenced. For firm/both profiles that can recruit specialists, classify recruitable technical expertise as partner_solvable rather than not_met, but do not soften corporate/legal/financial eligibility. Keep requirements to the 12 most decision-relevant items.',
      {
        profile: {
          name: user.name,
          skills: user.parsedSkills || [],
          industries: user.parsedIndustries || [],
          preferences,
          capability,
          resumeText: String(user.resumeText || '').slice(0, 4500),
        },
        evidenceLibrary: compactLibrary(library.slice(0, 8), 650),
        opportunity: compactAiOpportunity(opportunity, 1200),
        deterministicFitScore: baseScore,
      },
      `radar-eligibility:${opportunity.id}:${user.id}`.slice(0, 220),
      'analyze',
      720,
      'interactive'
    );
    const parsed = parsePossibleJson(ai.text) || {};
    const keySkillMatches = cleanList(parsed.keySkillMatches, 20);
    const missingRequirements = cleanList(parsed.missingRequirements, 20);
    const hardConstraints = cleanList(parsed.hardConstraints, 20);
    const specialistNeeds = cleanList(parsed.specialistNeeds, 20);
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? .6)));
    const aiScore = Math.max(0, Math.min(100, Number(parsed.fitScore ?? baseScore)));
    const requirements = Array.isArray(parsed.requirements) ? parsed.requirements.slice(0, 12).map((item) => ({
      requirement: cleanOpportunityText(item?.requirement).slice(0, 260),
      status: ['met','likely_met','missing_evidence','not_met','partner_solvable'].includes(String(item?.status)) ? String(item.status) : 'missing_evidence',
      evidence: cleanOpportunityText(item?.evidence).slice(0, 360),
      action: cleanOpportunityText(item?.action).slice(0, 320),
    })).filter((item) => item.requirement) : [];
    const explanation = cleanOpportunityText(parsed.summary || parsed.explanation || ai.text).slice(0, 1600) || 'Eligibility analysis completed.';
    const match = await prisma.match.upsert({
      where: { userId_opportunityId: { userId: user.id, opportunityId: opportunity.id } },
      update: { gptMatchScore: aiScore, explanation, keySkillMatches, missingRequirements, hardConstraints, specialistNeeds, confidence, finalRank: aiScore },
      create: { userId: user.id, opportunityId: opportunity.id, gptMatchScore: aiScore, explanation, keySkillMatches, missingRequirements, hardConstraints, specialistNeeds, confidence, finalRank: aiScore },
    });
    res.json({
      decision: ['pursue','consider','skip'].includes(String(parsed.decision)) ? String(parsed.decision) : null,
      fitScore: match.finalRank,
      confidence,
      explanation,
      keySkillMatches,
      missingRequirements,
      hardConstraints,
      specialistNeeds,
      requirements,
      interactionId: ai.interactionId,
      model: ai.model,
    });
  } catch (error) { next(error); }
});

app.post('/api/opportunities/:id/fit', requireSession, async (req, res, next) => {
  try {
    const opportunity = await prisma.opportunity.findUnique({ where: { id: req.params.id } });
    if (!opportunity) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } });
    const user = req.radarSession.user, score = deterministicFit(user, opportunity), preferences = safePrefs(user), capability = await capabilityContext(user.id);
    const ai = await aiAssist('Explain this fit in 4 concise sections: Why it fits, Hard constraints, Specialists/partners to add if relevant, and Best next action. If this is a firm profile that can recruit specialists, do not reject only because a sector expert is not currently in-house. Do not invent eligibility, experience, references or partnerships.', { profile: { skills: user.parsedSkills, industries: user.parsedIndustries, preferences, capability, hasResume: Boolean(user.resumeText) }, opportunity: opportunityView(opportunity), deterministicFitScore: score }, `radar-opportunity:${opportunity.id}`, 'analyze', 520);
    const match = await prisma.match.upsert({ where: { userId_opportunityId: { userId: user.id, opportunityId: opportunity.id } }, update: { gptMatchScore: score, explanation: ai.text, finalRank: score, freshnessScore: Math.max(0, 100 - Math.max(0, daysUntil(opportunity.deadline) ?? 30)) }, create: { userId: user.id, opportunityId: opportunity.id, gptMatchScore: score, explanation: ai.text, finalRank: score, freshnessScore: Math.max(0, 100 - Math.max(0, daysUntil(opportunity.deadline) ?? 30)) } });
    res.json({ fitScore: score, explanation: match.explanation, interactionId: ai.interactionId, model: ai.model });
  } catch (error) { next(error); }
});
app.post('/api/opportunities/:id/brief', requireSession, async (req, res, next) => {
  try {
    const opportunity = await prisma.opportunity.findUnique({ where: { id: req.params.id } });
    if (!opportunity) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } });
    const user = req.radarSession.user;
    const ai = await aiAssist('Prepare a concise opportunity briefing with: What it is, why it may fit this profile, deadline and hard constraints explicitly present, bid/apply recommendation, and a 5-item next-step checklist. Use only supplied facts. If specialists could close domain gaps, say which profiles are needed without implying they are already hired.', { profile: { skills: user.parsedSkills, industries: user.parsedIndustries, preferences: safePrefs(user) }, opportunity: opportunityView(opportunity) }, `radar-brief:${opportunity.id}`, 'summarize', 620);
    await prisma.opportunity.update({ where: { id: opportunity.id }, data: { aiSummary: ai.text } });
    res.json({ text: ai.text, interactionId: ai.interactionId, model: ai.model });
  } catch (error) { next(error); }
});

app.get('/api/me/workspaces', requireSession, async (req, res, next) => {
  try {
    const rows = await prisma.opportunityWorkspace.findMany({ where: { OR: [{ userId: req.radarSession.userId }, { members: { some: { userId: req.radarSession.userId, status: 'accepted' } } }] }, include: { opportunity: true, documents: true, members: true }, orderBy: { updatedAt: 'desc' } });
    res.json({ items: rows.map((row) => ({ ...workspaceView({ ...row, progress: workspaceProgress(row.documents) }), accessRole: workspaceRole(row, req.radarSession.userId) })) });
  } catch (error) { next(error); }
});
app.post('/api/opportunities/:id/workspace', requireSession, async (req, res, next) => {
  try {
    const opportunity = await prisma.opportunity.findUnique({ where: { id: req.params.id } });
    if (!opportunity) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } });
    let workspace = await prisma.opportunityWorkspace.findUnique({ where: { userId_opportunityId: { userId: req.radarSession.userId, opportunityId: opportunity.id } }, include: { opportunity: true, documents: true, members: true, comments: true } });
    if (!workspace) {
      const workspaceCount = await prisma.opportunityWorkspace.count({ where: { userId: req.radarSession.userId, status: { notIn: ['closed'] } } });
      await enforceLimit({ prisma, session: req.radarSession, metric: 'workspaces', resourceCount: workspaceCount });
      workspace = await prisma.$transaction(async (tx) => {
        const created = await tx.opportunityWorkspace.create({ data: { userId: req.radarSession.userId, opportunityId: opportunity.id, name: String(req.body?.name || `${compactOpportunityTitle(opportunity.title)} — Application`).slice(0, 180), submissionDeadline: opportunity.deadline || null } });
        await tx.workspaceDocument.createMany({ data: seededDocumentSpecs(opportunity.type).map(([title, kind]) => ({ workspaceId: created.id, title, kind, status: 'pending' })) });
        await tx.workspaceMember.create({ data: { workspaceId: created.id, userId: req.radarSession.userId, name: req.radarSession.user.name, email: req.radarSession.user.email, role: 'owner', status: 'accepted' } });
        return tx.opportunityWorkspace.findUnique({ where: { id: created.id }, include: { opportunity: true, documents: true, members: true, comments: true } });
      });
      await createNotification(req.radarSession.userId, 'workspace_created', 'Application workspace created', `Radar created a preparation workspace for ${compactOpportunityTitle(opportunity.title)}.`, { opportunityId: opportunity.id, workspaceId: workspace.id });
    }
    res.json(workspaceView({ ...workspace, progress: workspaceProgress(workspace.documents) }));
  } catch (error) { next(error); }
});
app.get('/api/workspaces/:id', requireSession, async (req, res, next) => {
  try {
    const row = await accessibleWorkspace(req.radarSession.userId, req.params.id, { opportunity: true, documents: { orderBy: { createdAt: 'asc' } }, members: { orderBy: { createdAt: 'asc' } }, comments: { orderBy: { createdAt: 'desc' } } });
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    const progress = workspaceProgress(row.documents);
    if (progress !== row.progress) await prisma.opportunityWorkspace.update({ where: { id: row.id }, data: { progress } }).catch(() => undefined);
    res.json({ ...workspaceView({ ...row, progress }), accessRole: workspaceRole(row, req.radarSession.userId) });
  } catch (error) { next(error); }
});
app.patch('/api/workspaces/:id', requireSession, async (req, res, next) => {
  try {
    const found = await accessibleWorkspace(req.radarSession.userId, req.params.id);
    if (!found) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    requireWorkspaceRole(found, req.radarSession.userId, ['owner','editor']);
    const data = {};
    if (req.body?.name !== undefined) data.name = String(req.body.name || '').trim().slice(0, 180) || found.name;
    if (req.body?.status !== undefined) {
      const nextStatus = String(req.body.status);
      if (!WORKSPACE_STATUSES.has(nextStatus)) return res.status(400).json({ error: { code: 'INVALID_WORKSPACE_STATUS', message: 'Unknown workspace status.' } });
      if (!validTransition(WORKSPACE_TRANSITIONS, found.status, nextStatus)) return res.status(409).json({ error: { code: 'INVALID_STATUS_TRANSITION', message: `Workspace cannot move from ${found.status} to ${nextStatus}.` } });
      data.status = nextStatus;
    }
    if (req.body?.submissionDeadline !== undefined) data.submissionDeadline = req.body.submissionDeadline ? new Date(req.body.submissionDeadline) : null;
    res.json(workspaceView(await prisma.opportunityWorkspace.update({ where: { id: found.id }, data, include: { opportunity: true, documents: true, members: true, comments: true } })));
  } catch (error) { next(error); }
});
app.post('/api/workspaces/:id/ai/plan', requireSession, async (req, res, next) => {
  try {
    const row = await accessibleWorkspace(req.radarSession.userId, req.params.id, { opportunity: true, documents: true });
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    requireWorkspaceRole(row, req.radarSession.userId, ['owner','editor']);
    const user = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
    const library = await libraryContext(user.id, 8);
    const capability = await capabilityContext(user.id);
    const ai = await aiAssist(
      'Build a compact practical application/bid plan. Return valid JSON only with keys recommendation (pursue|hold|skip), rationale, hardConstraints, evidenceGaps, specialistNeeds, documents (array of {title, nextAction}), timeline (array of {when, action}), and nextBestAction. Keep rationale under 55 words; hardConstraints, evidenceGaps and specialistNeeds to at most 3 items each; timeline to at most 4 short relative steps such as Today or Next 48 hours unless an exact date is supplied; documents to required documents only. Use only supplied facts. Missing facts must be labelled as gaps, never guessed. Finish the JSON within the response limit.',
      { profile: { skills: user.parsedSkills, industries: user.parsedIndustries, preferences: safePrefs(user), capability }, opportunity: compactAiOpportunity(row.opportunity, 850), documents: row.documents.map((d) => ({ title: d.title, kind: d.kind, status: d.status })), reusableLibrary: library.slice(0, 6).map((d) => ({ title: d.title, category: d.category })) },
      `radar-workspace-plan:${row.id}`, 'recommend', 320, 'interactive'
    );
    const parsed = parsePossibleJson(ai.text);
    const updated = await prisma.opportunityWorkspace.update({ where: { id: row.id }, data: { aiPlan: ai.text, aiPlanStructured: parsed || undefined, lastAiInteractionId: ai.interactionId || null } });
    res.json({ text: ai.text, structured: parsed, model: ai.model, interactionId: ai.interactionId, workspace: workspaceView(updated) });
  } catch (error) { next(error); }
});
app.patch('/api/workspaces/:id/documents/:documentId', requireSession, async (req, res, next) => {
  try {
    const workspace = await accessibleWorkspace(req.radarSession.userId, req.params.id);
    if (!workspace) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    requireWorkspaceRole(workspace, req.radarSession.userId, ['owner','editor']);
    const document = await prisma.workspaceDocument.findFirst({ where: { id: req.params.documentId, workspaceId: workspace.id } });
    if (!document) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } });
    const data = {};
    if (req.body?.status !== undefined) {
      const nextStatus = String(req.body.status);
      if (!DOCUMENT_STATUSES.has(nextStatus)) return res.status(400).json({ error: { code: 'INVALID_DOCUMENT_STATUS', message: 'Unknown document status.' } });
      if (!validTransition(DOCUMENT_TRANSITIONS, document.status, nextStatus)) return res.status(409).json({ error: { code: 'INVALID_STATUS_TRANSITION', message: `Document cannot move from ${document.status} to ${nextStatus}.` } });
      data.status = nextStatus;
    }
    if (req.body?.content !== undefined) { const nextContent = String(req.body.content || '').slice(0, 200000); data.content = nextContent; data.checksum = crypto.createHash('sha256').update(nextContent).digest('hex'); data.lastSavedByUserId = req.radarSession.userId; data.version = { increment: 1 }; }
    if (req.body?.metadata !== undefined) data.metadata = safeJson(req.body.metadata);
    const updated = await prisma.workspaceDocument.update({ where: { id: document.id }, data });
    const docs = await prisma.workspaceDocument.findMany({ where: { workspaceId: workspace.id } });
    await prisma.opportunityWorkspace.update({ where: { id: workspace.id }, data: { progress: workspaceProgress(docs) } });
    res.json(documentView(updated));
  } catch (error) { next(error); }
});
app.post('/api/workspaces/:id/documents/:documentId/ai-draft', requireSession, async (req, res, next) => {
  try {
    const workspace = await accessibleWorkspace(req.radarSession.userId, req.params.id, { opportunity: true, documents: true });
    if (!workspace) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    requireWorkspaceRole(workspace, req.radarSession.userId, ['owner','editor']);
    const document = workspace.documents.find((d) => d.id === req.params.documentId);
    if (!document) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } });
    const user = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
    const usage = await usageSnapshot(prisma, req.radarSession.userId);
    await enforceLimit({ prisma, session: req.radarSession, metric: 'ai_drafts', currentCount: usage.aiDrafts });
    const library = await libraryContext(user.id, 10);
    const capability = await capabilityContext(user.id);
    const instruction = `Draft the workspace document titled "${document.title}". Use only facts in the supplied profile, opportunity and reusable document library. Never invent past performance, partners, team members, budgets, certifications, dates, references or eligibility. Where required information is absent, insert an explicit [NEEDS INPUT: ...] placeholder. Preserve a professional submission-ready structure. Do not claim the application has been submitted.`;
    const ai = await aiAssist(instruction, { profile: { name: user.name, skills: user.parsedSkills, industries: user.parsedIndustries, preferences: safePrefs(user), capability, resumeText: String(user.resumeText || '').slice(0, 3500) }, opportunity: compactAiOpportunity(workspace.opportunity, 900), reusableLibrary: compactLibrary(library.slice(0, 6), 700), otherWorkspaceDocuments: workspace.documents.filter((d) => d.id !== document.id).map((d) => ({ title: d.title, status: d.status, content: String(d.content || '').slice(0, 700) })), userInstruction: String(req.body?.instruction || '').slice(0, 1000) }, `radar-workspace-doc:${document.id}`, 'draft', 420, 'interactive');
    await recordUsage(prisma, req.radarSession.userId, 'ai_drafts');
    const updated = await prisma.workspaceDocument.update({ where: { id: document.id }, data: { content: ai.text, checksum: crypto.createHash('sha256').update(ai.text).digest('hex'), evidenceRefs: library.map((item) => ({ title: item.title, category: item.category })), lastSavedByUserId: req.radarSession.userId, generatedByAi: true, status: 'review', version: { increment: 1 }, metadata: { ...safeJson(document.metadata), lastAiInteractionId: ai.interactionId || null, lastAiModel: ai.model || null } } });
    const docs = await prisma.workspaceDocument.findMany({ where: { workspaceId: workspace.id } });
    await prisma.opportunityWorkspace.update({ where: { id: workspace.id }, data: { progress: workspaceProgress(docs), status: 'review' } });
    res.json({ document: documentView(updated), model: ai.model, interactionId: ai.interactionId });
  } catch (error) { next(error); }
});
app.post('/api/workspaces/:id/documents/:documentId/ai-review', requireSession, async (req, res, next) => {
  try {
    const workspace = await accessibleWorkspace(req.radarSession.userId, req.params.id, { opportunity: true, documents: true });
    if (!workspace) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    requireWorkspaceRole(workspace, req.radarSession.userId, ['owner','editor','reviewer']);
    const document = workspace.documents.find((d) => d.id === req.params.documentId);
    if (!document) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } });
    if (!document.content) return res.status(422).json({ error: { code: 'DOCUMENT_EMPTY', message: 'Draft the document before requesting a review.' } });
    const ai = await aiAssist('Review this draft against the opportunity. Return concise sections: Coverage, Unsupported or risky claims, Missing evidence, Consistency issues, Required edits, and Submission readiness (0-100). Treat any [NEEDS INPUT] placeholders as unresolved. Never invent replacement facts.', { opportunity: compactAiOpportunity(workspace.opportunity, 800), document: { title: document.title, content: String(document.content || '').slice(0, 4500) }, otherDocuments: workspace.documents.filter((d) => d.id !== document.id).map((d) => ({ title: d.title, status: d.status })) }, `radar-workspace-review:${document.id}`, 'analyze', 300, 'interactive');
    await prisma.workspaceDocument.update({ where: { id: document.id }, data: { status: 'review', metadata: { ...safeJson(document.metadata), lastReview: ai.text, lastReviewInteractionId: ai.interactionId || null } } });
    res.json({ text: ai.text, model: ai.model, interactionId: ai.interactionId });
  } catch (error) { next(error); }
});
app.get('/api/workspaces/:id/readiness', requireSession, async (req, res, next) => {
  try {
    const workspace = await accessibleWorkspace(req.radarSession.userId, req.params.id, { documents: true, opportunity: true, comments: true });
    if (!workspace) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    const match = await prisma.match.findUnique({ where: { userId_opportunityId: { userId: req.radarSession.userId, opportunityId: workspace.opportunityId } } });
    res.json(workspaceReadinessAssessment(workspace, match));
  } catch (error) { next(error); }
});
app.post('/api/workspaces/:id/finalize', requireSession, async (req, res, next) => {
  try {
    const workspace = await accessibleWorkspace(req.radarSession.userId, req.params.id, { documents: true, opportunity: true, comments: true });
    if (!workspace) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    requireWorkspaceRole(workspace, req.radarSession.userId, ['owner','editor']);
    const match = await prisma.match.findUnique({ where: { userId_opportunityId: { userId: req.radarSession.userId, opportunityId: workspace.opportunityId } } });
    const readiness = workspaceReadinessAssessment(workspace, match);
    if (!readiness.canFinalize) return res.status(409).json({ error: { code: 'SUBMISSION_READINESS_BLOCKED', message: 'Resolve Radar submission-readiness blockers before finalizing this package.', details: readiness.blockers.map((item) => item.message), readiness } });
    const updated = await prisma.opportunityWorkspace.update({ where: { id: workspace.id }, data: { status: 'ready', progress: 100 } });
    await createNotification(req.radarSession.userId, 'workspace_ready', 'Application package ready', `${compactOpportunityTitle(workspace.opportunity.title)} passed Radar readiness gates and is internally ready for submission. Radar has not submitted it.`, { workspaceId: workspace.id, opportunityId: workspace.opportunityId, readinessScore: readiness.score });
    res.json({ ...workspaceView(updated), readiness });
  } catch (error) { next(error); }
});
app.post('/api/workspaces/:id/submit', requireSession, async (req, res, next) => {
  try {
    if (req.body?.confirmation !== true) return res.status(400).json({ error: { code: 'CONFIRMATION_REQUIRED', message: 'Explicit confirmation is required before Radar records an application as submitted.' } });
    const workspace = await accessibleWorkspace(req.radarSession.userId, req.params.id, { opportunity: true });
    if (!workspace) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    requireWorkspaceRole(workspace, req.radarSession.userId, ['owner']);
    if (workspace.status !== 'ready') return res.status(409).json({ error: { code: 'WORKSPACE_NOT_READY', message: 'Finalize the package before recording submission.' } });
    await prisma.$transaction([
      prisma.opportunityWorkspace.update({ where: { id: workspace.id }, data: { status: 'submitted', progress: 100 } }),
      prisma.application.upsert({ where: { userId_opportunityId: { userId: req.radarSession.userId, opportunityId: workspace.opportunityId } }, update: { status: 'applied', appliedAt: new Date() }, create: { userId: req.radarSession.userId, opportunityId: workspace.opportunityId, status: 'applied', appliedAt: new Date() } }),
    ]);
    await createNotification(req.radarSession.userId, 'application_submitted', 'Submission recorded', `You confirmed submission of ${compactOpportunityTitle(workspace.opportunity.title)}.`, { workspaceId: workspace.id, opportunityId: workspace.opportunityId });
    res.json({ recorded: true, message: 'Submission recorded in Radar. This endpoint records your confirmation; it does not submit to the external opportunity portal.' });
  } catch (error) { next(error); }
});

app.get('/api/workspaces/:id/comments', requireSession, async (req, res, next) => {
  try {
    const workspace = await accessibleWorkspace(req.radarSession.userId, req.params.id);
    if (!workspace) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    res.json({ items: await prisma.workspaceComment.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: 'desc' } }) });
  } catch (error) { next(error); }
});
app.post('/api/workspaces/:id/comments', requireSession, async (req, res, next) => {
  try {
    const workspace = await accessibleWorkspace(req.radarSession.userId, req.params.id);
    if (!workspace) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    requireWorkspaceRole(workspace, req.radarSession.userId, ['owner','editor','reviewer']);
    const body = String(req.body?.body || '').trim().slice(0, 8000);
    if (!body) return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Comment text is required.' } });
    const documentId = req.body?.documentId ? String(req.body.documentId) : null;
    if (documentId && !(await prisma.workspaceDocument.findFirst({ where: { id: documentId, workspaceId: workspace.id } }))) return res.status(400).json({ error: { code: 'INVALID_DOCUMENT', message: 'Document does not belong to this workspace.' } });
    res.json(await prisma.workspaceComment.create({ data: { workspaceId: workspace.id, documentId, authorUserId: req.radarSession.userId, authorName: req.radarSession.user.name || req.radarSession.user.email, body } }));
  } catch (error) { next(error); }
});
app.patch('/api/workspaces/:id/comments/:commentId', requireSession, async (req, res, next) => {
  try {
    const workspace = await accessibleWorkspace(req.radarSession.userId, req.params.id);
    if (!workspace) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    requireWorkspaceRole(workspace, req.radarSession.userId, ['owner','editor','reviewer']);
    const comment = await prisma.workspaceComment.findFirst({ where: { id: req.params.commentId, workspaceId: workspace.id } });
    if (!comment) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Comment not found.' } });
    const status = req.body?.status === 'resolved' ? 'resolved' : 'open';
    res.json(await prisma.workspaceComment.update({ where: { id: comment.id }, data: { status, resolvedAt: status === 'resolved' ? new Date() : null } }));
  } catch (error) { next(error); }
});
app.post('/api/workspaces/:id/members', requireSession, async (req, res, next) => {
  try {
    const workspace = await accessibleWorkspace(req.radarSession.userId, req.params.id, { opportunity: true });
    if (!workspace) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    requireWorkspaceRole(workspace, req.radarSession.userId, ['owner']);
    await enforceLimit({ prisma, session: req.radarSession, metric: 'collaboration' });
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 240);
    if (!email.includes('@')) return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'A valid collaborator email is required.' } });
    if (email === String(req.radarSession.user.email || '').toLowerCase()) return res.status(409).json({ error: { code: 'ALREADY_OWNER', message: 'You already own this workspace.' } });
    const role = MEMBER_ROLES.has(String(req.body?.role)) ? String(req.body.role) : 'reviewer';
    const knownUser = await prisma.user.findUnique({ where: { email } });
    const status = knownUser ? 'accepted' : 'invited';
    const member = await prisma.workspaceMember.upsert({
      where: { workspaceId_email: { workspaceId: workspace.id, email } },
      update: { role, name: String(req.body?.name || knownUser?.name || '').slice(0, 120) || null, userId: knownUser?.id || null, status },
      create: { workspaceId: workspace.id, email, role, name: String(req.body?.name || knownUser?.name || '').slice(0, 120) || null, userId: knownUser?.id || null, status },
    });
    if (knownUser) await createNotification(knownUser.id, 'workspace_invite', 'You were added to a Radar workspace', `${req.radarSession.user.name || req.radarSession.user.email} added you as ${role} to ${compactOpportunityTitle(workspace.opportunity?.title || workspace.name)}.`, { workspaceId: workspace.id, opportunityId: workspace.opportunityId, role });
    let delivery = { delivered: false, reason: 'not_attempted' };
    try { delivery = await sendWorkspaceInviteEmail({ email, inviter: req.radarSession.user.name || req.radarSession.user.email, workspace, role }); }
    catch (mailError) { console.warn('[radar] workspace invite email failed', mailError?.message || mailError); delivery = { delivered: false, reason: 'send_failed' }; }
    res.json({ member, delivery });
  } catch (error) { next(error); }
});
app.post('/api/workspaces/:id/ai/team-summary', requireSession, async (req, res, next) => {
  try {
    const workspace = await accessibleWorkspace(req.radarSession.userId, req.params.id, { opportunity: true, comments: true, documents: true, members: true });
    if (!workspace) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found.' } });
    requireWorkspaceRole(workspace, req.radarSession.userId, ['owner','editor','reviewer']);
    const ai = await aiAssist('Summarize unresolved team review work. Identify decisions needed, document-specific edits, blockers, owners when explicitly stated, and the next three actions. Do not invent assignments or decisions.', { opportunity: compactAiOpportunity(workspace.opportunity, 650), documents: workspace.documents.map((d) => ({ id: d.id, title: d.title, status: d.status })), members: workspace.members.map((m) => ({ name: m.name, email: m.email, role: m.role })), comments: workspace.comments.filter((c) => c.status !== 'resolved').slice(0, 20).map((c) => ({ documentId: c.documentId, authorName: c.authorName, body: String(c.body || '').slice(0, 500) })) }, `radar-team-summary:${workspace.id}`, 'summarize', 260, 'interactive');
    res.json({ text: ai.text, model: ai.model, interactionId: ai.interactionId });
  } catch (error) { next(error); }
});

app.get('/api/me/documents', requireSession, async (req, res, next) => {
  try { const rows = await prisma.userDocument.findMany({ where: { userId: req.radarSession.userId }, orderBy: { updatedAt: 'desc' } }); res.json({ items: rows.map((r) => userDocumentView(r, false)) }); }
  catch (error) { next(error); }
});
app.get('/api/me/evidence-health', requireSession, async (req, res, next) => {
  try {
    const userId = req.radarSession.userId;
    const [docs, matches] = await Promise.all([
      prisma.userDocument.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } }),
      prisma.match.findMany({ where: { userId, finalRank: { gte: 55 } }, include: { opportunity: true }, orderBy: { finalRank: 'desc' }, take: 40 }),
    ]);
    const now = new Date();
    const aiReady = docs.filter((d) => Boolean(d.content)).length;
    const extracted = docs.filter((d) => d.extractedClaims && typeof d.extractedClaims === 'object').length;
    const verified = docs.filter((d) => ['verified','machine_extracted'].includes(d.verificationStatus)).length;
    const expired = docs.filter((d) => d.expiresAt && d.expiresAt < now).length;
    const categories = [...new Set(docs.map((d) => d.category).filter(Boolean))];
    const claimCount = docs.reduce((sum, d) => sum + (Array.isArray(d.extractedClaims?.claims) ? d.extractedClaims.claims.length : 0), 0);
    const evidenceDocs = docs.map((d) => ({
      id: d.id, title: d.title, category: d.category,
      text: `${d.title} ${d.category} ${String(d.content || '').slice(0, 12000)} ${JSON.stringify(d.extractedClaims || {})}`.toLowerCase(),
    }));
    const tokenize = (value) => [...new Set(String(value || '').toLowerCase().split(/[^a-z0-9+#.-]+/).filter((x) => x.length >= 4))].slice(0, 24);
    const gapMap = new Map();
    for (const match of matches) {
      for (const requirement of (match.missingRequirements || []).slice(0, 12)) {
        const clean = cleanOpportunityText(requirement).slice(0, 320);
        if (!clean) continue;
        const tokens = tokenize(clean);
        let best = null;
        for (const doc of evidenceDocs) {
          const hits = tokens.filter((token) => doc.text.includes(token)).length;
          const ratio = tokens.length ? hits / Math.min(tokens.length, 8) : 0;
          if (!best || ratio > best.ratio) best = { ratio, doc };
        }
        const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 180);
        const existing = gapMap.get(key) || { requirement: clean, occurrences: 0, opportunities: [], likelyEvidence: null };
        existing.occurrences += 1;
        if (existing.opportunities.length < 3) existing.opportunities.push({ id: match.opportunityId, title: compactOpportunityTitle(match.opportunity?.title || ''), fitScore: Math.round(match.finalRank) });
        if (best?.ratio >= .5 && (!existing.likelyEvidence || best.ratio > existing.likelyEvidence.score)) existing.likelyEvidence = { documentId: best.doc.id, title: best.doc.title, category: best.doc.category, score: Math.round(best.ratio * 100) };
        gapMap.set(key, existing);
      }
    }
    const gaps = [...gapMap.values()].sort((a, b) => b.occurrences - a.occurrences).slice(0, 10);
    const coveredGaps = gaps.filter((g) => g.likelyEvidence).length;
    const unresolvedGaps = gaps.filter((g) => !g.likelyEvidence);
    const score = Math.max(0, Math.min(100, Math.round(
      (docs.length ? 15 : 0) + Math.min(25, aiReady * 7) + Math.min(25, extracted * 8) + Math.min(15, categories.length * 4) + Math.min(10, verified * 3) + (gaps.length ? Math.round((coveredGaps / gaps.length) * 10) : 10) - Math.min(15, expired * 5)
    )));
    res.json({
      score,
      totals: { documents: docs.length, aiReady, extracted, verified, expired, claims: claimCount, categories: categories.length },
      categories,
      coverage: { trackedGaps: gaps.length, likelyCovered: coveredGaps, unresolved: unresolvedGaps.length },
      unresolvedGaps: unresolvedGaps.slice(0, 6),
      likelyCoveredGaps: gaps.filter((g) => g.likelyEvidence).slice(0, 6),
      generatedAt: now,
    });
  } catch (error) { next(error); }
});

app.get('/api/me/documents/:id', requireSession, async (req, res, next) => {
  try { const row = await prisma.userDocument.findFirst({ where: { id: req.params.id, userId: req.radarSession.userId } }); if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } }); res.json(userDocumentView(row, true)); }
  catch (error) { next(error); }
});
app.post('/api/me/documents', requireSession, async (req, res, next) => {
  try {
    const title = String(req.body?.title || '').trim().slice(0, 180);
    if (!title) return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Document title is required.' } });
    const category = DOCUMENT_CATEGORIES.has(String(req.body?.category)) ? String(req.body.category) : 'other';
    const fileName = String(req.body?.fileName || '').slice(0, 180) || null;
    const mimeType = String(req.body?.mimeType || '').slice(0, 120) || null;
    let content = String(req.body?.content || '').trim();
    const base64 = String(req.body?.base64 || '').replace(/^data:[^;]+;base64,/, '');
    if (base64) {
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > 5 * 1024 * 1024) return res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'Reusable documents must be 5 MB or smaller.' } });
      if (mimeType === 'application/pdf' || fileName?.toLowerCase().endsWith('.pdf')) content = String((await pdfParse(buffer)).text || '');
      else if (mimeType?.startsWith('text/') || fileName?.toLowerCase().endsWith('.txt')) content = buffer.toString('utf8');
      else return res.status(415).json({ error: { code: 'UNSUPPORTED_FILE', message: 'Radar currently extracts PDF or TXT reusable documents.' } });
    }
    content = content.replace(/\u0000/g, '').trim().slice(0, 180000);
    const checksum = content ? crypto.createHash('sha256').update(content).digest('hex') : null;
    const row = await prisma.userDocument.create({ data: { userId: req.radarSession.userId, title, category, fileName, mimeType, content: content || null, checksum, sourceType: base64 ? 'upload' : 'manual', verificationStatus: 'unverified', metadata: safeJson(req.body?.metadata), expiresAt: req.body?.expiresAt ? new Date(req.body.expiresAt) : null } });
    res.json(userDocumentView(row, true));
  } catch (error) { next(error); }
});
app.patch('/api/me/documents/:id', requireSession, async (req, res, next) => {
  try {
    const found = await prisma.userDocument.findFirst({ where: { id: req.params.id, userId: req.radarSession.userId } });
    if (!found) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } });
    const data = {};
    if (req.body?.title !== undefined) data.title = String(req.body.title || found.title).slice(0, 180);
    if (req.body?.category !== undefined && DOCUMENT_CATEGORIES.has(String(req.body.category))) data.category = String(req.body.category);
    if (req.body?.content !== undefined) { const nextContent = String(req.body.content || '').slice(0, 180000) || null; data.content = nextContent; data.checksum = nextContent ? crypto.createHash('sha256').update(nextContent).digest('hex') : null; data.version = { increment: 1 }; data.verificationStatus = 'unverified'; }
    if (req.body?.metadata !== undefined) data.metadata = safeJson(req.body.metadata);
    if (req.body?.expiresAt !== undefined) data.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
    if (req.body?.reviewed === true) { data.lastReviewedAt = new Date(); data.verificationStatus = 'verified'; }
    res.json(userDocumentView(await prisma.userDocument.update({ where: { id: found.id }, data }), true));
  } catch (error) { next(error); }
});
app.post('/api/me/documents/:id/ai/extract-evidence', requireSession, async (req, res, next) => {
  try {
    const row = await prisma.userDocument.findFirst({ where: { id: req.params.id, userId: req.radarSession.userId } });
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } });
    if (!row.content) return res.status(422).json({ error: { code: 'DOCUMENT_EMPTY', message: 'The document has no extractable text.' } });
    const ai = await aiAssist('Extract reusable evidence from this document. Return JSON only with keys claims (array of {claim, evidence, confidence}), organisations, roles, dates, sectors, geographies, certifications, financialFacts, and warnings. Use only facts explicitly present. Do not infer missing achievements or eligibility.', { title: row.title, category: row.category, content: String(row.content).slice(0, 6000) }, `radar-evidence:${row.id}`, 'extract', 340, 'interactive');
    const parsed = parsePossibleJson(ai.text) || { raw: ai.text };
    const updated = await prisma.userDocument.update({ where: { id: row.id }, data: { extractedClaims: parsed, verificationStatus: 'machine_extracted', metadata: { ...safeJson(row.metadata), lastEvidenceInteractionId: ai.interactionId || null, lastEvidenceModel: ai.model || null } } });
    res.json(userDocumentView(updated, true));
  } catch (error) { next(error); }
});

app.delete('/api/me/documents/:id', requireSession, async (req, res, next) => {
  try { await prisma.userDocument.deleteMany({ where: { id: req.params.id, userId: req.radarSession.userId } }); res.status(204).end(); }
  catch (error) { next(error); }
});

app.get('/api/me/notifications', requireSession, async (req, res, next) => {
  try {
    const rows = await prisma.notification.findMany({ where: { userId: req.radarSession.userId }, orderBy: { createdAt: 'desc' }, take: 60 });
    res.json({ unread: rows.filter((r) => !r.readAt).length, items: rows });
  } catch (error) { next(error); }
});
app.patch('/api/me/notifications/:id/read', requireSession, async (req, res, next) => {
  try {
    const row = await prisma.notification.findFirst({ where: { id: req.params.id, userId: req.radarSession.userId } });
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Notification not found.' } });
    res.json(await prisma.notification.update({ where: { id: row.id }, data: { readAt: new Date() } }));
  } catch (error) { next(error); }
});
app.post('/api/me/notifications/read-all', requireSession, async (req, res, next) => {
  try { const result = await prisma.notification.updateMany({ where: { userId: req.radarSession.userId, readAt: null }, data: { readAt: new Date() } }); res.json({ updated: result.count }); }
  catch (error) { next(error); }
});

app.get('/api/me/analytics', requireSession, async (req, res, next) => {
  try {
    const userId = req.radarSession.userId;
    const [applications, workspaces, matches, saved, docs] = await Promise.all([
      prisma.application.findMany({ where: { userId }, select: { status: true, appliedAt: true, updatedAt: true } }),
      prisma.opportunityWorkspace.findMany({ where: { userId }, select: { status: true, progress: true, createdAt: true, updatedAt: true } }),
      prisma.match.findMany({ where: { userId }, select: { finalRank: true } }),
      prisma.savedOpportunity.count({ where: { userId } }), prisma.userDocument.count({ where: { userId } }),
    ]);
    const byStatus = applications.reduce((acc, x) => ({ ...acc, [x.status]: (acc[x.status] || 0) + 1 }), {});
    const submitted = applications.filter((x) => ['applied', 'interview', 'offer', 'rejected'].includes(x.status)).length;
    const outcomes = applications.filter((x) => ['interview', 'offer'].includes(x.status)).length;
    res.json({
      pipeline: { totalApplications: applications.length, byStatus, activeWorkspaces: workspaces.filter((w) => !['submitted', 'closed'].includes(w.status)).length, submittedWorkspaces: workspaces.filter((w) => w.status === 'submitted').length, saved, reusableDocuments: docs },
      quality: { averageFitScore: matches.length ? Math.round(matches.reduce((s, x) => s + x.finalRank, 0) / matches.length) : null, averageWorkspaceProgress: workspaces.length ? Math.round(workspaces.reduce((s, x) => s + x.progress, 0) / workspaces.length) : 0 },
      outcomes: { submitted, positiveProgression: outcomes, progressionRate: submitted ? Math.round((outcomes / submitted) * 100) : 0 },
    });
  } catch (error) { next(error); }
});
app.get('/api/me/subscription', requireSession, async (req, res, next) => {
  try {
    const [core, usage, payments, workspaceCount] = await Promise.all([
      coreSubscriptionCatalog(CORE_INTERNAL_URL),
      usageSnapshot(prisma, req.radarSession.userId),
      prisma.payment.findMany({ where: { userId: req.radarSession.userId }, orderBy: { paymentDate: 'desc' }, take: 10 }),
      prisma.opportunityWorkspace.count({ where: { userId: req.radarSession.userId, status: { notIn: ['closed'] } } }),
    ]);
    const resolved = resolvedPlan(req.radarSession, req.radarSession.user);
    const limits = resolved.plan.limits;
    res.json({
      state: resolved.tier === 'starter' ? 'free' : (resolved.access?.subscriptionStatus || 'active'),
      tier: resolved.tier,
      plan: resolved.plan,
      basis: resolved.basis,
      tukuAccess: resolved.access,
      providerConfigured: core.providerConfigured,
      checkoutAvailable: core.checkoutAvailable,
      enforcementEnabled: subscriptionEnforcementEnabled(),
      usage: {
        periodKey: usage.periodKey,
        searches: { used: usage.searches, limit: limits.searches },
        aiDrafts: { used: usage.aiDrafts, limit: limits.aiDrafts },
        workspaces: { used: workspaceCount, limit: limits.workspaces },
        collaboration: limits.collaboration,
      },
      payments: payments.map((p) => ({ id: p.id, amount: p.amount, currency: p.currency, status: p.status, type: p.type, paymentDate: p.paymentDate })),
    });
  } catch (error) { next(error); }
});

app.post('/api/ai/chat', rateLimit('ai-chat', 60, 60 * 60 * 1000), requireSession, async (req, res, next) => {
  try {
    const message = String(req.body?.message || '').trim().slice(0, 6000);
    if (!message) return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'A message is required.' } });
    const user = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
    let opportunity = null, workspace = null;
    if (req.body?.workspaceId) workspace = await accessibleWorkspace(user.id, String(req.body.workspaceId), { opportunity: true, documents: true, comments: true });
    else if (req.body?.opportunityId) opportunity = await prisma.opportunity.findUnique({ where: { id: String(req.body.opportunityId) } });
    const library = await libraryContext(user.id, 6);
    const ai = await aiAssist('Answer the user as Radar AI, a grounded opportunity preparation assistant. Focus on the supplied opportunity/workspace and profile. Distinguish facts from recommendations. Never invent credentials, partners, budgets, deadlines or submission status. Suggest the next useful action when relevant.', { message, profile: { skills: user.parsedSkills, industries: user.parsedIndustries, preferences: safePrefs(user) }, opportunity: opportunity ? opportunityView(opportunity) : workspace?.opportunity ? opportunityView(workspace.opportunity) : null, workspace: workspace ? { id: workspace.id, name: workspace.name, status: workspace.status, documents: workspace.documents.map((d) => ({ title: d.title, status: d.status, content: String(d.content || '').slice(0, 3000) })), unresolvedComments: workspace.comments.filter((c) => c.status !== 'resolved').map((c) => c.body) } : null, reusableDocuments: library.map((d) => ({ title: d.title, category: d.category })) }, `radar-chat:${user.id}:${workspace?.id || opportunity?.id || 'general'}`, 'explain', 900);
    res.json({ text: ai.text, model: ai.model, interactionId: ai.interactionId });
  } catch (error) { next(error); }
});

function hasOpsAccess(req) {
  const supplied = String(req.headers['x-radar-internal-key'] || '');
  const expected = String(process.env.RADAR_INTERNAL_KEY || '');
  if (expected && supplied && supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return true;
  const codes = req.radarSession?.corePermissionCodes || [];
  return ['radar.admin','platform.admin','admin'].some((code) => codes.includes(code));
}
app.get('/api/ops/summary', requireSession, async (req, res, next) => {
  try {
    if (!hasOpsAccess(req)) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Radar operations access required.' } });
    const now = new Date(), staleBefore = new Date(Date.now() - 72 * 3600000);
    const [users, opportunities, active, stale, expired, queuedJobs, failedJobs, workspaces, deliveriesFailed, sources, recentRuns] = await Promise.all([
      prisma.user.count(), prisma.opportunity.count(), prisma.opportunity.count({ where: { sourceStatus: 'live' } }),
      prisma.opportunity.count({ where: { OR: [{ sourceStatus: 'stale' }, { lastVerifiedAt: { lt: staleBefore }, deadline: null }] } }),
      prisma.opportunity.count({ where: { OR: [{ sourceStatus: 'expired' }, { deadline: { lt: now } }] } }),
      prisma.radarJob.count({ where: { status: 'queued' } }), prisma.radarJob.count({ where: { status: 'failed' } }),
      prisma.opportunityWorkspace.count({ where: { status: { not: 'closed' } } }), prisma.deliveryEvent.count({ where: { status: 'failed' } }),
      prisma.scraperSource.findMany({ orderBy: { lastRun: 'desc' }, take: 30 }), prisma.scrapeRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20, include: { source: { select: { name: true } } } }),
    ]);
    res.json({ generatedAt: now, totals: { users, opportunities, active, stale, expired, workspaces, queuedJobs, failedJobs, deliveriesFailed }, sources: sources.map((source) => ({ id: source.id, name: source.name, active: source.active, frequency: source.frequency, lastRun: source.lastRun, lastSuccess: source.lastSuccess, errorCount: source.errorCount, successCount: source.successCount, totalScraped: source.totalScraped })), recentRuns: recentRuns.map((run) => ({ id: run.id, source: run.source?.name, status: run.status, scraped: run.scraped, inserted: run.inserted, duplicates: run.duplicates, errors: run.errors, durationMs: run.durationMs, startedAt: run.startedAt, completedAt: run.completedAt })) });
  } catch (error) { next(error); }
});

app.get(['/app', '/app/'], (_req, res) => res.sendFile(path.join(publicDir, 'app-ui', 'index.html')));
app.get('/legacy-app', (_req, res) => res.sendFile(path.join(publicDir, 'legacy-app.html')));
app.use(express.static(publicDir, { extensions: ['html'], maxAge: '5m' }));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.use((error, _req, res, _next) => {
  console.error('[radar]', error);
  const status = Number(error?.status || 500);
  const code = status >= 500 ? 'INTERNAL_ERROR' : String(error?.code || 'REQUEST_FAILED');
  res.status(status).json({ error: { code, message: status >= 500 ? 'Radar could not complete the request.' : String(error.message || 'Request failed.'), ...(status < 500 && error?.details ? { details: error.details } : {}) } });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Radar listening on :${PORT}`));
