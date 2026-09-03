import axios from 'axios';
import * as cheerio from 'cheerio';
import { BaseScraper, RawOpportunity, ScraperConfig } from './BaseScraper';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
type FeedItem = { title: string; url: string; description: string; publishedAt?: string };

const OPPORTUNITY_SIGNAL = /\b(apply|application(?:s)?(?: are)? open|call for|deadline|fellowship|scholarship|grant|funding|funded|prize|award|competition|challenge|accelerator|incubator|cohort|internship|trainee(?:ship)?|vacanc(?:y|ies)|hiring|recruit(?:ment|ing)?|consultant|consultancy|tender|procurement|request for proposal|\brfp\b|expression of interest|\beoi\b|request for quotation|\brfq\b|bid invitation|call for proposals?|open call|conference|summit|symposium|call for papers?|call for abstracts?|call for participants?|call for speakers?|travel grant|delegate application|supplier|vendor|pre-?qualification|supply of|supplies|goods|residency|young professionals? program|programme)\b/i;
const ACTIONABLE_SIGNAL = /\b(apply now|apply by|applications?(?: are| is)? open|application deadline|registration(?: is)? open|register now|call for (?:applications?|proposals?|papers?|abstracts?|participants?|speakers?)|submission deadline|deadline|vacanc(?:y|ies)|hiring|recruit(?:ment|ing)|request for proposals?|request for quotations?|expression of interest|invitation to bid|bid invitation|tender notice|supplier pre-?qualification|vendor pre-?qualification)\b/i;
const EDITORIAL_SIGNAL = /\b(opinion|analysis|explainer|how to|why |what we learned|daily newsletter|weekly newsletter|market update|interview with|podcast)\b/i;

