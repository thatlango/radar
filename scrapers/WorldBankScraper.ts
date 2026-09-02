import axios from 'axios';
import * as cheerio from 'cheerio';
import { BaseScraper, RawOpportunity, ScraperConfig } from './BaseScraper';

type WbNotice = {
  id: string; notice_type?: string; notice_status?: string; notice_lang_name?: string;
  submission_deadline_date?: string; project_ctry_name?: string; project_id?: string; project_name?: string;
  bid_reference_no?: string; bid_description?: string; procurement_group?: string;
  procurement_method_code?: string; procurement_method_name?: string; contact_organization?: string;
  notice_text?: string; submission_date?: string;
};

export class WorldBankScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 25, timeout: 25000, ...config }); }

  async fetch(): Promise<WbNotice[]> {
    const response = await axios.get('https://search.worldbank.org/api/v2/procnotices', {
      params: { format: 'json', rows: Number(process.env.RADAR_WORLDBANK_LIMIT || 150), os: 0 },
      timeout: this.config.timeout,
      headers: { 'User-Agent': 'Radar/1.0 (+https://radar.tukutuku.org)', Accept: 'application/json' },
    });
    const rows: WbNotice[] = response.data?.procnotices || [];
    const now = Date.now();
    return rows.filter((row) => {
      if (row.notice_status && !/published/i.test(row.notice_status)) return false;
      if (row.notice_lang_name && !/english/i.test(row.notice_lang_name)) return false;
      if (!row.bid_description?.trim()) return false;
      const deadline = row.submission_deadline_date ? new Date(row.submission_deadline_date).getTime() : 0;
      return !deadline || deadline >= now - 86400000;
    });
  }

  normalize(row: WbNotice): RawOpportunity {
    const text = cheerio.load(String(row.notice_text || '')).text().replace(/\s+/g, ' ').trim();
    const method = `${row.procurement_group || ''} ${row.procurement_method_code || ''} ${row.procurement_method_name || ''} ${row.notice_type || ''}`;
    const consultancy = /consult|quality.?cost|individual|technical assistance|\bcs\b/i.test(method);
    const sourceUrl = `https://projects.worldbank.org/en/projects-operations/procurement-detail/${encodeURIComponent(row.id)}`;
    return {
      title: this.cleanText(row.bid_description || row.project_name || 'World Bank procurement notice'),
      organization: this.cleanText(row.contact_organization || 'World Bank-financed project'),
      country: this.cleanText(row.project_ctry_name || 'Global'),
      type: consultancy ? 'consultancy' : 'tender',
      remote: this.isRemote(text),
      description: this.cleanText(`${row.project_name || ''}. ${method}. ${text}`).slice(0, 30000),
      requirements: row.bid_reference_no ? `Reference: ${row.bid_reference_no}` : undefined,
      deadline: row.submission_deadline_date ? new Date(row.submission_deadline_date) : undefined,
      sourceUrl,
      source: 'World Bank Procurement Notices',
    };
  }
}
