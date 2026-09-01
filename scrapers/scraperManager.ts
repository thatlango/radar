import { PrismaClient } from '@prisma/client';
import { BaseScraper } from './BaseScraper';
import { LinkedInScraper } from './LinkedInScraper';
import { AfDBScraper } from './AfDBScraper';
import { WebDiscoveryScraper } from './WebDiscoveryScraper';
import { AIMatchingEngine } from '../ai/matching';

const prisma = new PrismaClient();
const matchingEngine = new AIMatchingEngine();

export class ScraperManager {
  private scrapers: Map<string, typeof BaseScraper> = new Map();

  constructor() {
    this.scrapers.set('linkedin', LinkedInScraper);
    this.scrapers.set('afdb', AfDBScraper);
    this.scrapers.set('webdiscovery', WebDiscoveryScraper);
  }

  async ensureDefaultSources(): Promise<void> {
    const defaults = [
      {
        name: 'Cross-source Web Discovery',
        baseUrl: 'https://radar.tukutuku.org/discovery',
        type: 'tender',
        frequency: 'daily',
        config: { scanProfile: 'consulting-firm', coverage: 'linkedin+opportunitydesk+globalsouth+development-sector' },
      },
      {
        name: 'LinkedIn',
        baseUrl: 'https://www.linkedin.com',
        type: 'job',
        frequency: 'daily',
        config: { scanProfile: 'strong-fit-role' },
      },
      {
        name: 'AfDB',
        baseUrl: 'https://www.afdb.org',
        type: 'tender',
        frequency: 'daily',
        config: {},
      },
    ];

    for (const source of defaults) {
      const existing = await prisma.scraperSource.findFirst({ where: { name: source.name } });
      if (existing) {
        await prisma.scraperSource.update({
          where: { id: existing.id },
          data: { active: true, frequency: source.frequency, config: source.config },
        });
      } else {
        await prisma.scraperSource.create({ data: { ...source, active: true } });
      }
    }
  }

  async runAll(): Promise<{
    success: boolean;
    results: Array<{ scraperName: string; success: boolean; scraped: number; inserted: number; duplicates: number; errors: number }>;
  }> {
    await this.ensureDefaultSources();
    console.log('[ScraperManager] Starting active Radar scans...');
    const sources = await prisma.scraperSource.findMany({ where: { active: true } });
    const results: Array<{ scraperName: string; success: boolean; scraped: number; inserted: number; duplicates: number; errors: number }> = [];
    let overallSuccess = true;

    for (const source of sources) {
      try {
        const result = await this.runScraper(source.id, source.name);
        results.push({ scraperName: source.name, ...result });
        if (!result.success) overallSuccess = false;
        if (result.inserted > 0) await this.triggerMatching();
      } catch (error) {
        console.error(`[ScraperManager] Error running ${source.name}:`, error);
        results.push({ scraperName: source.name, success: false, scraped: 0, inserted: 0, duplicates: 0, errors: 1 });
        overallSuccess = false;
      }
    }

    return { success: overallSuccess, results };
  }

  async runScraper(sourceId: string, scraperName: string): Promise<any> {
    const ScraperClass = this.getScraperClass(scraperName);
    if (!ScraperClass) throw new Error(`Scraper not found: ${scraperName}`);
    const scraper = new ScraperClass({ sourceId });
    return scraper.run();
  }

  private getScraperClass(name: string): typeof BaseScraper | undefined {
    const normalized = name.toLowerCase().replace(/\s+/g, '');
    if (normalized.includes('cross-source') || normalized.includes('webdiscovery') || normalized.includes('discovery')) return WebDiscoveryScraper;
    if (normalized.includes('linkedin')) return LinkedInScraper;
    if (normalized.includes('afdb') || normalized.includes('african')) return AfDBScraper;
    return undefined;
  }

  async addSource(data: { name: string; baseUrl: string; type: string; frequency?: string; config?: any }): Promise<string> {
    const source = await prisma.scraperSource.create({
      data: { name: data.name, baseUrl: data.baseUrl, type: data.type, frequency: data.frequency || 'hourly', active: true, config: data.config || {} },
    });
    return source.id;
  }

