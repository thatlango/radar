import axios from 'axios';
import { BaseScraper, RawOpportunity, ScraperConfig } from './BaseScraper';

const AFRICAREERS_APP_ID = '68fe59e9c28d1e65ba1bdc00';
const AFRICAREERS_API = `https://jobs.africareers.net/api/apps/${AFRICAREERS_APP_ID}/entities/JobPost`;

type AfricareersJob = {
  id?: string;
  slug?: string;
  canonical_url?: string;
  job_title?: string;
  company_name?: string;
  location?: string;
  city?: string;
  employment_type?: string;
  job_category?: string;
  industry?: string;
  short_description?: string;
  job_description?: string;
  requirements?: string;
  qualifications?: string;
  application_deadline?: string;
  application_link?: string;
  external_application_url?: string;
  application_url?: string;
  application_email?: string;
  application_instructions?: string;
  how_to_apply?: string;
  offered_salary_min?: number;
  offered_salary_max?: number;
  salary_currency?: string;
};

export class AfricareersScraper extends BaseScraper {
  constructor(config: ScraperConfig) {
    super({ rateLimit: 35, timeout: 30000, ...config });
  }

  async fetch(): Promise<AfricareersJob[]> {
    return this.fetchPublicJobs(0);
  }

  private async fetchPublicJobs(attempt: number): Promise<AfricareersJob[]> {
    try {
      const response = await axios.get(AFRICAREERS_API, {
        timeout: this.config.timeout,
        responseType: 'json',
        headers: {
          'User-Agent': 'Radar/1.0 (+https://radar.tukutuku.org)',
          Accept: 'application/json',
          'X-App-Id': AFRICAREERS_APP_ID,
        },
        params: {
          q: JSON.stringify({ admin_approval_status: 'approved', status: 'active' }),
          sort: '-approved_at',
          limit: Math.max(1, Math.min(100, Number(process.env.RADAR_AFRICAREERS_LIMIT || 50))),
        },
      });
      return Array.isArray(response.data) ? response.data : [];
    } catch (error: any) {
      const status = Number(error?.response?.status || 0);
      const retryAfter = Number(error?.response?.headers?.['retry-after'] || 0);
      if (status === 429 && attempt < 1 && retryAfter > 0 && retryAfter <= 75) {
        await this.sleep((retryAfter + 1) * 1000);
        return this.fetchPublicJobs(attempt + 1);
      }
      throw error;
    }
  }

  normalize(row: AfricareersJob): RawOpportunity {
    const title = this.cleanText(row.job_title || '');
    const organization = this.cleanText(row.company_name || 'AfriCareers employer');
    const country = this.cleanText(row.location || 'Africa');
    const region = this.cleanText(row.city || '');
    const employment = this.cleanText(row.employment_type || '');
    const category = this.cleanText(row.job_category || row.industry || '');
    const description = this.cleanText(row.short_description || row.job_description || '');
    const requirements = this.cleanText(row.requirements || row.qualifications || '');
    const applicationInstructions = this.cleanText(row.application_instructions || row.how_to_apply || '');
    const consultancy = /consultant|consultancy|advisor|advisory|technical assistance/i.test(`${title} ${employment} ${category}`);
    const location = region ? `${region}, ${country}` : country;

    return {
      title,
      organization,
      country,
      region: region || undefined,
      type: consultancy ? 'consultancy' : 'job',
      remote: this.isRemote(`${location} ${employment} ${description}`),
      description: this.cleanText(`${description}${employment ? `. Employment: ${employment}` : ''}${category ? `. Category: ${category}` : ''}${location ? `. Location: ${location}` : ''}`).slice(0, 12000),
      requirements: requirements || undefined,
      salary: this.salary(row),
      deadline: this.parseDate(row.application_deadline || ''),
      sourceUrl: this.sourceUrl(row),
      source: 'AfriCareers Jobs',
      applicationUrl: this.validHttp(row.application_link || row.external_application_url || row.application_url),
      applicationEmail: this.validEmail(row.application_email) || this.extractApplicationEmail(applicationInstructions),
      applicationInstructions: applicationInstructions || undefined,
    };
  }

  private sourceUrl(row: AfricareersJob): string {
    const canonical = this.validHttp(row.canonical_url);
    if (canonical) return canonical;
    if (row.slug) return `https://jobs.africareers.net/jobdetail?slug=${encodeURIComponent(row.slug)}`;
    return `https://jobs.africareers.net/jobs?id=${encodeURIComponent(String(row.id || 'unknown'))}`;
  }

  private salary(row: AfricareersJob): string | undefined {
    if (row.offered_salary_min == null && row.offered_salary_max == null) return undefined;
    const currency = this.cleanText(row.salary_currency || '');
    const min = row.offered_salary_min == null ? '' : String(row.offered_salary_min);
    const max = row.offered_salary_max == null ? '' : String(row.offered_salary_max);
    return this.cleanText(`${currency} ${min}${min && max ? ' - ' : ''}${max}`).trim() || undefined;
  }

  private validHttp(value?: string): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  }

  private validEmail(value?: string): string | undefined {
    const email = String(value || '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
  }

  private extractApplicationEmail(value: string): string | undefined {
    const match = String(value || '').match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    return match?.[0];
  }
}
