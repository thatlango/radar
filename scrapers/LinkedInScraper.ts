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

  /**
   * Fetch jobs from LinkedIn API
   * In production, this would use LinkedIn's official API or a third-party service
   */
  async fetch(): Promise<LinkedInJob[]> {
    try {
      // Example using RapidAPI LinkedIn Jobs API
      const response = await axios.get(this.apiEndpoint, {
        headers: {
          'X-RapidAPI-Key': this.apiKey,
          'X-RapidAPI-Host': 'linkedin-jobs-api.rapidapi.com'
        },
        params: {
          keywords: 'technology developer manager',
          location: 'Kenya,Nigeria,South Africa,Ghana,Egypt',
          datePosted: 'week',
          experienceLevel: 'mid-senior',
          limit: 50
        },
        timeout: this.config.timeout
      });

      return response.data.jobs || [];
    } catch (error) {
      console.error('[LinkedInScraper] Fetch error:', error);
      throw error;
    }
  }

  /**
   * Normalize LinkedIn job to standard format
   */
  normalize(job: LinkedInJob): RawOpportunity {
    // Extract country from location
    const country = this.extractCountry(job.location);
    
    // Determine if remote
    const remote = this.isRemote(job.description) || 
                   job.workplace?.toLowerCase() === 'remote';

    // Parse deadline (LinkedIn typically 30 days from post)
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 30);

    return {
      title: this.cleanText(job.title),
      organization: this.cleanText(job.companyName),
      country: country,
      region: this.extractRegion(job.location),
      type: 'job',
      remote: remote,
      description: this.cleanText(job.description),
      requirements: this.extractRequirements(job.description),
      salary: job.salary,
      deadline: deadline,
      sourceUrl: job.applyUrl || `https://www.linkedin.com/jobs/view/${job.jobId}`
    };
  }

  /**
   * Extract country from location string
   */
  private extractCountry(location: string): string {
    const africanCountries = [
      'Kenya', 'Nigeria', 'South Africa', 'Ghana', 'Egypt',
      'Rwanda', 'Uganda', 'Tanzania', 'Ethiopia', 'Morocco',
      'Tunisia', 'Senegal', 'Côte d\'Ivoire', 'Zimbabwe'
    ];

    for (const country of africanCountries) {
      if (location.includes(country)) {
        return country;
      }
    }

    // Default to extracting last part of location
    const parts = location.split(',');
    return parts[parts.length - 1].trim() || 'Remote';
  }

  /**
   * Extract region/city from location
   */
  private extractRegion(location: string): string | undefined {
    const parts = location.split(',').map(p => p.trim());
    if (parts.length > 1) {
      return parts[0]; // First part is usually city/region
    }
    return undefined;
  }

  /**
   * Extract requirements section from description
   */
  private extractRequirements(description: string): string | undefined {
    const requirementsMarkers = [
      'requirements:',
      'qualifications:',
      'you should have:',
      'minimum qualifications:',
      'what you need:',
      'skills required:'
    ];

    const lowerDesc = description.toLowerCase();
    
    for (const marker of requirementsMarkers) {
      const index = lowerDesc.indexOf(marker);
      if (index !== -1) {
        // Extract from marker to next major section or end
        const endMarkers = ['responsibilities:', 'about us:', 'benefits:', 'what we offer:'];
        let endIndex = description.length;
        
        for (const endMarker of endMarkers) {
          const possibleEnd = lowerDesc.indexOf(endMarker, index + marker.length);
          if (possibleEnd !== -1 && possibleEnd < endIndex) {
            endIndex = possibleEnd;
          }
        }

        return this.cleanText(description.substring(index, endIndex));
      }
    }

    return undefined;
  }
}
