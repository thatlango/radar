const STARTER = {
  code: 'starter',
  productCode: 'radar',
  name: 'Starter',
  description: 'Perfect for exploring the platform.',
  currency: 'USD',
  priceMinor: 0,
  interval: 'monthly',
  checkout: false,
  features: ['Up to 50 searches/month', 'Basic AI drafting (10/mo)', '1 Workspace'],
  limits: { searches: 50, aiDrafts: 10, workspaces: 1, collaboration: false },
};
const PRO_MONTHLY = {
  code: 'radar-pro-monthly',
  productCode: 'radar',
  name: 'Professional',
  description: 'For growing teams and serious professionals.',
  currency: 'USD',
  priceMinor: 4900,
  interval: 'monthly',
  checkout: true,
  features: ['Unlimited searches', 'Unlimited AI drafting', 'Up to 10 Workspaces', 'Team collaboration tools', 'Priority support'],
  limits: { searches: null, aiDrafts: null, workspaces: 10, collaboration: true },
};
const PRO_ANNUAL = {
  code: 'radar-pro-annual',
  productCode: 'radar',
  name: 'Professional Annual',
  description: 'Professional billed annually at the design-equivalent $39/month.',
  currency: 'USD',
  priceMinor: 46800,
  interval: 'annual',
  checkout: true,
  equivalentMonthlyMinor: 3900,
  features: PRO_MONTHLY.features,
  limits: PRO_MONTHLY.limits,
};
const ENTERPRISE = {
  code: 'enterprise',
  productCode: 'radar',
  name: 'Enterprise',
  description: 'Custom solutions for large organizations.',
  currency: 'USD',
  priceMinor: null,
  interval: 'custom',
  checkout: false,
  features: ['Custom workspace capacity', 'Team collaboration', 'Organisation administration', 'Priority support'],
  limits: { searches: null, aiDrafts: null, workspaces: null, collaboration: true },
};

export const RADAR_PLANS = [STARTER, PRO_MONTHLY, PRO_ANNUAL, ENTERPRISE];
export const subscriptionEnforcementEnabled = () => ['1','true','yes','on'].includes(String(process.env.RADAR_SUBSCRIPTION_ENFORCEMENT_ENABLED || 'false').toLowerCase());

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
