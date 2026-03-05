import { PrismaClient } from '@prisma/client';
import { BaseScraper } from './BaseScraper';
import { LinkedInScraper } from './LinkedInScraper';
import { AfDBScraper } from './AfDBScraper';
import { AIMatchingEngine } from '../ai/matching';

const prisma = new PrismaClient();
const matchingEngine = new AIMatchingEngine();

export class ScraperManager {
  private scrapers: Map<string, typeof BaseScraper> = new Map();

  constructor() {
    // Register all available scrapers
    this.scrapers.set('linkedin', LinkedInScraper);
    this.scrapers.set('afdb', AfDBScraper);
    // Add more scrapers here as they're built
  }

  /**
   * Run all active scrapers
   */
  async runAll(): Promise<{
    success: boolean;
    results: Array<{
      scraperName: string;
      success: boolean;
      scraped: number;
      inserted: number;
      duplicates: number;
      errors: number;
    }>;
  }> {
    console.log('[ScraperManager] Starting all scrapers...');

    const sources = await prisma.scraperSource.findMany({
      where: { active: true }
    });

    const results = [];
    let overallSuccess = true;

    for (const source of sources) {
      try {
        const result = await this.runScraper(source.id, source.name);
        results.push({
          scraperName: source.name,
          ...result
        });

        if (!result.success) {
          overallSuccess = false;
        }

        // Trigger matching for newly inserted opportunities
        if (result.inserted > 0) {
          await this.triggerMatching();
        }

      } catch (error) {
        console.error(`[ScraperManager] Error running scraper ${source.name}:`, error);
        results.push({
          scraperName: source.name,
          success: false,
          scraped: 0,
          inserted: 0,
          duplicates: 0,
          errors: 1
        });
        overallSuccess = false;
      }
    }

    console.log('[ScraperManager] All scrapers completed');
    return {
      success: overallSuccess,
      results
    };
  }

  /**
   * Run a specific scraper by ID
   */
  async runScraper(sourceId: string, scraperName: string): Promise<any> {
    const ScraperClass = this.getScraperClass(scraperName);

    if (!ScraperClass) {
      throw new Error(`Scraper not found: ${scraperName}`);
    }

    const scraper = new ScraperClass({ sourceId });
    return await scraper.run();
  }

  /**
   * Get scraper class by name
   */
  private getScraperClass(name: string): typeof BaseScraper | undefined {
    const normalized = name.toLowerCase().replace(/\s+/g, '');
    
    // Map common names to scraper classes
    if (normalized.includes('linkedin')) {
      return LinkedInScraper;
    }
    
    if (normalized.includes('afdb') || normalized.includes('african')) {
      return AfDBScraper;
    }

    return undefined;
  }

  /**
   * Add new scraper source
   */
  async addSource(data: {
    name: string;
    baseUrl: string;
    type: string;
    frequency?: string;
    config?: any;
  }): Promise<string> {
    const source = await prisma.scraperSource.create({
      data: {
        name: data.name,
        baseUrl: data.baseUrl,
        type: data.type,
        frequency: data.frequency || 'hourly',
        active: true,
        config: data.config || {}
      }
    });

    console.log(`[ScraperManager] Added new source: ${source.name}`);
    return source.id;
  }

  /**
   * Update scraper source
   */
  async updateSource(
    sourceId: string,
    updates: {
      active?: boolean;
      frequency?: string;
      config?: any;
    }
  ): Promise<void> {
    await prisma.scraperSource.update({
      where: { id: sourceId },
      data: updates
    });

    console.log(`[ScraperManager] Updated source: ${sourceId}`);
  }

  /**
   * Delete scraper source
   */
  async deleteSource(sourceId: string): Promise<void> {
    await prisma.scraperSource.delete({
      where: { id: sourceId }
    });

    console.log(`[ScraperManager] Deleted source: ${sourceId}`);
  }

  /**
   * Get scraper statistics
   */
  async getStats(): Promise<{
    totalSources: number;
    activeSources: number;
    totalOpportunitiesScraped: number;
    recentRuns: Array<{
      name: string;
      lastRun: Date | null;
      lastSuccess: Date | null;
      errorCount: number;
      successCount: number;
    }>;
  }> {
    const [totalSources, activeSources, sources] = await Promise.all([
      prisma.scraperSource.count(),
      prisma.scraperSource.count({ where: { active: true } }),
      prisma.scraperSource.findMany({
        orderBy: { lastRun: 'desc' },
        take: 10
      })
    ]);

    const totalScraped = sources.reduce((sum, s) => sum + s.totalScraped, 0);

    const recentRuns = sources.map(s => ({
      name: s.name,
      lastRun: s.lastRun,
      lastSuccess: s.lastSuccess,
      errorCount: s.errorCount,
      successCount: s.successCount
    }));

    return {
      totalSources,
      activeSources,
      totalOpportunitiesScraped: totalScraped,
      recentRuns
    };
  }

