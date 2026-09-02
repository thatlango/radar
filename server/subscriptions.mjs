const TRIAL_DAYS = 30;
const DEFAULT_TRIAL_ROLLOUT_AT = '2026-09-02T04:15:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

const STARTER = {
  code: 'starter',
  productCode: 'radar',
  name: 'Starter',
  description: 'Keep discovering and tracking opportunities after your trial.',
  currency: 'USD',
  priceMinor: 0,
  interval: 'monthly',
  checkout: false,
  features: [
    'Unlimited opportunity discovery',
    'Save and track applications',
    '1 active Workspace',
    '3 AI document drafts/month',
    'Weekly Radar brief',
  ],
  limits: { searches: null, aiDrafts: 3, workspaces: 1, collaboration: false },
};
const PRO_MONTHLY = {
  code: 'radar-pro-monthly',
  productCode: 'radar',
  name: 'Professional',
  description: 'For people actively turning opportunities into applications.',
  currency: 'USD',
  priceMinor: 1900,
  interval: 'monthly',
  checkout: true,
  features: [
    'Unlimited opportunity discovery',
    '60 AI document drafts/month',
    'Up to 10 active Workspaces',
    'Team collaboration tools',
    'Advanced application preparation',
    'Priority support',
  ],
  limits: { searches: null, aiDrafts: 60, workspaces: 10, collaboration: true },
};
const PRO_ANNUAL = {
  code: 'radar-pro-annual',
  productCode: 'radar',
  name: 'Professional Annual',
  description: 'Professional billed annually at $15/month equivalent.',
  currency: 'USD',
  priceMinor: 18000,
  interval: 'annual',
  checkout: true,
  equivalentMonthlyMinor: 1500,
  features: PRO_MONTHLY.features,
  limits: PRO_MONTHLY.limits,
};
const ENTERPRISE = {
  code: 'enterprise',
  productCode: 'radar',
  name: 'Enterprise',
  description: 'Custom capacity, governance and source integrations for organisations.',
  currency: 'USD',
  priceMinor: null,
  interval: 'custom',
  checkout: false,
  features: [
    'Custom workspace capacity',
    'Organisation-wide collaboration',
    'Administration and access controls',
    'Custom opportunity/source integrations',
    'Priority support',
  ],
  limits: { searches: null, aiDrafts: null, workspaces: null, collaboration: true },
};

export const RADAR_PLANS = [STARTER, PRO_MONTHLY, PRO_ANNUAL, ENTERPRISE];
export const subscriptionEnforcementEnabled = () => ['1','true','yes','on'].includes(String(process.env.RADAR_SUBSCRIPTION_ENFORCEMENT_ENABLED || 'false').toLowerCase());

function trialRolloutAt() {
  const parsed = new Date(process.env.RADAR_TRIAL_ROLLOUT_AT || DEFAULT_TRIAL_ROLLOUT_AT);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date(DEFAULT_TRIAL_ROLLOUT_AT);
}

function activeRadarTrial(user, now = new Date()) {
  if (!user?.createdAt) return null;
  const startsAt = new Date(user.createdAt);
  if (!Number.isFinite(startsAt.getTime()) || startsAt < trialRolloutAt()) return null;
  const endsAt = new Date(startsAt.getTime() + TRIAL_DAYS * DAY_MS);
  if (endsAt.getTime() <= now.getTime()) return null;
  return {
    productCode: 'radar',
    planCode: PRO_MONTHLY.code,
    entitlementStatus: 'active',
    subscriptionStatus: 'trial',
    sourceType: 'radar_30_day_trial',
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    trialDays: TRIAL_DAYS,
  };
}

export async function coreSubscriptionCatalog(coreInternalUrl) {
  try {
    const response = await fetch(`${coreInternalUrl}/api/v1/subscriptions/plans`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Core subscriptions returned ${response.status}`);
    const data = body?.data ?? body;
    return {
      providerConfigured: data?.providerConfigured === true,
      checkoutAvailable: data?.checkoutAvailable === true,
      enforcementEnabled: data?.enforcementEnabled === true,
      corePlans: Array.isArray(data?.plans) ? data.plans.filter((p) => p?.productCode === 'radar') : [],
    };
  } catch {
    return { providerConfigured: false, checkoutAvailable: false, enforcementEnabled: false, corePlans: [] };
  }
}

function activeCoreAccess(session) {
  const access = session?.coreAccess && typeof session.coreAccess === 'object' && !Array.isArray(session.coreAccess) ? session.coreAccess : null;
  if (!access || access.productCode !== 'radar' || access.entitlementStatus !== 'active') return null;
  if (access.endsAt && new Date(access.endsAt).getTime() <= Date.now()) return null;
  return access;
}

export function resolvedPlan(session, user) {
  const access = activeCoreAccess(session);
  if (access) {
    const planCode = String(access.planCode || '').toLowerCase();
    if (planCode.includes('enterprise')) return { tier: 'enterprise', plan: ENTERPRISE, basis: 'tuku_entitlement', access };
    return { tier: 'professional', plan: planCode.includes('annual') ? PRO_ANNUAL : PRO_MONTHLY, basis: 'tuku_entitlement', access };
  }
  if (user?.isPro) return { tier: 'professional', plan: PRO_MONTHLY, basis: 'legacy_radar_pro', access: null };
  const trial = activeRadarTrial(user);
  if (trial) return { tier: 'professional', plan: PRO_MONTHLY, basis: 'radar_trial', access: trial };
  return { tier: 'starter', plan: STARTER, basis: 'starter', access: null };
}

export function currentPeriodKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
}

export async function usageSnapshot(prisma, userId) {
  const periodKey = currentPeriodKey();
  const rows = await prisma.subscriptionUsage.findMany({ where: { userId, periodKey } });
  const byMetric = Object.fromEntries(rows.map((row) => [row.metric, row.count]));
  return { periodKey, searches: Number(byMetric.searches || 0), aiDrafts: Number(byMetric.ai_drafts || 0) };
}

export async function recordUsage(prisma, userId, metric, amount = 1) {
  const periodKey = currentPeriodKey();
  return prisma.subscriptionUsage.upsert({
    where: { userId_metric_periodKey: { userId, metric, periodKey } },
    create: { userId, metric, periodKey, count: amount },
    update: { count: { increment: amount } },
  });
}

export async function enforceLimit({ prisma, session, metric, currentCount, requested = 1, resourceCount = null }) {
  if (!subscriptionEnforcementEnabled()) return;
  const resolved = resolvedPlan(session, session.user);
  const limits = resolved.plan.limits;
  let limit = null;
  let used = currentCount;
  if (metric === 'searches') limit = limits.searches;
  if (metric === 'ai_drafts') limit = limits.aiDrafts;
  if (metric === 'workspaces') { limit = limits.workspaces; used = resourceCount ?? 0; }
  if (metric === 'collaboration' && !limits.collaboration) {
    throw Object.assign(new Error('Team collaboration is available on Radar Professional and Enterprise.'), { status: 402, code: 'SUBSCRIPTION_REQUIRED' });
  }
  if (limit !== null && Number(used || 0) + requested > limit) {
    throw Object.assign(new Error(`Your ${resolved.plan.name} plan limit has been reached for ${metric.replace('_',' ')}.`), { status: 402, code: 'PLAN_LIMIT_REACHED', details: { metric, limit, used, plan: resolved.plan.code } });
  }
}
