import axios from 'axios';
import * as cheerio from 'cheerio';
import { PrismaClient } from '@prisma/client';
import { BaseScraper, RawOpportunity, ScraperConfig } from './BaseScraper';

const prisma = new PrismaClient();
type PageItem = { title: string; url: string; snippet: string };
const OPPORTUNITY_RE = /consult|tender|procurement|expression of interest|\beoi\b|request for proposal|\brfp\b|request for quotation|\brfq\b|bid|supplier|vendor|pre-?qualification|supply|goods|grant|funding|vacanc|job|fellowship|conference|summit|symposium|call for (?:papers|abstracts|participants|speakers)|travel grant|call for proposal|technical assistance|framework contract|roster|invitation to tender/i;
const GENERIC_TITLE = /^(home|about|contact|login|register|search|download|learn more|read more|next|previous|page\s*\d+|procurement plans|registered providers|signed contracts|open data|tenders?|bids?\s*\/\s*procurement|procurement|open tenders?|archived tenders?|subscribe to receive email alerts|receive funding)$/i;

export class PublicPageScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 60, timeout: 22000, ...config }); }

  async fetch(): Promise<PageItem[]> {
    const source = await prisma.scraperSource.findUnique({ where: { id: this.config.sourceId } });
    const config = (source?.config && typeof source.config === 'object' ? source.config : {}) as any;
    const pages = Array.isArray(config.pages) && config.pages.length ? config.pages : [source?.baseUrl].filter(Boolean);
    const all: PageItem[] = [];
    const add = (rawTitle: string, rawHref: string, snippet: string, page: string) => {
      let title = this.cleanText(rawTitle).replace(/^Deadline:\s*\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}\s*/i, '').trim();
      if (!title || title.length < 5 || GENERIC_TITLE.test(title)) return;
      if (config.requireOpportunityKeyword !== false && !OPPORTUNITY_RE.test(`${title} ${snippet}`)) return;
      if (/\b(202[0-5])\b/.test(`${title} ${snippet}`) && !/\b2026\b/.test(`${title} ${snippet}`) && !this.extractDeadline(`${title} ${snippet}`)) return;
      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('mailto:') || rawHref.startsWith('javascript:')) return;
      let url = ''; try { url = new URL(rawHref, page).toString(); } catch { return; }
      if (new URL(url).toString().replace(/\/$/,'') === new URL(page).toString().replace(/\/$/,'')) return;
      const includes = Array.isArray(config.urlIncludes) ? config.urlIncludes.filter(Boolean).map(String) : [];
      if (includes.length && !includes.some((needle: string) => url.includes(needle))) return;
      title = title.replace(/\s+(?:[\w-]+\.(?:pdf|zip|docx?|xlsx?)).*$/i, '').trim().slice(0, 320);
      all.push({ title, url, snippet: this.cleanText(snippet).slice(0, 5000) });
    };

    for (const pageValue of pages.slice(0, 8)) {
      const page = String(pageValue);
      const response = await axios.get(page, { timeout: this.config.timeout, responseType: 'text', maxRedirects: 5, headers: { 'User-Agent': 'Radar/1.0 (+https://radar.tukutuku.org)', Accept: 'text/html,application/xhtml+xml' } });
      const $ = cheerio.load(String(response.data || ''));

      // Structured cards/rows first. This captures GIZ tender cards where the actual file link has no anchor text.
      $('article,.list-item--job,tr,li').each((_index, element) => {
        const block = $(element); const text = this.cleanText(block.text());
        if (text.length < 20 || !OPPORTUNITY_RE.test(text)) return;
        const deadline = this.extractDeadline(text);
        if (deadline && deadline.getTime() < Date.now() - 86400000) return;
        const anchors = block.find('a[href]').toArray();
        const preferred = anchors.find((node) => /\.(?:pdf|zip|docx?|xlsx?)(?:\?|$)/i.test(String($(node).attr('href') || '')))
          || anchors.find((node) => !GENERIC_TITLE.test(this.cleanText($(node).text()))) || anchors[0];
        if (!preferred) return;
        const heading = this.cleanText(block.find('h1,h2,h3,h4,h5,.title,.job-title').first().text());
        const title = heading || text.slice(0, 300);
        add(title, String($(preferred).attr('href') || ''), text, page);
      });

      $('a[href]').each((_index, element) => {
        const anchor = $(element); const title = this.cleanText(anchor.text());
        const parentText = this.cleanText(anchor.closest('article,li,tr,.list-item--job,div').first().text()).slice(0, 2400); const snippet = parentText || title;
        add(title, String(anchor.attr('href') || ''), snippet, page);
      });
      await this.sleep(150);
    }
    const unique = new Map<string, PageItem>(); for (const item of all) if (!unique.has(item.url)) unique.set(item.url, item);
    return [...unique.values()].slice(0, Math.max(20, Math.min(180, Number(config.limit || 100))));
  }

  normalize(item: PageItem): RawOpportunity {
    const source: any = (this as any).__radarSource; const text = this.cleanText(`${item.title} ${item.snippet}`); const config: any = source?.config || {};
    const inferredType = this.inferType(text);
    const type = inferredType === 'job' && config.defaultType ? config.defaultType : inferredType;
    return { title: this.cleanText(item.title), organization: String(config.organization || source?.name || 'Opportunity issuer').slice(0, 180), country: String(config.defaultCountry || this.inferCountry(text)), type: type as RawOpportunity['type'], remote: this.isRemote(text), description: text.slice(0, 12000), deadline: this.extractDeadline(text), sourceUrl: item.url, source: source?.name || 'Public opportunity page' };
  }
  async run(): Promise<{ success: boolean; scraped: number; inserted: number; duplicates: number; errors: number }> { (this as any).__radarSource = await prisma.scraperSource.findUnique({ where: { id: this.config.sourceId } }); return super.run(); }
  private inferType(text: string): RawOpportunity['type'] { const lower=text.toLowerCase(); if (/conference|summit|symposium|call for (?:papers|abstracts|participants|speakers)|conference travel|delegate application/.test(lower)) return 'conference'; if (/consultant|consultancy|technical assistance|advisor|advisory/.test(lower)) return 'consultancy'; if (/supplier|vendor pre-?qualification|supply of|supplies|procurement of goods|goods and services|equipment|materials|stationery|furniture|vehicles?|fuel/.test(lower)) return 'supply'; if (/tender|procurement|expression of interest|\beoi\b|request for proposal|\brfp\b|request for quotation|\brfq\b|invitation for bids?|framework contract/.test(lower)) return 'tender'; if (/grant|funding|call for proposals|challenge fund/.test(lower)) return 'grant'; if (/fellowship|scholarship|training/.test(lower)) return 'fellowship'; return 'job'; }
  private inferCountry(text: string): string { const countries=['Uganda','Kenya','Rwanda','Tanzania','Ethiopia','South Sudan','Somalia','Burundi','DRC','Congo','Mozambique','Zambia','Zimbabwe','Malawi','Ghana','Nigeria','Senegal','South Africa','Egypt','Cameroon','Guinea','Liberia','Sierra Leone','Djibouti','Madagascar','Botswana','Namibia','Morocco','Tunisia']; const lower=text.toLowerCase(); const found=countries.find(c=>lower.includes(c.toLowerCase())); if(found)return found;if(/east africa/i.test(text))return'East Africa';if(/africa/i.test(text))return'Africa';if(/remote|global|worldwide|international/i.test(text))return'Remote / Global';return'Africa / Global'; }
  private parseYear(v:string){const y=Number(v);return y<100?2000+y:y} private monthIndex(v:string){return ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(v.slice(0,3).toLowerCase())+1}
  private makeDate(d:string,m:string,y:string):Date|undefined{const month=/^\d+$/.test(m)?Number(m):this.monthIndex(m);const date=new Date(Date.UTC(this.parseYear(y),month-1,Number(d),23,59,59));return !month||Number.isNaN(date.getTime())?undefined:date}
  private extractDeadline(text:string):Date|undefined{const marker='(?:deadline|closes?|closing date|apply by|due|submission(?: date)?|bid expiry|bid closing)';let m=text.match(new RegExp(`${marker}[:\\s-]*(\\d{1,2})[.\\s/-](Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[.\\s,/-]*(\\d{2,4})`,'i'));if(m)return this.makeDate(m[1],m[2],m[3]);m=text.match(new RegExp(`${marker}[:\\s-]*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[.\\s/-]*(\\d{1,2})[.\\s,/-]*(\\d{2,4})`,'i'));if(m)return this.makeDate(m[2],m[1],m[3]);m=text.match(new RegExp(`${marker}[:\\s-]*(\\d{1,2})[.\\/-](\\d{1,2})[.\\/-](\\d{2,4})`,'i'));if(m)return this.makeDate(m[1],m[2],m[3]);m=text.match(new RegExp(`${marker}[:\\s-]*(20\\d{2})-(\\d{1,2})-(\\d{1,2})`,'i'));if(m)return this.makeDate(m[3],m[2],m[1]);return undefined;}
}
