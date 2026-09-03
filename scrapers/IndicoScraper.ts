import axios from 'axios';
import * as cheerio from 'cheerio';
import { BaseScraper, RawOpportunity, ScraperConfig } from './BaseScraper';

type IndicoEvent = { title: string; url: string; html?: string };
type EventSchema = { name?: string; description?: string; startDate?: string; endDate?: string; url?: string; location?: { name?: string; address?: string } };

const CONFERENCE_SIGNAL = /\b(conference|summit|forum|symposium|congress|expo|colloquium)\b/i;
const OPEN_REGISTRATION = /registration for this event is currently open|registration is currently open|applications? (?:are|is) (?:currently )?open|apply now|register now/i;

export class IndicoScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 80, timeout: 25000, maxRetries: 2, ...config }); }

  async fetch(): Promise<IndicoEvent[]> {
    const months: string[] = [];
    const cursor = new Date();
    cursor.setUTCDate(1);
    for (let i = 0; i < 3; i++) {
      const value = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + i, 1));
      months.push(value.toISOString().slice(0, 10));
    }
    const found = new Map<string, IndicoEvent>();
    for (const date of months) {
      const url = `https://indico.un.org/category/0/overview?date=${date}&openonly=false&period=month`;
      const response = await axios.get(url, { timeout: this.config.timeout, responseType: 'text', headers: { 'User-Agent': 'Radar/1.0 (+https://radar.tukutuku.org)', Accept: 'text/html,application/xhtml+xml' } });
      const $ = cheerio.load(String(response.data || ''));
      $('tr.event td.title a[href^="/event/"]').each((_i, el) => {
        const title = this.cleanText($(el).text());
        const href = String($(el).attr('href') || '');
        if (!title || !CONFERENCE_SIGNAL.test(title) || !/^\/event\/\d+\/?$/.test(href)) return;
        const eventUrl = new URL(href, 'https://indico.un.org').toString();
        if (!found.has(eventUrl)) found.set(eventUrl, { title, url: eventUrl });
      });
      await this.sleep(120);
    }
    const candidates = [...found.values()].slice(0, 70);
    const open: IndicoEvent[] = [];
    for (const candidate of candidates) {
      try {
        const response = await axios.get(candidate.url, { timeout: this.config.timeout, responseType: 'text', headers: { 'User-Agent': 'Radar/1.0 (+https://radar.tukutuku.org)', Accept: 'text/html,application/xhtml+xml' } });
        const plain = this.cleanText(String(response.data || ''));
        if (OPEN_REGISTRATION.test(plain)) open.push({ ...candidate, html: String(response.data || '') });
      } catch (error: any) {
        console.warn(`[IndicoScraper] event check failed ${candidate.url}: ${error?.message || error}`);
      }
      await this.sleep(70);
    }
    return open.slice(0, 50);
  }

  normalize(item: IndicoEvent): RawOpportunity {
    const html = String(item.html || '');
    const $ = cheerio.load(html);
    let schema: EventSchema = {};
    const rawSchema = $('script[type="application/ld+json"]').first().text().trim();
    try { schema = rawSchema ? JSON.parse(rawSchema) : {}; } catch { schema = {}; }
    const plain = this.cleanText($.root().text());
    const action = $('a').toArray().find((el) => /^(register now|apply now)$/i.test(this.cleanText($(el).text())));
    const href = action ? String($(action).attr('href') || '') : '';
    const applicationUrl = href ? new URL(href, item.url).toString() : /apply now|register now/i.test(plain) ? item.url : undefined;
    const title = this.cleanText(schema.name || item.title);
    const description = this.cleanText(schema.description || plain).slice(0, 30000);
    const location = this.cleanText(`${schema.location?.name || ''} ${schema.location?.address || ''}`);
    const country = this.inferCountry(location) || this.inferCountry(title) || this.inferCountry(description) || (/online|virtual/i.test(plain) ? 'Remote / Global' : 'Global');
    const start = schema.startDate ? new Date(schema.startDate) : undefined;
    const end = schema.endDate ? new Date(schema.endDate) : undefined;
    const dateText = [start, end].filter((x): x is Date => Boolean(x && !Number.isNaN(x.getTime()))).map((x) => x.toISOString()).join(' to ');
    return {
      title,
      organization: 'United Nations / Indico.UN',
      country,
      type: 'conference',
      remote: /online|virtual|hybrid/i.test(plain),
      description: this.cleanText(`${description}${dateText ? ` Event dates: ${dateText}.` : ''}${location ? ` Location: ${location}.` : ''}`).slice(0, 30000),
      sourceUrl: item.url,
      source: 'UN Conferences & Participation',
      applicationUrl,
      applicationInstructions: applicationUrl ? 'Registration is open on the official UN Indico event page.' : undefined,
    };
  }

  async run(): Promise<{ success: boolean; scraped: number; inserted: number; duplicates: number; errors: number }> {
    const startTime = Date.now();
    const raw = await this.fetch();
    const results = { success: true, scraped: raw.length, inserted: 0, duplicates: 0, errors: 0 };
    for (const item of raw) {
      try {
        const normalized = this.normalize(item);
        if (!this.validate(normalized)) { results.errors++; continue; }
        const inserted = await this.persist(normalized);
        inserted ? results.inserted++ : results.duplicates++;
      } catch (error) { results.errors++; console.error('[IndicoScraper] normalize/persist failed', error); }
      await this.sleep(this.config.rateLimit || 80);
    }
    await this.updateSourceMetadata(results.inserted, results.errors === 0);
    console.log(`[IndicoScraper] completed in ${((Date.now() - startTime) / 1000).toFixed(2)}s`, results);
    return results;
  }

  private inferCountry(text: string): string {
    if (!text) return '';
    const cityHints: Array<[RegExp, string]> = [
      [/\b(BKK|Bangkok)\b/i, 'Thailand'], [/\bNairobi\b/i, 'Kenya'], [/\bAddis Ababa\b/i, 'Ethiopia'], [/\bGeneva\b/i, 'Switzerland'],
      [/\bBonn\b/i, 'Germany'], [/\bBaku\b/i, 'Azerbaijan'], [/\bDakar\b/i, 'Senegal'], [/\bKigali\b/i, 'Rwanda'], [/\bKampala\b/i, 'Uganda'],
    ];
    const hinted = cityHints.find(([pattern]) => pattern.test(text));
    if (hinted) return hinted[1];
    const countries = ['Uganda','Kenya','Rwanda','Tanzania','Ethiopia','South Sudan','Burundi','Democratic Republic of the Congo','DRC','Ghana','Nigeria','Senegal','South Africa','Egypt','Morocco','Tunisia','Zambia','Zimbabwe','Malawi','Mozambique','Cameroon','Côte d’Ivoire','Cote d Ivoire','Switzerland','France','Germany','Republic of Korea','Thailand','Azerbaijan','Japan','China','Indonesia','Philippines','India','United Arab Emirates'];
    const lower = text.toLowerCase();
    const found = countries.find((country) => lower.includes(country.toLowerCase()));
    if (found) return found === 'Democratic Republic of the Congo' ? 'DRC' : found;
    if (/africa|african/i.test(text)) return 'Africa';
    return '';
  }
}
