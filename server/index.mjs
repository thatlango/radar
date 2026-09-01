import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import pdfParse from 'pdf-parse';

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

const SCAN_PRESETS = [
  {
    id: 'consulting-firm',
    name: 'Consulting & implementation opportunities',
    description: 'Firm, framework, roster and consortium opportunities across programme design, implementation, research, capacity building, private sector development, digital systems and MEL.',
  },
  {
    id: 'strong-fit-role',
    name: 'Strong-fit roles & individual consultancies',
    description: 'Paid roles and individual consultancies matched to your skills, experience, geography and hard eligibility requirements.',
  },
  {
    id: 'innovation-entrepreneurship',
    name: 'Innovation & entrepreneurship',
    description: 'Innovation ecosystems, incubators, accelerators, venture support, entrepreneurship programmes and MSME growth work.',
  },
];

app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
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
function publicUser(user) {
  const preferences = safePrefs(user);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    skills: user.parsedSkills,
    industries: user.parsedIndustries,
    onboardingComplete: user.onboardingComplete,
    preferences,
    isPro: user.isPro,
    resume: { uploaded: Boolean(user.resumeText), fileName: user.resumeUrl || null },
  };
}
function opportunityView(row, extra = {}) {
  return {
    id: row.id, title: row.title, organization: row.organization, country: row.country, region: row.region,
    type: row.type, remote: row.remote, description: row.description, requirements: row.requirements,
    compensation: row.salary, deadline: row.deadline, source: row.source, sourceUrl: row.sourceUrl,
    summary: row.aiSummary, keywords: row.aiKeywords, qualityScore: row.qualityScore, createdAt: row.createdAt,
    ...extra,
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
  if (countries.some((x) => country.includes(x) || x.includes(country))) score += 8;
  else if (regions.some((x) => country.includes(x))) score += 5;
  const d = daysUntil(opportunity.deadline);
  const minDays = Math.max(0, Math.min(60, Number(prefs.minDaysToDeadline ?? 7)));
  if (d !== null && d < 0) return 0;
  if (d !== null && d < minDays) score -= 12;
  if (d !== null && d >= minDays && d <= 30) score += 4;
  if ((prefs.profileType === 'firm' || prefs.profileType === 'both') && prefs.canRecruitSpecialists === true && ['consultancy','tender','grant'].includes(opportunity.type)) score += 4;
  return Math.max(0, Math.min(100, score));
}
async function aiAssist(instruction, context, subjectRef, capability = 'analyze', maxOutputTokens = 320) {
  if (!AI_KEY) throw Object.assign(new Error('Radar AI integration is not configured.'), { status: 503 });
  const response = await fetch(`${CORE_INTERNAL_URL}/api/v1/integrations/ai/assist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tuku-product-code': 'radar', 'x-tuku-integration-key': AI_KEY },
    body: JSON.stringify({ capability, instruction, context, subjectRef, maxOutputTokens }),
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
async function briefingPreview(user) {
  const prefs = safePrefs(user);
  const minDays = Math.max(0, Math.min(60, Number(prefs.minDaysToDeadline ?? 7)));
  const minFit = Math.max(0, Math.min(100, Number(prefs.minFitScore ?? 60)));
  const now = new Date();
  const rows = await prisma.opportunity.findMany({
    where: {
      createdAt: { gte: new Date(Date.now() - 7 * 86400000) },
      OR: [{ deadline: null }, { deadline: { gte: new Date(Date.now() + minDays * 86400000) } }],
    },
    orderBy: [{ createdAt: 'desc' }, { qualityScore: 'desc' }],
    take: 100,
  });
  return rows
    .map((row) => ({ row, score: deterministicFit(user, row) }))
    .filter((item) => item.score >= minFit && (!item.row.deadline || new Date(item.row.deadline) >= now))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((item) => opportunityView(item.row, { fitScore: item.score }));
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'radar', runtime: 'vps' }));
app.get('/ready', async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true, service: 'radar', database: 'ok', aiConfigured: Boolean(AI_KEY) }); }
  catch { res.status(503).json({ ok: false, service: 'radar', database: 'unavailable' }); }
});
app.get('/api/config', (_req, res) => res.json({ coreUrl: CORE_BROWSER_URL, clientId: CLIENT_ID, redirectUri: REDIRECT_URI }));
app.get('/api/scan-profiles', (_req, res) => res.json({ items: SCAN_PRESETS }));

app.post('/api/auth/tuku/exchange', async (req, res, next) => {
  try {
    const { code, codeVerifier } = req.body || {};
    if (!code || !codeVerifier) return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Authorization code and verifier are required.' } });
    const response = await fetch(`${CORE_INTERNAL_URL}/api/v1/sso/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, code, redirectUri: REDIRECT_URI, codeVerifier }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({}));
    const core = payload?.data ?? payload;
    if (!response.ok) return res.status(response.status).json(payload);
    if (!core?.authenticated || core?.authorization?.productCode !== 'radar' || !core?.identity?.coreUserId || !core?.identity?.email) {
      return res.status(403).json({ error: { code: 'PRODUCT_ACCESS_DENIED', message: 'Tuku Core returned an invalid Radar identity.' } });
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
      : await prisma.user.create({ data: { ...data, name: String(core.identity.email).split('@')[0], parsedSkills: [], parsedIndustries: [] } });
    const id = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600000);
    await prisma.radarSession.create({ data: { id, userId: user.id, coreOrganizationId: core.authorization.organizationId || null, coreBusinessId: core.authorization.businessId || null, expiresAt } });
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
  res.json({ authenticated: true, user: publicUser(s.user), organizationId: s.coreOrganizationId, businessId: s.coreBusinessId });
});

