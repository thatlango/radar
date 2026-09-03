import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';

const prisma = new PrismaClient();

export interface ScraperConfig {
  sourceId: string;
  maxRetries?: number;
  timeout?: number;
  rateLimit?: number;
}

export interface RawOpportunity {
  title: string;
  organization: string;
  country: string;
  region?: string;
  type: 'job' | 'fellowship' | 'consultancy' | 'grant' | 'tender';
  remote: boolean;
  description: string;
  requirements?: string;
  salary?: string;
  deadline?: Date;
  sourceUrl: string;
  source?: string;
  applicationUrl?: string;
  applicationEmail?: string;
  applicationInstructions?: string;
}

export abstract class BaseScraper {
  protected config: ScraperConfig;
  protected retryCount = 0;

  constructor(config: ScraperConfig) {
    this.config = { maxRetries: 3, timeout: 30000, rateLimit: 1000, ...config };
  }

  abstract fetch(): Promise<any[]>;
  abstract normalize(data: any): RawOpportunity;

  protected validate(opportunity: RawOpportunity): boolean {
    if (!opportunity.title?.trim()) return false;
    if (!opportunity.organization?.trim()) return false;
    if (!opportunity.sourceUrl || !this.isValidUrl(opportunity.sourceUrl)) return false;
    if (!['job', 'fellowship', 'consultancy', 'grant', 'tender'].includes(opportunity.type)) return false;
    if (opportunity.deadline && new Date(opportunity.deadline).getTime() < Date.now() - 86400000) return false;
    return true;
  }

  protected isValidUrl(url: string): boolean {
    try { new URL(url); return true; } catch { return false; }
  }

  protected normalizeKeyPart(value: unknown): string {
    return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }

  protected canonicalKey(opportunity: RawOpportunity): string {
    const ref = this.extractReferenceNumber(opportunity);
    const deadline = opportunity.deadline ? new Date(opportunity.deadline).toISOString().slice(0, 10) : '';
    const raw = [this.normalizeKeyPart(opportunity.organization), this.normalizeKeyPart(opportunity.title), deadline, this.normalizeKeyPart(ref)].join('|');
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  protected extractReferenceNumber(opportunity: RawOpportunity): string | undefined {
    const text = `${opportunity.title || ''} ${opportunity.description || ''} ${opportunity.requirements || ''}`;
    const match = text.match(/(?:ref(?:erence)?|rfp|eoi|tender|procurement)\s*(?:no\.?|number|#|:|-)?\s*([A-Z0-9][A-Z0-9./_-]{3,})/i);
    const candidate = match?.[1]?.trim();
    return candidate && /\d/.test(candidate) ? candidate : undefined;
  }

  protected async persist(opportunity: RawOpportunity): Promise<boolean> {
    const canonicalKey = this.canonicalKey(opportunity);
    const sourceName = opportunity.source || this.constructor.name.replace('Scraper', '');
    const now = new Date();
    let row = await prisma.opportunity.findFirst({ where: { OR: [{ canonicalKey }, { sourceUrl: opportunity.sourceUrl }] } });
    let inserted = false;
    if (!row) {
      row = await prisma.opportunity.create({
        data: {
          title: opportunity.title,
          organization: opportunity.organization,
          country: opportunity.country,
          region: opportunity.region,
          type: opportunity.type,
          remote: opportunity.remote,
          description: opportunity.description,
          requirements: opportunity.requirements,
          salary: opportunity.salary,
          deadline: opportunity.deadline,
          source: sourceName,
          sourceUrl: opportunity.sourceUrl,
          applicationUrl: opportunity.applicationUrl,
          applicationEmail: opportunity.applicationEmail,
          applicationInstructions: opportunity.applicationInstructions,
          applicationVerifiedAt: opportunity.applicationUrl || opportunity.applicationEmail || opportunity.applicationInstructions ? now : undefined,
          canonicalKey,
          referenceNumber: this.extractReferenceNumber(opportunity),
          discoveredAt: now,
          lastVerifiedAt: now,
          sourceStatus: 'live',
          verificationStatus: 'verified',
        },
      });
      inserted = true;
    } else {
      const richerDescription = String(opportunity.description || '').length > String(row.description || '').length ? opportunity.description : row.description;
      const richerRequirements = String(opportunity.requirements || '').length > String(row.requirements || '').length ? opportunity.requirements : row.requirements;
      row = await prisma.opportunity.update({
        where: { id: row.id },
        data: {
          description: richerDescription,
          requirements: richerRequirements,
          type: opportunity.type || row.type,
          deadline: opportunity.deadline || row.deadline,
          remote: row.remote || opportunity.remote,
          applicationUrl: opportunity.applicationUrl || row.applicationUrl,
          applicationEmail: opportunity.applicationEmail || row.applicationEmail,
          applicationInstructions: opportunity.applicationInstructions || row.applicationInstructions,
          applicationVerifiedAt: opportunity.applicationUrl || opportunity.applicationEmail || opportunity.applicationInstructions ? now : row.applicationVerifiedAt,
          lastVerifiedAt: now,
          sourceStatus: 'live',
          verificationStatus: 'verified',
          closedAt: null,
        },
      });
    }
    await prisma.opportunitySource.upsert({
      where: { sourceUrl: opportunity.sourceUrl },
      create: { opportunityId: row.id, sourceName, sourceUrl: opportunity.sourceUrl, sourceType: opportunity.type, lastVerifiedAt: now, status: 'live' },
      update: { opportunityId: row.id, sourceName, sourceType: opportunity.type, lastVerifiedAt: now, status: 'live' },
    });
    if (!row.applicationUrl && !row.applicationEmail && (!row.applicationVerifiedAt || row.applicationVerifiedAt.getTime() < Date.now() - 7 * 86400000)) {
      await prisma.radarJob.upsert({
        where: { dedupeKey: `resolve-application:${row.id}` },
        create: { type: 'resolve_application', payload: { opportunityId: row.id }, dedupeKey: `resolve-application:${row.id}`, status: 'queued' },
        update: { status: 'queued', runAt: now, completedAt: null, lockedAt: null, lastError: null, attempts: 0 },
      }).catch(() => null);
    }
    return inserted;
  }

  async run(): Promise<{ success: boolean; scraped: number; inserted: number; duplicates: number; errors: number }> {
    const startTime = Date.now();
    const results = { success: false, scraped: 0, inserted: 0, duplicates: 0, errors: 0 };
    const run = this.config.sourceId === 'test' ? null : await prisma.scrapeRun.create({ data: { sourceId: this.config.sourceId, status: 'running' } }).catch(() => null);
    try {
      const rawData = await this.fetchWithRetry();
      results.scraped = rawData.length;
      for (const item of rawData) {
        try {
          const normalized = this.normalize(item);
          if (!this.validate(normalized)) { results.errors++; continue; }
          const inserted = await this.persist(normalized);
          if (inserted) results.inserted++;
          else results.duplicates++;
          await this.sleep(this.config.rateLimit!);
        } catch (error) {
          console.error(`[${this.constructor.name}] Error processing item:`, error);
          results.errors++;
        }
      }
      await this.updateSourceMetadata(results.inserted, results.errors === 0);
      results.success = true;
      if (run) await prisma.scrapeRun.update({ where: { id: run.id }, data: { status: results.errors ? 'partial' : 'success', scraped: results.scraped, inserted: results.inserted, duplicates: results.duplicates, errors: results.errors, durationMs: Date.now() - startTime, completedAt: new Date() } }).catch(() => undefined);
      console.log(`[${this.constructor.name}] completed in ${((Date.now() - startTime) / 1000).toFixed(2)}s`, results);
      return results;
    } catch (error) {
      console.error(`[${this.constructor.name}] Fatal error:`, error);
      await this.logError(error);
      if (run) await prisma.scrapeRun.update({ where: { id: run.id }, data: { status: 'failed', scraped: results.scraped, inserted: results.inserted, duplicates: results.duplicates, errors: Math.max(1, results.errors), durationMs: Date.now() - startTime, errorMessage: String((error as any)?.message || error).slice(0, 8000), completedAt: new Date() } }).catch(() => undefined);
      return results;
    }
  }

  protected async fetchWithRetry(): Promise<any[]> {
    try { return await this.fetch(); }
    catch (error) {
      if (this.retryCount < this.config.maxRetries!) {
        this.retryCount++;
        await this.sleep(2000 * this.retryCount);
        return this.fetchWithRetry();
      }
      throw error;
    }
  }


  protected async updateSourceMetadata(insertedCount: number, success: boolean): Promise<void> {
    // Test scrapers are not backed by a persistent source row.
    if (this.config.sourceId === 'test') return;
    await prisma.scraperSource.update({
      where: { id: this.config.sourceId },
      data: {
        lastRun: new Date(),
        lastSuccess: success ? new Date() : undefined,
        errorCount: success ? 0 : { increment: 1 },
        successCount: success ? { increment: 1 } : undefined,
        totalScraped: { increment: insertedCount },
      },
    });
  }

  protected async logError(error: any): Promise<void> {
    await prisma.systemLog.create({
      data: {
        level: 'error', source: 'scraper', message: `[${this.constructor.name}] ${error?.message || String(error)}`,
        metadata: { stack: error?.stack, sourceId: this.config.sourceId },
      },
    });
  }

  protected sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
  protected cleanText(html: string): string { return String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
  protected parseDate(dateString: string): Date | undefined {
    if (!dateString) return undefined;
    const date = new Date(dateString);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  protected isRemote(text: string): boolean {
    const lower = String(text || '').toLowerCase();
    return ['remote','work from home','wfh','anywhere','distributed','virtual','telecommute'].some((keyword) => lower.includes(keyword));
  }
}
