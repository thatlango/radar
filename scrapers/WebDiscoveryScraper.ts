import { PrismaClient } from '@prisma/client';
import { BaseScraper, RawOpportunity, ScraperConfig } from './BaseScraper';
import { buildDiscoveryQueries, getScanProfile, RADAR_SOURCE_CATALOG } from './scanProfiles';

const prisma = new PrismaClient();

type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
  sourceName?: string;
  domain?: string;
};

export class WebDiscoveryScraper extends BaseScraper {
  constructor(config: ScraperConfig) {
    super({ rateLimit: 80, timeout: 25000, ...config });
  }

  async fetch(): Promise<SearchResult[]> {
    const source = await prisma.scraperSource.findUnique({ where: { id: this.config.sourceId } });
    const config = (source?.config && typeof source.config === 'object' ? source.config : {}) as any;
    const profile = getScanProfile(config.scanProfile || 'consulting-firm');
    const activeUsers = await prisma.user.findMany({
      where: { onboardingComplete: true, alerts: { some: { active: true } } },
      select: { parsedSkills: true, preferences: true },
      take: 20,
    });

    const personalised = activeUsers.flatMap((user) => {
      const prefs = user.preferences && typeof user.preferences === 'object' ? user.preferences as any : {};
      const intent = String(prefs.whatLookingFor || '').trim();
      if (!intent) return [];
      return buildDiscoveryQueries(profile, intent, user.parsedSkills || []).slice(0, 1);
    });

    const baseQueries = buildDiscoveryQueries(profile);
    const primaryDomains = RADAR_SOURCE_CATALOG.filter((s) => s.discovery === 'primary').map((s) => s.domain);
    const mandatoryDomains = ['linkedin.com', 'opportunitydesk.org', 'globalsouthopportunities.com'];
    const domainQueries = mandatoryDomains.map((domain) => `site:${domain} (${profile.keywords.slice(0, 8).join(' OR ')}) (consultancy OR tender OR opportunity OR RFP OR EOI)`);
    const sectorDomainQueries = primaryDomains
      .filter((domain) => !mandatoryDomains.includes(domain))
      .slice(0, 9)
      .map((domain) => `site:${domain} (${profile.keywords.slice(0, 6).join(' OR ')}) (consultancy OR tender OR RFP OR EOI)`);

    const maxQueries = Math.max(4, Math.min(24, Number(process.env.RADAR_DISCOVERY_MAX_QUERIES || 14)));
    const queries = [...domainQueries, ...baseQueries, ...personalised, ...sectorDomainQueries]
      .filter((value, index, self) => value && self.indexOf(value) === index)
      .slice(0, maxQueries);

    const all: SearchResult[] = [];
    for (const query of queries) {
      try {
        const results = await this.search(query);
        all.push(...results);
      } catch (error) {
        console.error('[WebDiscoveryScraper] Query failed:', query, error);
      }
      await this.sleep(120);
    }

    const byUrl = new Map<string, SearchResult>();
    for (const item of all) {
      if (!item.url || byUrl.has(item.url)) continue;
      byUrl.set(item.url, item);
    }
    return [...byUrl.values()].slice(0, Math.max(40, Number(process.env.RADAR_DISCOVERY_MAX_RESULTS || 120)));
  }

  normalize(item: SearchResult): RawOpportunity {
    const title = this.cleanText(item.title || 'Opportunity');
    const description = this.cleanText(item.snippet || title);
    const domain = this.domainOf(item.url);
    const sourceMeta = RADAR_SOURCE_CATALOG.find((source) => domain.includes(source.domain));
    const organization = this.inferOrganization(title, description, sourceMeta?.name || item.sourceName || domain);
    const deadline = this.extractDeadline(`${title} ${description}`);
    const country = this.inferCountry(`${title} ${description}`);
    const type = this.inferType(`${title} ${description}`);

    return {
      title,
      organization,
      country,
      type,
      remote: this.isRemote(`${title} ${description}`),
      description,
      deadline,
      sourceUrl: item.url,
    };
  }

  private async search(query: string): Promise<SearchResult[]> {
    if (process.env.BRAVE_SEARCH_API_KEY) return this.searchBrave(query);
    if (process.env.SERPER_API_KEY) return this.searchSerper(query);
    throw new Error('Cross-source discovery requires BRAVE_SEARCH_API_KEY or SERPER_API_KEY.');
  }