  /**
   * Trigger matching engine for new opportunities
   */
  private async triggerMatching(): Promise<void> {
    // Get opportunities added in last 5 minutes
    const newOpportunities = await prisma.opportunity.findMany({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 5 * 60 * 1000)
        }
      },
      select: { id: true }
    });

    console.log(`[ScraperManager] Triggering matching for ${newOpportunities.length} new opportunities`);

    // Run matching in background (don't await)
    for (const opp of newOpportunities) {
      matchingEngine.matchNewOpportunity(opp.id).catch(err => {
        console.error(`[ScraperManager] Matching error for opportunity ${opp.id}:`, err);
      });
    }
  }

  /**
   * Get scraper health status
   */
  async getHealth(): Promise<Array<{
    name: string;
    status: 'healthy' | 'degraded' | 'down';
    lastRun: Date | null;
    lastSuccess: Date | null;
    errorRate: number;
  }>> {
    const sources = await prisma.scraperSource.findMany();

    return sources.map(source => {
      const now = Date.now();
      const lastRunTime = source.lastRun?.getTime() || 0;
      const hoursSinceLastRun = (now - lastRunTime) / (1000 * 60 * 60);

      let status: 'healthy' | 'degraded' | 'down' = 'healthy';

      // Determine health based on frequency
      if (source.frequency === 'hourly' && hoursSinceLastRun > 2) {
        status = 'degraded';
      }
      if (hoursSinceLastRun > 24) {
        status = 'down';
      }

      // Check error rate
      const totalRuns = source.successCount + source.errorCount;
      const errorRate = totalRuns > 0 
        ? (source.errorCount / totalRuns) * 100 
        : 0;

      if (errorRate > 50) {
        status = 'down';
      } else if (errorRate > 20) {
        status = 'degraded';
      }

      return {
        name: source.name,
        status,
        lastRun: source.lastRun,
        lastSuccess: source.lastSuccess,
        errorRate
      };
    });
  }

  /**
   * Reset error count for a scraper
   */
  async resetErrors(sourceId: string): Promise<void> {
    await prisma.scraperSource.update({
      where: { id: sourceId },
      data: { errorCount: 0 }
    });

    console.log(`[ScraperManager] Reset errors for source: ${sourceId}`);
  }

  /**
   * Test a scraper without storing results
   */
  async testScraper(scraperName: string): Promise<{
    success: boolean;
    sampleData: any[];
    errors: string[];
  }> {
    console.log(`[ScraperManager] Testing scraper: ${scraperName}`);

    const ScraperClass = this.getScraperClass(scraperName);

    if (!ScraperClass) {
      return {
        success: false,
        sampleData: [],
        errors: [`Scraper not found: ${scraperName}`]
      };
    }

    try {
      // Create temporary test instance
      const scraper = new ScraperClass({ sourceId: 'test' });
      
      // Fetch data (but don't insert)
      const rawData = await scraper['fetch']();
      
      // Normalize first 3 items
      const sampleData = rawData.slice(0, 3).map(item => {
        try {
          return scraper['normalize'](item);
        } catch (error) {
          return { error: error.message };
        }
      });

      return {
        success: true,
        sampleData,
        errors: []
      };

    } catch (error: any) {
      return {
        success: false,
        sampleData: [],
        errors: [error.message]
      };
    }
  }

  /**
   * Schedule scrapers based on frequency
   */
  async getSchedule(): Promise<Array<{
    name: string;
    frequency: string;
    nextRun: Date;
  }>> {
    const sources = await prisma.scraperSource.findMany({
      where: { active: true }
    });

    return sources.map(source => {
      const lastRun = source.lastRun || new Date();
      let nextRun = new Date(lastRun);

      switch (source.frequency) {
        case 'hourly':
          nextRun.setHours(nextRun.getHours() + 1);
          break;
        case 'daily':
          nextRun.setDate(nextRun.getDate() + 1);
          break;
        case 'weekly':
          nextRun.setDate(nextRun.getDate() + 7);
          break;
      }

      return {
        name: source.name,
        frequency: source.frequency,
        nextRun
      };
    });
  }
}

// Export singleton instance
export const scraperManager = new ScraperManager();
