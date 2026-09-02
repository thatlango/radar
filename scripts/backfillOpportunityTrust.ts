import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function normalize(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function referenceNumber(row: { title: string; description: string; requirements: string | null }): string | null {
  const text = `${row.title || ''} ${row.description || ''} ${row.requirements || ''}`;
  const match = text.match(/(?:ref(?:erence)?|rfp|eoi|tender|procurement)\s*(?:no\.?|number|#|:|-)?\s*([A-Z0-9][A-Z0-9./_-]{3,})/i);
  const candidate = match?.[1]?.trim() || '';
  return candidate && /\d/.test(candidate) ? candidate : null;
}

function validReference(value: string | null): boolean {
  return Boolean(value && /\d/.test(value) && /^[A-Z0-9][A-Z0-9./_-]{3,}$/i.test(value));
}

function canonical(row: { title: string; organization: string; deadline: Date | null; description: string; requirements: string | null }): string {
  const ref = referenceNumber(row);
  const deadline = row.deadline ? new Date(row.deadline).toISOString().slice(0, 10) : '';
  const raw = [normalize(row.organization), normalize(row.title), deadline, normalize(ref)].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function main(): Promise<void> {
  const rows = await prisma.opportunity.findMany({ orderBy: { createdAt: 'asc' } });
  let backfilled = 0;
  let sourcesSeeded = 0;

  for (const row of rows) {
    let key = canonical(row);
    const collision = await prisma.opportunity.findFirst({ where: { canonicalKey: key, id: { not: row.id } }, select: { id: true } });
    if (collision) key = crypto.createHash('sha256').update(`${key}|${row.sourceUrl}`).digest('hex');
    const repairedReference = validReference(row.referenceNumber) ? row.referenceNumber : referenceNumber(row);
    const needsTrustUpdate = row.canonicalKey !== key || row.referenceNumber !== repairedReference;
    if (needsTrustUpdate) {
      await prisma.opportunity.update({
        where: { id: row.id },
        data: {
          canonicalKey: key,
          referenceNumber: repairedReference,
          lastVerifiedAt: row.lastVerifiedAt || row.updatedAt || row.createdAt,
          verificationStatus: row.verificationStatus || 'verified',
          sourceStatus: row.sourceStatus || 'live',
        },
      });
      backfilled += 1;
    }

    await prisma.opportunitySource.upsert({
      where: { sourceUrl: row.sourceUrl },
      create: {
        opportunityId: row.id,
        sourceName: row.source || 'Legacy source',
        sourceUrl: row.sourceUrl,
        sourceType: row.type,
        discoveredAt: row.discoveredAt || row.createdAt,
        lastVerifiedAt: row.lastVerifiedAt || row.updatedAt || row.createdAt,
        status: row.sourceStatus || 'live',
        rawMetadata: { migratedFromLegacyOpportunity: true },
      },
      update: {
        opportunityId: row.id,
        sourceName: row.source || 'Legacy source',
        sourceType: row.type,
        lastVerifiedAt: row.lastVerifiedAt || row.updatedAt || row.createdAt,
        status: row.sourceStatus || 'live',
      },
    });
    sourcesSeeded += 1;
  }

  const remaining = await prisma.opportunity.count({ where: { canonicalKey: null } });
  if (remaining) throw new Error(`Trust backfill incomplete: ${remaining} opportunities still lack canonical keys.`);
  console.log(`[Radar] trust backfill complete: ${backfilled} canonical keys, ${sourcesSeeded} source records.`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