  private async searchBrave(query: string): Promise<SearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', '10');
    url.searchParams.set('freshness', 'pm');
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': String(process.env.BRAVE_SEARCH_API_KEY) },
      signal: AbortSignal.timeout(this.config.timeout || 25000),
    });
    if (!response.ok) throw new Error(`Brave Search returned ${response.status}`);
    const payload: any = await response.json();
    return (payload?.web?.results || []).map((row: any) => ({
      title: row.title || '', url: row.url || '', snippet: row.description || '', domain: this.domainOf(row.url || ''),
    }));
  }

  private async searchSerper(query: string): Promise<SearchResult[]> {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-KEY': String(process.env.SERPER_API_KEY) },
      body: JSON.stringify({ q: query, num: 10, tbs: 'qdr:m' }),
      signal: AbortSignal.timeout(this.config.timeout || 25000),
    });
    if (!response.ok) throw new Error(`Serper returned ${response.status}`);
    const payload: any = await response.json();
    return (payload?.organic || []).map((row: any) => ({
      title: row.title || '', url: row.link || '', snippet: row.snippet || '', domain: this.domainOf(row.link || ''),
    }));
  }

  private domainOf(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
  }

  private inferOrganization(title: string, text: string, fallback: string): string {
    const separators = [' — ', ' - ', ' | ', ': '];
    for (const separator of separators) {
      const parts = title.split(separator).map((part) => part.trim()).filter(Boolean);
      if (parts.length >= 2 && parts[0].length < 90) {
        const likelyOrg = parts.find((part) => /UNDP|UNICEF|GIZ|World Bank|IFC|AfDB|Enabel|Mercy|Oxfam|Save the Children|ILO|UNIDO|IUCN|Swisscontact|TechnoServe|Ministry|Foundation|Alliance|Network|Council|Bank/i.test(part));
        if (likelyOrg) return likelyOrg.slice(0, 180);
      }
    }
    const match = text.match(/(?:by|from|at|organisation|organization|client)\s+([A-Z][A-Za-z0-9& .'-]{2,70})/);
    return (match?.[1] || fallback || 'Opportunity issuer').trim().slice(0, 180);
  }

  private inferType(text: string): RawOpportunity['type'] {
    const lower = text.toLowerCase();
    if (/tender|request for proposal|\brfp\b|expression of interest|\beoi\b|procurement/.test(lower)) return 'tender';
    if (/grant|call for proposals|funding opportunity/.test(lower)) return 'grant';
    if (/fellowship|scholarship/.test(lower)) return 'fellowship';
    if (/consultant|consultancy|technical assistance|advisory/.test(lower)) return 'consultancy';
    return 'job';
  }

  private inferCountry(text: string): string {
    const countries = [
      'Uganda','Kenya','Rwanda','Tanzania','Ethiopia','South Sudan','Sudan','Somalia','Burundi','DRC','Congo',
      'Mozambique','Zambia','Zimbabwe','Malawi','Ghana','Nigeria','Senegal','South Africa','Egypt','Cameroon','Guinea',
      'Liberia','Sierra Leone','Djibouti','Eritrea','Madagascar','Botswana','Namibia','Lesotho','Eswatini','Morocco','Tunisia',
    ];
    const found = countries.find((country) => new RegExp(`\\b${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
    if (found) return found;
    if (/east africa/i.test(text)) return 'East Africa';
    if (/africa-wide|across africa|african countries|pan-african/i.test(text)) return 'Africa';
    if (/remote|global|worldwide|international/i.test(text)) return 'Remote / Global';
    return 'Africa / Global';
  }

  private extractDeadline(text: string): Date | undefined {
    const monthPattern = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
    const patterns = [
      new RegExp(`(?:deadline|closes?|due|apply by|submission)[:\\s-]*(\\d{1,2})[ /-]?${monthPattern}[ ,/-]*(20\\d{2})`, 'i'),
      new RegExp(`(?:deadline|closes?|due|apply by|submission)[:\\s-]*${monthPattern}[ /-]?(\\d{1,2})[ ,/-]*(20\\d{2})`, 'i'),
      /(?:deadline|closes?|due|apply by|submission)[:\s-]*(20\d{2})-(\d{1,2})-(\d{1,2})/i,
    ];
    for (const [index, pattern] of patterns.entries()) {
      const match = text.match(pattern);
      if (!match) continue;
      let candidate = '';
      if (index === 0) candidate = `${match[1]} ${match[2]} ${match[3]}`;
      else if (index === 1) candidate = `${match[2]} ${match[1]} ${match[3]}`;
      else candidate = `${match[1]}-${match[2]}-${match[3]}`;
      const date = new Date(candidate);
      if (!Number.isNaN(date.getTime())) return date;
    }
    return undefined;
  }
}
