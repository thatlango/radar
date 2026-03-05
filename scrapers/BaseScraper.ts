import { PrismaClient, Opportunity } from '@prisma/client';

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
}

export abstract class BaseScraper {
  protected config: ScraperConfig;
  protected retryCount: number = 0;

  constructor(config: ScraperConfig) {
    this.config = {
      maxRetries: 3,
      timeout: 30000,
      rateLimit: 1000,
      ...config
    };
  }

  /**
   * Abstract method to fetch raw data from source
   * Must be implemented by each scraper
   */
  abstract fetch(): Promise<any[]>;

  /**
   * Abstract method to normalize raw data to standard format
   * Must be implemented by each scraper
   */
  abstract normalize(data: any): RawOpportunity;

  /**
   * Validate normalized opportunity data
   */
  protected validate(opportunity: RawOpportunity): boolean {
    if (!opportunity.title || opportunity.title.trim().length === 0) {
      console.error('Invalid opportunity: missing title');
      return false;
    }

    if (!opportunity.organization || opportunity.organization.trim().length === 0) {
      console.error('Invalid opportunity: missing organization');
      return false;
    }

    if (!opportunity.sourceUrl || !this.isValidUrl(opportunity.sourceUrl)) {
      console.error('Invalid opportunity: invalid or missing sourceUrl');
      return false;
    }

    if (!['job', 'fellowship', 'consultancy', 'grant', 'tender'].includes(opportunity.type)) {
      console.error(`Invalid opportunity: invalid type ${opportunity.type}`);
      return false;
    }

    return true;
  }

  /**
   * Validate URL format
   */
  protected isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deduplicate opportunities by sourceUrl
   */
  protected async deduplicate(opportunity: RawOpportunity): Promise<boolean> {
    const existing = await prisma.opportunity.findUnique({
      where: { sourceUrl: opportunity.sourceUrl }
    });

    return existing === null;
  }

  /**
   * Main run method - orchestrates the scraping process
   */
  async run(): Promise<{
    success: boolean;
    scraped: number;
    inserted: number;
    duplicates: number;
    errors: number;
  }> {
    const startTime = Date.now();
    const results = {
      success: false,
      scraped: 0,
      inserted: 0,
      duplicates: 0,
      errors: 0
    };

    try {
      console.log(`[${this.constructor.name}] Starting scrape...`);

      // Fetch raw data
      const rawData = await this.fetchWithRetry();
      results.scraped = rawData.length;
      console.log(`[${this.constructor.name}] Fetched ${rawData.length} items`);

      // Process each item
      for (const item of rawData) {
        try {
          // Normalize
          const normalized = this.normalize(item);

          // Validate
          if (!this.validate(normalized)) {
            results.errors++;
            continue;
          }

          // Check for duplicates
          const isNew = await this.deduplicate(normalized);
          if (!isNew) {
            results.duplicates++;
            continue;
          }

          // Insert into database
          await this.insert(normalized);
          results.inserted++;

          // Rate limiting
          await this.sleep(this.config.rateLimit!);

        } catch (error) {
          console.error(`[${this.constructor.name}] Error processing item:`, error);
          results.errors++;
        }
      }

      // Update scraper source metadata
      await this.updateSourceMetadata(results.inserted, results.errors === 0);

      results.success = true;
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[${this.constructor.name}] Completed in ${duration}s`, results);

      return results;

    } catch (error) {
      console.error(`[${this.constructor.name}] Fatal error:`, error);
      await this.logError(error);
      return results;
    }
  }

  /**
   * Fetch with retry logic
   */
  protected async fetchWithRetry(): Promise<any[]> {
    try {
      return await this.fetch();
    } catch (error) {
      if (this.retryCount < this.config.maxRetries!) {
        this.retryCount++;
        console.log(`[${this.constructor.name}] Retry ${this.retryCount}/${this.config.maxRetries}`);
        await this.sleep(2000 * this.retryCount); // Exponential backoff
        return this.fetchWithRetry();
      }
      throw error;
    }
  }

  /**
   * Insert opportunity into database
   */
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
        source: this.constructor.name.replace('Scraper', ''),
        sourceUrl: opportunity.sourceUrl
      }
    });
  }

  /**
   * Update scraper source metadata
   */
  protected async updateSourceMetadata(insertedCount: number, success: boolean): Promise<void> {
    await prisma.scraperSource.update({
      where: { id: this.config.sourceId },
      data: {
        lastRun: new Date(),
        lastSuccess: success ? new Date() : undefined,
        errorCount: success ? 0 : { increment: 1 },
        successCount: success ? { increment: 1 } : undefined,
        totalScraped: { increment: insertedCount }
      }
    });
  }

  /**
   * Log errors to database
   */
  protected async logError(error: any): Promise<void> {
    await prisma.systemLog.create({
      data: {
        level: 'error',
        source: 'scraper',
        message: `[${this.constructor.name}] ${error.message}`,
        metadata: {
          stack: error.stack,
          sourceId: this.config.sourceId
        }
      }
    });
  }

  /**
   * Sleep utility
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clean HTML text
   */
  protected cleanText(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Parse date from various formats
   */
  protected parseDate(dateString: string): Date | undefined {
    if (!dateString) return undefined;

    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return undefined;
      return date;
    } catch {
      return undefined;
    }
  }

  /**
   * Determine if remote based on text analysis
   */
  protected isRemote(text: string): boolean {
    const remoteKeywords = [
      'remote',
      'work from home',
      'wfh',
      'anywhere',
      'distributed',
      'virtual',
      'telecommute'
    ];

    const lowerText = text.toLowerCase();
    return remoteKeywords.some(keyword => lowerText.includes(keyword));
  }
}
