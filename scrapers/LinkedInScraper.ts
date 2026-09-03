import axios from 'axios';
import { BaseScraper, RawOpportunity, ScraperConfig } from './BaseScraper';

interface LinkedInJob {
  jobId: string;
  title: string;
  companyName: string;
  location: string;
  description: string;
  applyUrl: string;
  postedDate: string;
  workplace: string;
  salary?: string;
}

export class LinkedInScraper extends BaseScraper {
  private apiEndpoint: string;
  private apiKey: string;

  constructor(config: ScraperConfig) {
    super(config);
    this.apiEndpoint = process.env.LINKEDIN_API_ENDPOINT || '';
    this.apiKey = process.env.LINKEDIN_API_KEY || '';
  }

  async fetch(): Promise<LinkedInJob[]> {
    // LinkedIn remains a primary discovery source through WebDiscoveryScraper even when no dedicated jobs API is configured.
    if (!this.apiEndpoint || !this.apiKey) {
      console.log('[LinkedInScraper] Dedicated LinkedIn API not configured; using cross-source web discovery instead.');
      return [];
    }

    const keywords = process.env.RADAR_LINKEDIN_KEYWORDS || [
      'consultant', 'consultancy', 'program design', 'programme implementation', 'enterprise development',
      'MSME', 'private sector development', 'innovation', 'MEL', 'capacity building', 'digital transformation',
    ].join(' OR ');
    const locations = process.env.RADAR_LINKEDIN_LOCATIONS || 'Uganda,Kenya,Rwanda,Tanzania,Ethiopia,Africa,Remote';

    const response = await axios.get(this.apiEndpoint, {
      headers: { 'X-RapidAPI-Key': this.apiKey, 'X-RapidAPI-Host': process.env.LINKEDIN_API_HOST || 'linkedin-jobs-api.rapidapi.com' },
      params: { keywords, location: locations, datePosted: 'week', limit: Number(process.env.RADAR_LINKEDIN_LIMIT || 50) },
      timeout: this.config.timeout,
    });
    return response.data.jobs || response.data.data || [];
  }

  normalize(job: LinkedInJob): RawOpportunity {
    const country = this.extractCountry(job.location || '');
    const remote = this.isRemote(`${job.description || ''} ${job.workplace || ''}`) || job.workplace?.toLowerCase() === 'remote';
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 30);
    return {
      title: this.cleanText(job.title),
      organization: this.cleanText(job.companyName),
      country,
      region: this.extractRegion(job.location || ''),
      type: this.inferType(`${job.title} ${job.description || ''}`),
      remote,
      description: this.cleanText(job.description || ''),
      requirements: this.extractRequirements(job.description || ''),
      salary: job.salary,
      deadline,
      sourceUrl: `https://www.linkedin.com/jobs/view/${job.jobId}`,
      applicationUrl: job.applyUrl || `https://www.linkedin.com/jobs/view/${job.jobId}`,
    };
  }

  private inferType(text: string): RawOpportunity['type'] {
    const lower = text.toLowerCase();
    if (/consultant|consultancy|technical assistance|advisor|advisory/.test(lower)) return 'consultancy';
    if (/grant|funding/.test(lower)) return 'grant';
    if (/fellowship/.test(lower)) return 'fellowship';
    return 'job';
  }

  private extractCountry(location: string): string {
    const africanCountries = [
      'Uganda','Kenya','Rwanda','Tanzania','Ethiopia','South Sudan','Somalia','Burundi','DRC','Congo',
      'Mozambique','Zambia','Zimbabwe','Malawi','Ghana','Nigeria','Senegal','South Africa','Egypt','Morocco','Tunisia','Guinea',
    ];
    const found = africanCountries.find((country) => location.toLowerCase().includes(country.toLowerCase()));
    if (found) return found;
    if (/remote|worldwide|global/i.test(location)) return 'Remote / Global';
    const parts = location.split(',');
    return parts[parts.length - 1]?.trim() || 'Africa / Global';
  }

  private extractRegion(location: string): string | undefined {
    const parts = location.split(',').map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts[0] : undefined;
  }

  private extractRequirements(description: string): string | undefined {
    const markers = ['requirements:', 'qualifications:', 'you should have:', 'minimum qualifications:', 'what you need:', 'skills required:'];
    const lower = description.toLowerCase();
    for (const marker of markers) {
      const index = lower.indexOf(marker);
      if (index === -1) continue;
      const endMarkers = ['responsibilities:', 'about us:', 'benefits:', 'what we offer:'];
      let endIndex = description.length;
      for (const endMarker of endMarkers) {
        const possible = lower.indexOf(endMarker, index + marker.length);
        if (possible !== -1 && possible < endIndex) endIndex = possible;
      }
      return this.cleanText(description.substring(index, endIndex));
    }
    return undefined;
  }
}
