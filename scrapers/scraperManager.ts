import { PrismaClient } from '@prisma/client';
import { BaseScraper } from './BaseScraper';
import { LinkedInScraper } from './LinkedInScraper';
import { AfDBScraper } from './AfDBScraper';
import { WebDiscoveryScraper } from './WebDiscoveryScraper';
import { RssFeedScraper } from './RssFeedScraper';
import { PublicPageScraper } from './PublicPageScraper';
import { WorldBankScraper } from './WorldBankScraper';
import { UgandaGppScraper } from './UgandaGppScraper';
import { EuFundingScraper } from './EuFundingScraper';
import { GrantsGovScraper } from './GrantsGovScraper';
import { UnPartnerScraper } from './UnPartnerScraper';
import { BrighterMondayScraper } from './BrighterMondayScraper';
import { ImpactpoolScraper } from './ImpactpoolScraper';
import { EuraxessScraper } from './EuraxessScraper';
import { IdrcScraper } from './IdrcScraper';
import { GrandChallengesScraper } from './GrandChallengesScraper';
import { RADAR_SOURCE_CATALOG } from './scanProfiles';

const prisma = new PrismaClient();
type ScraperCtor = new (config: { sourceId: string }) => BaseScraper;

export class ScraperManager {
  private cadenceClass(definition: any): 'hot' | 'normal' | 'slow' {
    const name = String(definition?.name || '');
    const adapter = String(definition?.adapter || '');
    if (['JobsToApply.com','BrighterMonday Uganda','Impactpool','EURAXESS Jobs & Research Opportunities'].includes(name)) return 'hot';
    if (['rss','worldbank','ugandagpp'].includes(adapter) || /Procurement|Jobs|Opportunity Desk|Opportunities for Africans/i.test(name)) return 'normal';
    return 'slow';
  }

  private baseCadenceMinutes(source: any): number {
    const config = source?.config && typeof source.config === 'object' ? source.config as any : {};
    const explicit = Number(config.cadenceMinutes || 0);
    if (explicit > 0) return Math.max(15, Math.min(10080, explicit));
    const frequency = String(source.frequency || 'normal').toLowerCase();
    if (frequency === 'hot') return 30;
    if (frequency === 'normal') return 180;
    if (frequency === 'slow') return 720;
    if (frequency === 'hourly') return 60;
    if (frequency === 'weekly') return 10080;
    return 720;
  }

  private effectiveCadenceMinutes(source: any, recentRuns: any[] = []): number {
    let minutes = this.baseCadenceMinutes(source);
    const completed = recentRuns.filter((run) => ['success','partial','failed'].includes(String(run.status || '')));
    const recentSuccesses = completed.filter((run) => run.status !== 'failed');
    const last = completed[0];
    const dry = recentSuccesses.slice(0, 4).length >= 3 && recentSuccesses.slice(0, 4).every((run) => Number(run.inserted || 0) === 0);
    if (Number(source.errorCount || 0) >= 3 || completed.slice(0, 2).some((run) => run.status === 'failed')) minutes = Math.min(1440, minutes * 4);
    else if (dry) minutes = Math.min(1440, Math.round(minutes * 1.75));
    else if (last && Number(last.inserted || 0) > 0) minutes = Math.max(15, Math.round(minutes * .75));
    return minutes;
  }
  async ensureDefaultSources(): Promise<void> {
    const searchAvailable = Boolean(process.env.BRAVE_SEARCH_API_KEY || process.env.SERPER_API_KEY);
    const linkedInAvailable = Boolean(process.env.LINKEDIN_API_ENDPOINT && process.env.LINKEDIN_API_KEY);

    // Retire aliases from the original three-source prototype so source counts represent real adapters.
    await prisma.scraperSource.updateMany({ where: { name: { in: ['AfDB'] } }, data: { active: false } }).catch(() => undefined);

    for (const definition of RADAR_SOURCE_CATALOG) {
      const adapter = definition.adapter;
      const active = ['rss','page','afdb','worldbank','ugandagpp','eufunding','grantsgov','unpartner','brightermonday','impactpool','euraxess','idrc','grandchallenges'].includes(adapter)
        ? true
        : adapter === 'linkedin'
          ? linkedInAvailable
          : adapter === 'search'
            ? searchAvailable
            : false;
      const config = {
        adapter,
        trust: definition.trust,
        feedUrl: definition.feedUrl,
        pages: definition.pages,
        domains: [definition.domain],
        defaultType: definition.defaultType,
        defaultCountry: definition.defaultCountry,
        organization: definition.organization,
        requireOpportunityKeyword: definition.requireOpportunityKeyword,
        scanProfile: 'all',
      };
      const row = await prisma.scraperSource.findFirst({ where: { name: definition.name } });
      if (row) {
        await prisma.scraperSource.update({
          where: { id: row.id },
          data: {
            baseUrl: definition.baseUrl || `https://${definition.domain}`,
            active,
            type: definition.defaultType || (adapter === 'rss' ? 'job' : 'consultancy'),
            frequency: this.cadenceClass(definition),
            config: { ...config, cadenceMinutes: this.cadenceClass(definition) === 'hot' ? 30 : this.cadenceClass(definition) === 'normal' ? 180 : 720 },
          },
        });
      } else {
        await prisma.scraperSource.create({
          data: {
            name: definition.name,
            baseUrl: definition.baseUrl || `https://${definition.domain}`,
            active,
            type: definition.defaultType || (adapter === 'rss' ? 'job' : 'consultancy'),
            frequency: this.cadenceClass(definition),
            config: { ...config, cadenceMinutes: this.cadenceClass(definition) === 'hot' ? 30 : this.cadenceClass(definition) === 'normal' ? 180 : 720 },
          },
        });
      }
    }

    // Long-tail discovery searches beyond the curated catalog. This is only active when a search API is configured.
    const broadName = 'Cross-source Web Discovery';
    const broadConfig = { adapter: 'search', scanProfile: 'all', domains: [], trust: 'secondary', coverage: 'long-tail-web' };
    const broad = await prisma.scraperSource.findFirst({ where: { name: broadName } });
    if (broad) {
      await prisma.scraperSource.update({ where: { id: broad.id }, data: { active: searchAvailable, baseUrl: 'https://radar.tukutuku.org/discovery', frequency: 'normal', config: { ...broadConfig, cadenceMinutes: 180 } } });
    } else {
      await prisma.scraperSource.create({ data: { name: broadName, baseUrl: 'https://radar.tukutuku.org/discovery', type: 'consultancy', frequency: 'normal', active: searchAvailable, config: { ...broadConfig, cadenceMinutes: 180 } } });
    }
  }

