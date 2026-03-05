import axios from 'axios';
import * as cheerio from 'cheerio';
import { BaseScraper, RawOpportunity, ScraperConfig } from './BaseScraper';

interface AfDBJob {
  title: string;
  location: string;
  deadline: string;
  url: string;
  grade: string;
  description?: string;
}

export class AfDBScraper extends BaseScraper {
  private baseUrl = 'https://www.afdb.org';
  private careersUrl = 'https://www.afdb.org/en/careers/current-job-openings';

  constructor(config: ScraperConfig) {
    super(config);
  }

  /**
   * Fetch jobs from African Development Bank careers page
   */
  async fetch(): Promise<AfDBJob[]> {
    try {
      const response = await axios.get(this.careersUrl, {
        timeout: this.config.timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RadarBot/1.0)'
        }
      });

      const $ = cheerio.load(response.data);
      const jobs: AfDBJob[] = [];

      // Parse job listings
      $('.job-listing').each((i, element) => {
        const $job = $(element);
        
        const title = $job.find('.job-title').text().trim();
        const location = $job.find('.job-location').text().trim();
        const deadline = $job.find('.job-deadline').text().trim();
        const relativeUrl = $job.find('a').attr('href');
        const grade = $job.find('.job-grade').text().trim();

        if (title && relativeUrl) {
          jobs.push({
            title,
            location,
            deadline,
            url: relativeUrl.startsWith('http') ? relativeUrl : `${this.baseUrl}${relativeUrl}`,
            grade
          });
        }
      });

      // Fetch detailed descriptions
      for (const job of jobs) {
        try {
          const detailResponse = await axios.get(job.url, {
            timeout: this.config.timeout,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; RadarBot/1.0)'
            }
          });

          const $detail = cheerio.load(detailResponse.data);
          job.description = $detail('.job-description').text().trim();

          await this.sleep(1000); // Rate limit: 1 second between requests
        } catch (error) {
          console.error(`[AfDBScraper] Error fetching job details for ${job.url}:`, error);
        }
      }

      return jobs;
    } catch (error) {
      console.error('[AfDBScraper] Fetch error:', error);
      throw error;
    }
  }

  /**
   * Normalize AfDB job to standard format
   */
  normalize(job: AfDBJob): RawOpportunity {
    const country = this.extractCountry(job.location);
    const remote = this.isRemote(job.location) || this.isRemote(job.description || '');

    return {
      title: this.cleanText(job.title),
      organization: 'African Development Bank',
      country: country,
      region: this.extractRegion(job.location),
      type: this.determineType(job.title, job.description || ''),
      remote: remote,
      description: job.description 
        ? this.cleanText(job.description)
        : `${job.title} at African Development Bank. Grade: ${job.grade}`,
      requirements: this.extractRequirements(job.description || ''),
      salary: this.extractSalary(job.grade),
      deadline: this.parseDate(job.deadline),
      sourceUrl: job.url
    };
  }

  /**
   * Extract country from location
   */
  private extractCountry(location: string): string {
    const africanCountries = [
      'Kenya', 'Nigeria', 'South Africa', 'Ghana', 'Egypt',
      'Rwanda', 'Uganda', 'Tanzania', 'Ethiopia', 'Morocco',
      'Tunisia', 'Senegal', 'Côte d\'Ivoire', 'Zimbabwe',
      'Mozambique', 'Angola', 'Zambia', 'Cameroon', 'Sudan'
    ];

    // Headquarters locations
    if (location.includes('Abidjan')) return 'Côte d\'Ivoire';
    if (location.includes('Tunis')) return 'Tunisia';

    for (const country of africanCountries) {
      if (location.includes(country)) {
        return country;
      }
    }

    return location || 'Côte d\'Ivoire'; // Default to HQ
  }

  /**
   * Extract region from location
   */
  private extractRegion(location: string): string | undefined {
    const cities = ['Abidjan', 'Tunis', 'Nairobi', 'Lagos', 'Cairo', 'Johannesburg'];
    
    for (const city of cities) {
      if (location.includes(city)) {
        return city;
      }
    }

    return undefined;
  }

  /**
   * Determine opportunity type
   */
  private determineType(
    title: string, 
    description: string
  ): 'job' | 'fellowship' | 'consultancy' | 'grant' | 'tender' {
    const text = `${title} ${description}`.toLowerCase();

    if (text.includes('consultant') || text.includes('consultancy')) {
      return 'consultancy';
    }

    if (text.includes('fellow') || text.includes('fellowship')) {
      return 'fellowship';
    }

    return 'job';
  }

  /**
   * Extract requirements from description
   */
  private extractRequirements(description: string): string | undefined {
    if (!description) return undefined;

    const requirementsMarkers = [
      'competencies:',
      'qualifications:',
      'requirements:',
      'education and experience:',
      'minimum requirements:'
    ];

    const lowerDesc = description.toLowerCase();
    
    for (const marker of requirementsMarkers) {
      const index = lowerDesc.indexOf(marker);
      if (index !== -1) {
        const endMarkers = ['responsibilities:', 'duties:', 'about the role:', 'selection criteria:'];
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

  /**
   * Extract salary information from grade
   */
  private extractSalary(grade: string): string | undefined {
    if (!grade) return undefined;

    // AfDB typically uses grades like PL3, PL4, EL6, etc.
    // Map to approximate salary ranges (public information)
    const salaryMap: Record<string, string> = {
      'PL3': '$60,000 - $80,000',
      'PL4': '$80,000 - $100,000',
      'PL5': '$100,000 - $120,000',
      'EL6': '$120,000 - $150,000',
      'EL7': '$150,000 - $180,000',
      'VP': '$180,000+'
    };

    for (const [gradeLevel, salary] of Object.entries(salaryMap)) {
      if (grade.toUpperCase().includes(gradeLevel)) {
        return salary;
      }
    }

    return undefined;
  }
}
