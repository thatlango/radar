import { PrismaClient } from '@prisma/client';
import { resolveApplicationDestination } from '../scrapers/applicationResolver';

const prisma = new PrismaClient();
const limit = Math.max(1, Math.min(1500, Number(process.argv[2] || 300)));
const sourceFilter = String(process.argv[3] || '').trim();
const concurrency = Math.max(1, Math.min(6, Number(process.env.RADAR_APPLICATION_BACKFILL_CONCURRENCY || 3)));

async function main() {
  const rows = await prisma.opportunity.findMany({
    where: {
      sourceStatus: 'live',
      applicationUrl: null,
      applicationEmail: null,
      ...(sourceFilter ? { source: { contains: sourceFilter, mode: 'insensitive' } } : {}),
      OR: [{ applicationVerifiedAt: null }, { applicationVerifiedAt: { lt: new Date(Date.now() - 7 * 86400000) } }],
    },
    orderBy: [{ qualityScore: 'desc' }, { deadline: 'asc' }, { createdAt: 'desc' }],
    take: limit,
  });
  const stats = { scanned: rows.length, url: 0, email: 0, instructions: 0, unresolved: 0, errors: 0 };
  for (let i = 0; i < rows.length; i += concurrency) {
    await Promise.all(rows.slice(i, i + concurrency).map(async (row) => {
      try {
        const result = await resolveApplicationDestination(row.sourceUrl, `${row.title} ${row.description || ''} ${row.requirements || ''}`);
        await prisma.opportunity.update({
          where: { id: row.id },
          data: {
            applicationUrl: result.applicationUrl || null,
            applicationEmail: result.applicationEmail || null,
            applicationInstructions: result.applicationInstructions || null,
            applicationVerifiedAt: new Date(),
          },
        });
        if (result.applicationUrl) stats.url++;
        else if (result.applicationEmail) stats.email++;
        else if (result.applicationInstructions) stats.instructions++;
        else stats.unresolved++;
      } catch (error) {
        stats.errors++;
        await prisma.opportunity.update({ where: { id: row.id }, data: { applicationVerifiedAt: new Date() } }).catch(() => undefined);
        console.warn('[application-backfill]', row.id, String((error as any)?.message || error));
      }
    }));
    console.log(`[application-backfill] ${Math.min(i + concurrency, rows.length)}/${rows.length}`);
  }
  console.log(JSON.stringify(stats));
}

main().finally(() => prisma.$disconnect());
