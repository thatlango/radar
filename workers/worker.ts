import { PrismaClient } from '@prisma/client';
import { AIMatchingEngine } from '../ai/matching';

const prisma = new PrismaClient();
const matching = new AIMatchingEngine();
const POLL_MS = Math.max(1000, Number(process.env.RADAR_JOB_POLL_MS || 3000));

async function claimJob(): Promise<any | null> {
  const now = new Date();
  const job = await prisma.radarJob.findFirst({
    where: { status: 'queued', runAt: { lte: now } },
    orderBy: [{ runAt: 'asc' }, { createdAt: 'asc' }],
  });
  if (!job) return null;
  return prisma.radarJob.update({
    where: { id: job.id },
    data: { status: 'running', lockedAt: now, attempts: { increment: 1 } },
  }).catch(() => null);
}

async function execute(job: any): Promise<void> {
  const payload: any = job.payload && typeof job.payload === 'object' ? job.payload : {};
  if (job.type === 'match_opportunity') {
    if (!payload.opportunityId) throw new Error('match_opportunity requires opportunityId');
    await matching.matchNewOpportunity(String(payload.opportunityId));
    return;
  }
  if (job.type === 'match_user') {
    if (!payload.userId) throw new Error('match_user requires userId');
    await matching.updateUserMatches(String(payload.userId));
    return;
  }
  throw new Error(`Unsupported Radar job type: ${job.type}`);
}

async function finish(job: any): Promise<void> {
  await prisma.radarJob.update({ where: { id: job.id }, data: { status: 'completed', completedAt: new Date(), lockedAt: null, lastError: null } });
}

async function fail(job: any, error: any): Promise<void> {
  const attempts = Number(job.attempts || 0);
  const maxAttempts = Number(job.maxAttempts || 5);
  const terminal = attempts >= maxAttempts;
  const delaySeconds = Math.min(900, Math.max(10, Math.pow(2, Math.max(0, attempts - 1)) * 15));
  await prisma.radarJob.update({
    where: { id: job.id },
    data: {
      status: terminal ? 'failed' : 'queued',
      runAt: terminal ? job.runAt : new Date(Date.now() + delaySeconds * 1000),
      lockedAt: null,
      lastError: String(error?.stack || error?.message || error).slice(0, 12000),
    },
  });
}

async function recoverStuckJobs(): Promise<void> {
  const stale = new Date(Date.now() - 30 * 60 * 1000);
  await prisma.radarJob.updateMany({
    where: { status: 'running', lockedAt: { lt: stale } },
    data: { status: 'queued', lockedAt: null, runAt: new Date() },
  });
}

async function loop(): Promise<void> {
  await recoverStuckJobs();
  console.log('[Radar Worker] durable job worker initialized');
  for (;;) {
    const job = await claimJob();
    if (!job) { await new Promise((resolve) => setTimeout(resolve, POLL_MS)); continue; }
    try {
      console.log(`[Radar Worker] ${job.type} ${job.id} attempt ${job.attempts}`);
      await execute(job);
      await finish(job);
    } catch (error) {
      console.error(`[Radar Worker] job ${job.id} failed`, error);
      await fail(job, error);
    }
  }
}

process.on('SIGTERM', async () => { await prisma.$disconnect(); process.exit(0); });
process.on('SIGINT', async () => { await prisma.$disconnect(); process.exit(0); });
loop().catch(async (error) => { console.error('[Radar Worker] fatal', error); await prisma.$disconnect(); process.exit(1); });