app.get('/api/opportunities', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || '').trim();
    const country = String(req.query.country || '').trim();
    const remote = String(req.query.remote || '').trim();
    const take = Math.max(1, Math.min(100, Number(req.query.limit || 40)));
    const now = new Date();
    const where = {
      AND: [
        { OR: [{ deadline: null }, { deadline: { gte: now } }] },
        ...(q ? [{ OR: [{ title: { contains: q, mode: 'insensitive' } }, { organization: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] }] : []),
        ...(type ? [{ type }] : []),
        ...(country ? [{ country: { contains: country, mode: 'insensitive' } }] : []),
        ...(remote === 'true' ? [{ remote: true }] : []),
      ],
    };
    const session = await sessionFor(req);
    const rows = await prisma.opportunity.findMany({ where, orderBy: [{ qualityScore: 'desc' }, { deadline: 'asc' }, { createdAt: 'desc' }], take: Math.min(100, take * 2) });
    const saved = session ? new Set((await prisma.savedOpportunity.findMany({ where: { userId: session.userId }, select: { opportunityId: true } })).map((x) => x.opportunityId)) : new Set();
    const matches = session ? new Map((await prisma.match.findMany({ where: { userId: session.userId, opportunityId: { in: rows.map((x) => x.id) } } })).map((x) => [x.opportunityId, x])) : new Map();
    const mapped = rows.map((row) => opportunityView(row, { saved: saved.has(row.id), fitScore: matches.get(row.id)?.finalRank ?? (session ? deterministicFit(session.user, row) : null) }));
    if (session) mapped.sort((a, b) => Number(b.fitScore || 0) - Number(a.fitScore || 0) || Number(b.qualityScore || 0) - Number(a.qualityScore || 0));
    res.json({ items: mapped.slice(0, take) });
  } catch (error) { next(error); }
});
app.get('/api/opportunities/:id', async (req, res) => {
  const row = await prisma.opportunity.findUnique({ where: { id: req.params.id } });
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } });
  const s = await sessionFor(req);
  const saved = s ? Boolean(await prisma.savedOpportunity.findUnique({ where: { userId_opportunityId: { userId: s.userId, opportunityId: row.id } } })) : false;
  res.json(opportunityView(row, { saved, fitScore: s ? deterministicFit(s.user, row) : null }));
});
app.get('/api/stats', async (_req, res) => {
  const now = new Date();
  const [live, remote, closingSoon, sources] = await Promise.all([
    prisma.opportunity.count({ where: { OR: [{ deadline: null }, { deadline: { gte: now } }] } }),
    prisma.opportunity.count({ where: { remote: true, OR: [{ deadline: null }, { deadline: { gte: now } }] } }),
    prisma.opportunity.count({ where: { deadline: { gte: now, lte: new Date(Date.now() + 14 * 86400000) } } }),
    prisma.scraperSource.count({ where: { active: true } }),
  ]);
  res.json({ live, remote, closingSoon, activeSources: sources });
});

