import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

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

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
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
  return Array.isArray(value) ? value.map(x => String(x).trim()).filter(Boolean).slice(0, max) : [];
}
function publicUser(user) {
  return {
    id: user.id, name: user.name, email: user.email, phone: user.phone,
    skills: user.parsedSkills, industries: user.parsedIndustries,
    onboardingComplete: user.onboardingComplete, preferences: user.preferences || {}, isPro: user.isPro,
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
function deterministicFit(user, opportunity) {
  const prefs = user.preferences && typeof user.preferences === 'object' ? user.preferences : {};
  const haystack = `${opportunity.title} ${opportunity.description} ${opportunity.requirements || ''} ${opportunity.aiKeywords.join(' ')}`.toLowerCase();
  const skills = user.parsedSkills || [];
  const skillHits = skills.filter(s => haystack.includes(String(s).toLowerCase())).length;
  let score = 45;
  if (skills.length) score += Math.min(30, Math.round((skillHits / skills.length) * 35));
  const wantedTypes = Array.isArray(prefs.types) ? prefs.types.map(String) : [];
  if (wantedTypes.includes(opportunity.type)) score += 10;
  if (prefs.remote === true && opportunity.remote) score += 8;
  const countries = Array.isArray(prefs.countries) ? prefs.countries.map(x => String(x).toLowerCase()) : [];
  if (countries.includes(String(opportunity.country).toLowerCase())) score += 7;
  const d = daysUntil(opportunity.deadline);
  if (d !== null && d >= 0 && d <= 14) score += 3;
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

app.get('/health', (_req, res) => res.json({ ok: true, service: 'radar', runtime: 'vps' }));
app.get('/ready', async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true, service: 'radar', database: 'ok', aiConfigured: Boolean(AI_KEY) }); }
  catch { res.status(503).json({ ok: false, service: 'radar', database: 'unavailable' }); }
});
app.get('/api/config', (_req, res) => res.json({ coreUrl: CORE_BROWSER_URL, clientId: CLIENT_ID, redirectUri: REDIRECT_URI }));

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
      : await prisma.user.create({ data: { ...data, name: String(core.identity.email).split('@')[0] } });
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
        ...(country ? [{ country: { equals: country, mode: 'insensitive' } }] : []),
        ...(remote === 'true' ? [{ remote: true }] : []),
      ],
    };
    const session = await sessionFor(req);
    const rows = await prisma.opportunity.findMany({ where, orderBy: [{ qualityScore: 'desc' }, { deadline: 'asc' }, { createdAt: 'desc' }], take });
    const saved = session ? new Set((await prisma.savedOpportunity.findMany({ where: { userId: session.userId }, select: { opportunityId: true } })).map(x => x.opportunityId)) : new Set();
    const matches = session ? new Map((await prisma.match.findMany({ where: { userId: session.userId, opportunityId: { in: rows.map(x => x.id) } } })).map(x => [x.opportunityId, x])) : new Map();
    res.json({ items: rows.map(row => opportunityView(row, { saved: saved.has(row.id), fitScore: matches.get(row.id)?.finalRank ?? (session ? deterministicFit(session.user, row) : null) })) });
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
    const preferences = input.preferences && typeof input.preferences === 'object' ? input.preferences : {};
    const user = await prisma.user.update({ where: { id: req.radarSession.userId }, data: {
      name: input.name ? String(input.name).trim().slice(0, 120) : req.radarSession.user.name,
      parsedSkills: cleanList(input.skills, 40), parsedIndustries: cleanList(input.industries, 25),
      preferences, onboardingComplete: true,
    }});
    res.json(publicUser(user));
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
  res.json({ items: rows.map(x => opportunityView(x.opportunity, { saved: true, fitScore: deterministicFit(req.radarSession.user, x.opportunity) })) });
});
app.get('/api/me/applications', requireSession, async (req, res) => {
  const rows = await prisma.application.findMany({ where: { userId: req.radarSession.userId }, include: { opportunity: true }, orderBy: { updatedAt: 'desc' } });
  res.json({ items: rows.map(x => ({ id: x.id, status: x.status, notes: x.notes, appliedAt: x.appliedAt, opportunity: opportunityView(x.opportunity) })) });
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
    const ai = await aiAssist(
      'Explain this opportunity fit in 3 concise sections: Why it fits, Gaps to address, and Best next action. Use only supplied facts. Do not invent eligibility or experience.',
      { profile: { skills: user.parsedSkills, industries: user.parsedIndustries, preferences: user.preferences || {} }, opportunity: opportunityView(opportunity), deterministicFitScore: score },
      `radar-opportunity:${opportunity.id}`, 'analyze');
    const match = await prisma.match.upsert({ where: { userId_opportunityId: { userId: user.id, opportunityId: opportunity.id } }, update: { gptMatchScore: score, explanation: ai.text, finalRank: score, freshnessScore: Math.max(0, 100 - Math.max(0, daysUntil(opportunity.deadline) ?? 30)) }, create: { userId: user.id, opportunityId: opportunity.id, gptMatchScore: score, explanation: ai.text, finalRank: score, freshnessScore: Math.max(0, 100 - Math.max(0, daysUntil(opportunity.deadline) ?? 30)) } });
    res.json({ fitScore: score, explanation: match.explanation, interactionId: ai.interactionId, model: ai.model });
  } catch (error) { next(error); }
});
app.post('/api/opportunities/:id/brief', requireSession, async (req, res, next) => {
  try {
    const opportunity = await prisma.opportunity.findUnique({ where: { id: req.params.id } });
    if (!opportunity) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Opportunity not found.' } });
    const ai = await aiAssist('Summarize the opportunity into: What it is, Who it appears for, Deadline/constraints explicitly present, and a 5-item application preparation checklist. Do not infer eligibility not stated in the source.', { opportunity: opportunityView(opportunity) }, `radar-brief:${opportunity.id}`, 'summarize', 420);
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