  async updateSource(sourceId: string, updates: { active?: boolean; frequency?: string; config?: any }): Promise<void> {
    await prisma.scraperSource.update({ where: { id: sourceId }, data: updates });
  }

  async deleteSource(sourceId: string): Promise<void> {
    await prisma.scraperSource.delete({ where: { id: sourceId } });
  }

  async getStats(): Promise<{
    totalSources: number;
    activeSources: number;
    totalOpportunitiesScraped: number;
    recentRuns: Array<{ name: string; lastRun: Date | null; lastSuccess: Date | null; errorCount: number; successCount: number }>;
  }> {
    const [totalSources, activeSources, sources] = await Promise.all([
      prisma.scraperSource.count(),
      prisma.scraperSource.count({ where: { active: true } }),
      prisma.scraperSource.findMany({ orderBy: { lastRun: 'desc' }, take: 50 }),
    ]);
    return {
      totalSources,
      activeSources,
      totalOpportunitiesScraped: sources.reduce((sum, source) => sum + source.totalScraped, 0),
      recentRuns: sources.slice(0, 10).map((source) => ({
        name: source.name, lastRun: source.lastRun, lastSuccess: source.lastSuccess, errorCount: source.errorCount, successCount: source.successCount,
      })),
    };
  }

  private async triggerMatching(): Promise<void> {
    const newOpportunities = await prisma.opportunity.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } },
      select: { id: true },
    });
    for (const opportunity of newOpportunities) {
      matchingEngine.matchNewOpportunity(opportunity.id).catch((error) => console.error('[ScraperManager] matching error', error));
    }
  }

  async getHealth(): Promise<Array<{ name: string; status: 'healthy' | 'degraded' | 'down'; lastRun: Date | null; lastSuccess: Date | null; errorRate: number }>> {
    const sources = await prisma.scraperSource.findMany();
    return sources.map((source) => {
      const lastRunTime = source.lastRun?.getTime() || 0;
      const hoursSinceLastRun = (Date.now() - lastRunTime) / 3600000;
      const totalRuns = source.successCount + source.errorCount;
      const errorRate = totalRuns > 0 ? (source.errorCount / totalRuns) * 100 : 0;
      let status: 'healthy' | 'degraded' | 'down' = 'healthy';
      if ((source.frequency === 'hourly' && hoursSinceLastRun > 2) || errorRate > 20) status = 'degraded';
      if (hoursSinceLastRun > 30 || errorRate > 50) status = 'down';
      return { name: source.name, status, lastRun: source.lastRun, lastSuccess: source.lastSuccess, errorRate };
    });
  }

  async resetErrors(sourceId: string): Promise<void> {
    await prisma.scraperSource.update({ where: { id: sourceId }, data: { errorCount: 0 } });
  }

  async testScraper(scraperName: string): Promise<{ success: boolean; sampleData: any[]; errors: string[] }> {
    const ScraperClass = this.getScraperClass(scraperName);
    if (!ScraperClass) return { success: false, sampleData: [], errors: [`Scraper not found: ${scraperName}`] };
    try {
      const scraper = new ScraperClass({ sourceId: 'test' });
      const rawData = await scraper['fetch']();
      return { success: true, sampleData: rawData.slice(0, 3).map((item) => scraper['normalize'](item)), errors: [] };
    } catch (error: any) {
      return { success: false, sampleData: [], errors: [error.message] };
    }
  }

  async getSchedule(): Promise<Array<{ name: string; frequency: string; nextRun: Date }>> {
    const sources = await prisma.scraperSource.findMany({ where: { active: true } });
    return sources.map((source) => {
      const nextRun = new Date(source.lastRun || new Date());
      if (source.frequency === 'hourly') nextRun.setHours(nextRun.getHours() + 1);
      else if (source.frequency === 'weekly') nextRun.setDate(nextRun.getDate() + 7);
      else nextRun.setDate(nextRun.getDate() + 1);
      return { name: source.name, frequency: source.frequency, nextRun };
    });
  }
}

export const scraperManager = new ScraperManager();