app.get('/api/me/profile', requireSession, (req, res) => res.json(publicUser(req.radarSession.user)));
app.put('/api/me/profile', requireSession, async (req, res, next) => {
  try {
    const input = req.body || {};
    const existingPrefs = safePrefs(req.radarSession.user);
    const incomingPrefs = input.preferences && typeof input.preferences === 'object' ? input.preferences : {};
    const preferences = { ...existingPrefs, ...incomingPrefs };
    const user = await prisma.user.update({ where: { id: req.radarSession.userId }, data: {
      name: input.name ? String(input.name).trim().slice(0, 120) : req.radarSession.user.name,
      phone: input.phone !== undefined ? String(input.phone || '').trim().slice(0, 40) || null : req.radarSession.user.phone,
      parsedSkills: input.skills ? cleanList(input.skills, 60) : req.radarSession.user.parsedSkills,
      parsedIndustries: input.industries ? cleanList(input.industries, 30) : req.radarSession.user.parsedIndustries,
      preferences,
      onboardingComplete: true,
    }});
    if (preferences.dailyBriefEnabled !== undefined) await upsertDailyAlert(user.id, preferences);
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
    if (mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
      const parsed = await pdfParse(buffer);
      text = String(parsed.text || '');
    } else if (mimeType.startsWith('text/') || fileName.toLowerCase().endsWith('.txt')) {
      text = buffer.toString('utf8');
    } else {
      return res.status(415).json({ error: { code: 'UNSUPPORTED_FILE', message: 'Radar currently accepts PDF or plain-text CV/profile files.' } });
    }
    text = text.replace(/\u0000/g, '').trim().slice(0, 120000);
    if (text.length < 80) return res.status(422).json({ error: { code: 'CV_TEXT_UNREADABLE', message: 'Radar could not extract enough text from this file. Try a text-based PDF or paste your skills manually.' } });

    let extracted = null;
    if (AI_KEY) {
      try {
        const ai = await aiAssist(
          'Extract an opportunity-matching profile from this CV. Return JSON only with keys skills (array max 25), industries (array max 12), summary (string max 500 chars). Do not invent experience.',
          { resumeText: text.slice(0, 24000) },
          `radar-resume:${req.radarSession.userId}`, 'extract', 700,
        );
        extracted = parsePossibleJson(ai.text);
      } catch (error) { console.warn('[radar] resume profile extraction failed', error); }
    }

    const current = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
    const skills = cleanList(extracted?.skills, 60);
    const industries = cleanList(extracted?.industries, 30);
    const user = await prisma.user.update({ where: { id: req.radarSession.userId }, data: {
      resumeText: text,
      resumeUrl: fileName,
      parsedSkills: skills.length ? skills : current?.parsedSkills || [],
      parsedIndustries: industries.length ? industries : current?.parsedIndustries || [],
      onboardingComplete: true,
    }});
    res.json({ user: publicUser(user), extracted: extracted || null, characters: text.length });
  } catch (error) { next(error); }
});
app.delete('/api/me/resume', requireSession, async (req, res, next) => {
  try {
    const user = await prisma.user.update({ where: { id: req.radarSession.userId }, data: { resumeText: null, resumeUrl: null } });
    res.json(publicUser(user));
  } catch (error) { next(error); }
});

app.get('/api/me/briefing', requireSession, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
  const alert = await prisma.alert.findFirst({ where: { userId: req.radarSession.userId, frequency: 'daily' } });
  res.json({ preferences: safePrefs(user), alert: alert ? { id: alert.id, active: alert.active, lastSent: alert.lastSent, sendCount: alert.sendCount } : null });
});
app.put('/api/me/briefing', requireSession, async (req, res, next) => {
  try {
    const current = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
    const oldPrefs = safePrefs(current);
    const input = req.body || {};
    const deliveryHour = [8, 9].includes(Number(input.deliveryHour)) ? Number(input.deliveryHour) : 8;
    const preferences = {
      ...oldPrefs,
      dailyBriefEnabled: input.enabled !== false,
      deliveryHour,
      timezone: String(input.timezone || oldPrefs.timezone || 'Africa/Kampala').slice(0, 80),
      emailBrief: input.email !== false,
      whatsappBrief: input.whatsapp === true,
      minFitScore: Math.max(0, Math.min(100, Number(input.minFitScore ?? oldPrefs.minFitScore ?? 60))),
      minDaysToDeadline: Math.max(0, Math.min(60, Number(input.minDaysToDeadline ?? oldPrefs.minDaysToDeadline ?? 7))),
    };
    const user = await prisma.user.update({ where: { id: req.radarSession.userId }, data: {
      phone: input.phone !== undefined ? String(input.phone || '').trim().slice(0, 40) || null : current?.phone,
      preferences,
    }});
    const alert = await upsertDailyAlert(user.id, preferences);
    res.json({ preferences, alert: { id: alert.id, active: alert.active, lastSent: alert.lastSent, sendCount: alert.sendCount } });
  } catch (error) { next(error); }
});
app.get('/api/me/briefing/preview', requireSession, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.radarSession.userId } });
    res.json({ items: await briefingPreview(user) });
  } catch (error) { next(error); }
});