  private isDue(source: any, recentRuns: any[] = [], now = new Date()): boolean {
    if (!source.lastRun) return true;
    const elapsedMinutes = (now.getTime() - new Date(source.lastRun).getTime()) / 60000;
    return elapsedMinutes >= this.effectiveCadenceMinutes(source, recentRuns) * .92;
  }

  async runAll(options: { force?: boolean } = {}): Promise<{
    success: boolean;
    results: Array<{ scraperName: string; success: boolean; scraped: number; inserted: number; duplicates: number; errors: number }>;
  }> {
    await this.ensureDefaultSources();
    console.log('[ScraperManager] Starting due Radar scans...');
    const allSources = await prisma.scraperSource.findMany({ where: { active: true } });
    const recentRuns = await prisma.scrapeRun.findMany({
      where: { sourceId: { in: allSources.map((source) => source.id) } },
      orderBy: { startedAt: 'desc' },
      take: Math.max(80, allSources.length * 5),
    });
    const bySource = new Map<string, any[]>();
    for (const run of recentRuns) { const rows = bySource.get(run.sourceId) || []; if (rows.length < 5) rows.push(run); bySource.set(run.sourceId, rows); }
    const sources = options.force ? allSources : allSources.filter((source) => this.isDue(source, bySource.get(source.id) || []));
    console.log(`[ScraperManager] ${sources.length}/${allSources.length} active sources due${options.force ? ' (forced)' : ''}.`);
    const results: Array<{ scraperName: string; success: boolean; scraped: number; inserted: number; duplicates: number; errors: number }> = [];
    let overallSuccess = true;

    for (const source of sources) {
      try {
        const result = await this.runScraper(source);
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

  async runScraper(source: any): Promise<any> {
    const ScraperClass = this.getScraperClass(source);
    if (!ScraperClass) throw new Error(`Scraper adapter not found for ${source.name}`);
    const scraper = new ScraperClass({ sourceId: source.id });
    return scraper.run();
  }

  private getScraperClass(source: any): ScraperCtor | undefined {
    const config = source?.config && typeof source.config === 'object' ? source.config as any : {};
    const adapter = String(config.adapter || '').toLowerCase();
    if (adapter === 'rss') return RssFeedScraper;
    if (adapter === 'page') return PublicPageScraper;
    if (adapter === 'search') return WebDiscoveryScraper;
    if (adapter === 'worldbank') return WorldBankScraper;
    if (adapter === 'ugandagpp') return UgandaGppScraper;
    if (adapter === 'eufunding') return EuFundingScraper;
    if (adapter === 'grantsgov') return GrantsGovScraper;
    if (adapter === 'unpartner') return UnPartnerScraper;
    if (adapter === 'brightermonday') return BrighterMondayScraper;
    if (adapter === 'impactpool') return ImpactpoolScraper;
    if (adapter === 'euraxess') return EuraxessScraper;
    if (adapter === 'idrc') return IdrcScraper;
    if (adapter === 'grandchallenges') return GrandChallengesScraper;
    if (adapter === 'linkedin') return LinkedInScraper;
    if (adapter === 'afdb') return AfDBScraper;
    const normalized = String(source?.name || '').toLowerCase().replace(/\s+/g, '');
    if (normalized.includes('cross-source') || normalized.includes('webdiscovery') || normalized.includes('discovery')) return WebDiscoveryScraper;
    if (normalized.includes('linkedin')) return LinkedInScraper;
    if (normalized.includes('afdb') || normalized.includes('african development')) return AfDBScraper;
    return undefined;
  }

  async addSource(data: { name: string; baseUrl: string; type: string; frequency?: string; config?: any }): Promise<string> {
    const source = await prisma.scraperSource.create({ data: { name: data.name, baseUrl: data.baseUrl, type: data.type, frequency: data.frequency || 'daily', active: true, config: data.config || {} } });
    return source.id;
  }

  async updateSource(sourceId: string, updates: { active?: boolean; frequency?: string; config?: any }): Promise<void> {
    await prisma.scraperSource.update({ where: { id: sourceId }, data: updates });
  }

  async deleteSource(sourceId: string): Promise<void> { await prisma.scraperSource.delete({ where: { id: sourceId } }); }

  async getStats(): Promise<{
    totalSources: number;
    activeSources: number;
    totalOpportunitiesScraped: number;
    recentRuns: Array<{ name: string; lastRun: Date | null; lastSuccess: Date | null; errorCount: number; successCount: number }>;
  }> {
    const [totalSources, activeSources, sources] = await Promise.all([
      prisma.scraperSource.count(),
      prisma.scraperSource.count({ where: { active: true } }),
      prisma.scraperSource.findMany({ orderBy: { lastRun: 'desc' }, take: 100 }),
    ]);
    return {
      totalSources,
      activeSources,
      totalOpportunitiesScraped: sources.reduce((sum, source) => sum + source.totalScraped, 0),
      recentRuns: sources.slice(0, 25).map((source) => ({ name: source.name, lastRun: source.lastRun, lastSuccess: source.lastSuccess, errorCount: source.errorCount, successCount: source.successCount })),
    };
  }

  private async triggerMatching(): Promise<void> {
    const newOpportunities = await prisma.opportunity.findMany({ where: { createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } }, select: { id: true } });
    for (const opportunity of newOpportunities) {
      await prisma.radarJob.upsert({
        where: { dedupeKey: `match-opportunity:${opportunity.id}` },
        create: { type: 'match_opportunity', payload: { opportunityId: opportunity.id }, dedupeKey: `match-opportunity:${opportunity.id}`, status: 'queued' },
        update: { status: 'queued', runAt: new Date(), completedAt: null, lastError: null },
      }).catch((error) => console.error('[ScraperManager] matching queue error', error));
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
      if ((source.frequency === 'hourly' && hoursSinceLastRun > 5) || errorRate > 20) status = 'degraded';
      if (hoursSinceLastRun > 36 || errorRate > 50) status = 'down';
      return { name: source.name, status, lastRun: source.lastRun, lastSuccess: source.lastSuccess, errorRate };
    });
  }

  async resetErrors(sourceId: string): Promise<void> { await prisma.scraperSource.update({ where: { id: sourceId }, data: { errorCount: 0 } }); }

  async getSchedule(): Promise<Array<{ name: string; frequency: string; cadenceMinutes: number; nextRun: Date }>> {
    const sources = await prisma.scraperSource.findMany({ where: { active: true } });
    const recentRuns = await prisma.scrapeRun.findMany({ where: { sourceId: { in: sources.map((source) => source.id) } }, orderBy: { startedAt: 'desc' }, take: Math.max(80, sources.length * 5) });
    const bySource = new Map<string, any[]>();
    for (const run of recentRuns) { const rows = bySource.get(run.sourceId) || []; if (rows.length < 5) rows.push(run); bySource.set(run.sourceId, rows); }
    return sources.map((source) => {
      const cadenceMinutes = this.effectiveCadenceMinutes(source, bySource.get(source.id) || []);
      const nextRun = new Date((source.lastRun || new Date()).getTime() + cadenceMinutes * 60000);
      return { name: source.name, frequency: source.frequency, cadenceMinutes, nextRun };
    });
  }
}

export const scraperManager = new ScraperManager();