export class RssFeedScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 40, timeout: 20000, ...config }); }

  async fetch(): Promise<FeedItem[]> {
    const source = await prisma.scraperSource.findUnique({ where: { id: this.config.sourceId } });
    const config = (source?.config && typeof source.config === 'object' ? source.config : {}) as any;
    const feedUrl = String(config.feedUrl || source?.baseUrl || '').trim();
    if (!feedUrl) throw new Error(`RSS source ${source?.name || this.config.sourceId} has no feedUrl.`);

    const response = await axios.get(feedUrl, {
      timeout: this.config.timeout, responseType: 'text',
      headers: { 'User-Agent': 'Radar/1.0 (+https://radar.tukutuku.org)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    });
    const $ = cheerio.load(String(response.data || ''), { xmlMode: true });
    const rows: FeedItem[] = [];
    const maxAgeMs = Math.max(14, Math.min(365, Number(config.maxAgeDays || 75))) * 86400000;
    $('item, entry').each((_index, element) => {
      const node = $(element);
      const title = node.find('title').first().text().trim();
      const atomLink = node.find('link').first().attr('href');
      const rssLink = node.find('link').first().text().trim();
      const url = atomLink || rssLink || node.find('guid').first().text().trim();
      const description = [node.find('description').first().text(), node.find('summary').first().text(), node.find('content\\:encoded').first().text()].filter(Boolean).join(' ');
      const publishedAt = node.find('pubDate').first().text().trim() || node.find('published').first().text().trim() || node.find('updated').first().text().trim();
      if (!title || !url) return;
      if (publishedAt) { const when = new Date(publishedAt).getTime(); if (Number.isFinite(when) && when < Date.now() - maxAgeMs) return; }
      const text = this.cleanText(`${title} ${description}`);
      const signalText = config.opportunityMode === 'title-actionable' ? this.cleanText(title) : text;
      const signal = ['actionable-only', 'title-actionable'].includes(config.opportunityMode) ? ACTIONABLE_SIGNAL : OPPORTUNITY_SIGNAL;
      if (config.strictOpportunityFilter !== false && !signal.test(signalText)) return;
      if (EDITORIAL_SIGNAL.test(title) && !/apply|call for|grant|funding|fellowship|scholarship|tender|consult|conference|summit|symposium|supplier|supply/i.test(title)) return;
      rows.push({ title, url, description, publishedAt });
    });
    return rows.slice(0, Math.max(20, Math.min(160, Number(config.limit || 80))));
  }

  normalize(item: FeedItem): RawOpportunity {
    const source: any = (this as any).__radarSource;
    const text = this.cleanText(`${item.title} ${item.description || ''}`);
    const defaultType = String(source?.config?.defaultType || '');
    return {
      title: this.cleanText(item.title),
      organization: String(source?.config?.organization || this.inferOrganization(`${item.title} — ${this.cleanText(item.description || '')}`) || source?.name || 'Opportunity issuer').slice(0, 180),
      country: String(source?.config?.defaultCountry || this.inferCountry(text)),
      type: (defaultType || this.inferType(text)) as RawOpportunity['type'],
      remote: this.isRemote(text), description: text.slice(0, 12000), deadline: this.extractDeadline(text),
      sourceUrl: item.url, source: source?.name || 'RSS feed',
    };
  }

  async run(): Promise<{ success: boolean; scraped: number; inserted: number; duplicates: number; errors: number }> {
    (this as any).__radarSource = await prisma.scraperSource.findUnique({ where: { id: this.config.sourceId } });
    return super.run();
  }

  private inferType(text: string): RawOpportunity['type'] {
    const lower = text.toLowerCase();
    if (/conference|summit|symposium|call for (?:papers|abstracts|participants|speakers)|conference travel|delegate application/.test(lower)) return 'conference';
    if (/consultant|consultancy|technical assistance|advisor|advisory/.test(lower)) return 'consultancy';
    if (/supplier|vendor pre-?qualification|supply of|supplies|procurement of goods|goods and services|equipment|materials|stationery|furniture|vehicles?|fuel/.test(lower)) return 'supply';
    if (/tender|request for proposal|\brfp\b|expression of interest|\beoi\b|request for quotation|\brfq\b|procurement|bid invitation/.test(lower)) return 'tender';
    if (/grant|funding opportunity|call for proposals|challenge fund|innovation fund|award|prize/.test(lower)) return 'grant';
    if (/fellowship|scholarship|training|accelerator|incubator|cohort|residency/.test(lower)) return 'fellowship';
    return 'job';
  }

  private inferCountry(text: string): string {
    const countries = ['Uganda','Kenya','Rwanda','Tanzania','Ethiopia','South Sudan','Somalia','Burundi','DRC','Congo','Mozambique','Zambia','Zimbabwe','Malawi','Ghana','Nigeria','Senegal','South Africa','Egypt','Cameroon','Guinea','Liberia','Sierra Leone','Djibouti','Madagascar','Botswana','Namibia','Morocco','Tunisia'];
    const lower = text.toLowerCase(); const found = countries.find((country) => lower.includes(country.toLowerCase()));
    if (found) return found; if (/east africa/i.test(text)) return 'East Africa'; if (/africa-wide|across africa|pan-african|african countries/i.test(text)) return 'Africa'; if (/remote|global|worldwide|international/i.test(text)) return 'Remote / Global'; return 'Africa / Global';
  }

  private inferOrganization(title: string): string | undefined {
    const parts = title.split(/\s+[|–—-]\s+/).map((x) => x.trim()).filter(Boolean); return parts.length > 1 && parts[0].length < 100 ? parts[0] : undefined;
  }

  private parseYear(value: string): number { const y = Number(value); return y < 100 ? 2000 + y : y; }
  private monthIndex(value: string): number {
    const key = value.slice(0, 3).toLowerCase(); return ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(key) + 1;
  }
  private makeDate(day: string, month: string, year: string): Date | undefined {
    const m = /^\d+$/.test(month) ? Number(month) : this.monthIndex(month); const y = this.parseYear(year); const d = Number(day);
    if (!m || !d || y < 2020) return undefined; const date = new Date(Date.UTC(y, m - 1, d, 23, 59, 59)); return Number.isNaN(date.getTime()) ? undefined : date;
  }
  private extractDeadline(text: string): Date | undefined {
    const marker = '(?:deadline|closes?|closing date|apply by|due|submission(?: date)?)';
    let m = text.match(new RegExp(`${marker}[:\\s-]*(\\d{1,2})[.\\s/-](Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[.\\s,/-]*(\\d{2,4})`, 'i'));
    if (m) return this.makeDate(m[1], m[2], m[3]);
    m = text.match(new RegExp(`${marker}[:\\s-]*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[.\\s/-]*(\\d{1,2})[.\\s,/-]*(\\d{2,4})`, 'i'));
    if (m) return this.makeDate(m[2], m[1], m[3]);
    m = text.match(new RegExp(`${marker}[:\\s-]*(\\d{1,2})[.\\/-](\\d{1,2})[.\\/-](\\d{2,4})`, 'i'));
    if (m) return this.makeDate(m[1], m[2], m[3]);
    m = text.match(new RegExp(`${marker}[:\\s-]*(20\\d{2})-(\\d{1,2})-(\\d{1,2})`, 'i'));
    if (m) return this.makeDate(m[3], m[2], m[1]);
    return undefined;
  }
}