app.post('/api/opportunities/:id/save', requireSession, async (req, res) => {
  await prisma.savedOpportunity.upsert({ where: { userId_opportunityId: { userId: req.radarSession.userId, opportunityId: req.params.id } }, update: {}, create: { userId: req.radarSession.userId, opportunityId: req.params.id } });
  res.json({ saved: true });
});
app.delete('/api/opportunities/:id/save', requireSession, async (req, res) => {
  await prisma.savedOpportunity.deleteMany({ where: { userId: req.radarSession.userId, opportunityId: req.params.id } });
  res.json({ saved: false });
});
app.get('/api/me/saved', requireSession, async (req, res) => {
  const rows = await prisma.savedOpportunity.findMany({ where: { userId: req.radarSession.userId }, include: { opportunity: true }, orderBy: { savedAt: 'desc' } });
  res.json({ items: rows.map((x) => opportunityView(x.opportunity, { saved: true, fitScore: deterministicFit(req.radarSession.user, x.opportunity) })) });
});
app.get('/api/me/applications', requireSession, async (req, res) => {
  const rows = await prisma.application.findMany({ where: { userId: req.radarSession.userId }, include: { opportunity: true }, orderBy: { updatedAt: 'desc' } });
  res.json({ items: rows.map((x) => ({ id: x.id, status: x.status, notes: x.notes, appliedAt: x.appliedAt, opportunity: opportunityView(x.opportunity) })) });
});
app.post('/api/opportunities/:id/applications', requireSession, async (req, res) => {
  const status = ['planning','applied','interview','offer','rejected','withdrawn'].includes(String(req.body?.status)) ? String(req.body.status) : 'planning';
  const row = await prisma.application.upsert({ where: { userId_opportunityId: { userId: req.radarSession.userId, opportunityId: req.params.id } }, update: { status, notes: String(req.body?.notes || '').slice(0, 8000) }, create: { userId: req.radarSession.userId, opportunityId: req.params.id, status, notes: String(req.body?.notes || '').slice(0, 8000) } });
  res.json(row);
});
app.post('/api/opportunities/:id/fit', requireSession, async (req, res, next) => {
  try {
    const opportunity = await prisma.opportunity.findUnique({ where: { id: req.params.id } });
    if (!opportunity) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } });
    const user = req.radarSession.user;
    const score = deterministicFit(user, opportunity);
    const preferences = safePrefs(user);
    const ai = await aiAssist(
      'Explain this fit in 4 concise sections: Why it fits, Hard constraints, Specialists/partners to add if relevant, and Best next action. If this is a firm profile that can recruit specialists, do not reject only because a sector expert is not currently in-house. Do not invent eligibility, experience, references or partnerships.',
      { profile: { skills: user.parsedSkills, industries: user.parsedIndustries, preferences, hasResume: Boolean(user.resumeText) }, opportunity: opportunityView(opportunity), deterministicFitScore: score },
      `radar-opportunity:${opportunity.id}`, 'analyze', 520,
    );
    const match = await prisma.match.upsert({ where: { userId_opportunityId: { userId: user.id, opportunityId: opportunity.id } }, update: { gptMatchScore: score, explanation: ai.text, finalRank: score, freshnessScore: Math.max(0, 100 - Math.max(0, daysUntil(opportunity.deadline) ?? 30)) }, create: { userId: user.id, opportunityId: opportunity.id, gptMatchScore: score, explanation: ai.text, finalRank: score, freshnessScore: Math.max(0, 100 - Math.max(0, daysUntil(opportunity.deadline) ?? 30)) } });
    res.json({ fitScore: score, explanation: match.explanation, interactionId: ai.interactionId, model: ai.model });
  } catch (error) { next(error); }
});
app.post('/api/opportunities/:id/brief', requireSession, async (req, res, next) => {
  try {
    const opportunity = await prisma.opportunity.findUnique({ where: { id: req.params.id } });
    if (!opportunity) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } });
    const user = req.radarSession.user;
    const ai = await aiAssist(
      'Prepare a concise opportunity briefing with: What it is, why it may fit this profile, deadline and hard constraints explicitly present, bid/apply recommendation, and a 5-item next-step checklist. Use only supplied facts. If specialists could close domain gaps, say which profiles are needed without implying they are already hired.',
      { profile: { skills: user.parsedSkills, industries: user.parsedIndustries, preferences: safePrefs(user) }, opportunity: opportunityView(opportunity) },
      `radar-brief:${opportunity.id}`, 'summarize', 620,
    );
    await prisma.opportunity.update({ where: { id: opportunity.id }, data: { aiSummary: ai.text } });
    res.json({ text: ai.text, interactionId: ai.interactionId, model: ai.model });
  } catch (error) { next(error); }
});

app.use(express.static(publicDir, { extensions: ['html'], maxAge: '5m' }));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.use((error, _req, res, _next) => {
  console.error('[radar]', error);
  const status = Number(error?.status || 500);
  res.status(status).json({ error: { code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED', message: status >= 500 ? 'Radar could not complete the request.' : String(error.message || 'Request failed.') } });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Radar listening on :${PORT}`));
