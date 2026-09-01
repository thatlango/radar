import { PrismaClient } from '@prisma/client';

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
    return true;
  }

  protected isValidUrl(url: string): boolean {
    try { new URL(url); return true; } catch { return false; }
  }

  protected async deduplicate(opportunity: RawOpportunity): Promise<boolean> {
    return (await prisma.opportunity.findUnique({ where: { sourceUrl: opportunity.sourceUrl } })) === null;
  }

  async run(): Promise<{ success: boolean; scraped: number; inserted: number; duplicates: number; errors: number }> {
    const startTime = Date.now();
    const results = { success: false, scraped: 0, inserted: 0, duplicates: 0, errors: 0 };
    try {
      const rawData = await this.fetchWithRetry();
      results.scraped = rawData.length;
      for (const item of rawData) {
        try {
          const normalized = this.normalize(item);
          if (!this.validate(normalized)) { results.errors++; continue; }
          if (!(await this.deduplicate(normalized))) { results.duplicates++; continue; }
          await this.insert(normalized);
          results.inserted++;
          await this.sleep(this.config.rateLimit!);
        } catch (error) {
          console.error(`[${this.constructor.name}] Error processing item:`, error);
          results.errors++;
        }
      }
      await this.updateSourceMetadata(results.inserted, results.errors === 0);
      results.success = true;
      console.log(`[${this.constructor.name}] completed in ${((Date.now() - startTime) / 1000).toFixed(2)}s`, results);
      return results;
    } catch (error) {
      console.error(`[${this.constructor.name}] Fatal error:`, error);
      await this.logError(error);
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

  protected async insert(opportunity: RawOpportunity): Promise<void> {
    await prisma.opportunity.create({
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
        source: opportunity.source || this.constructor.name.replace('Scraper', ''),
        sourceUrl: opportunity.sourceUrl,
      },
    });
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
