import axios from 'axios';
import { BaseScraper, RawOpportunity, ScraperConfig } from './BaseScraper';

type GppNotice = {
  id: number; title: string; estimatedValue?: number; entity?: string; sector?: string;
  procurement_type?: string; deadline?: string; financial_year?: string;
};

export class UgandaGppScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 25, timeout: 30000, ...config }); }

  async fetch(): Promise<GppNotice[]> {
    const base = 'https://cdn.ppda.go.ug/api';
    let years: string[] = [];
    try {
      const response = await axios.get(`${base}/planning/financial-years`, { timeout: 12000, headers: { 'User-Agent': 'Radar/1.0 (+https://radar.tukutuku.org)', Accept: 'application/json' } });
      years = (response.data?.data || []).map((x: any) => String(x.financial_year || '')).filter(Boolean).slice(0, 2);
    } catch { years = []; }
    if (!years.length) years = ['2026-2027', '2025-2026'];

    const all: GppNotice[] = [];
    for (const fy of years) {
      try {
        const response = await axios.get(`${base}/tender/notices`, {
          params: { fy }, timeout: this.config.timeout,
          headers: { 'User-Agent': 'Radar/1.0 (+https://radar.tukutuku.org)', Accept: 'application/json' },
        });
        all.push(...(response.data?.data || []));
      } catch (error: any) {
        console.warn(`[UgandaGppScraper] ${fy} fetch failed: ${error?.message || error}`);
      }
    }
    const now = Date.now();
    const byId = new Map<number, GppNotice>();
    for (const row of all) {
      if (!row?.id || !row.title?.trim()) continue;
      const deadline = row.deadline ? new Date(row.deadline.replace(' ', 'T') + 'Z').getTime() : 0;
      if (deadline && deadline < now - 86400000) continue;
      byId.set(row.id, row);
    }
    return [...byId.values()].sort((a, b) => new Date(b.deadline || 0).getTime() - new Date(a.deadline || 0).getTime()).slice(0, Number(process.env.RADAR_GPP_LIMIT || 200));
  }

  normalize(row: GppNotice): RawOpportunity {
    const title = this.cleanText(row.title);
    const procurementType = String(row.procurement_type || '');
    const classificationText = `${title} ${procurementType}`;
    const consultancy = /consult/i.test(classificationText);
    const supply = /\b(supplies|goods)\b/i.test(procurementType) || /\bsupply (?:and delivery |and installation )?of\b|\bprocurement of .{0,60}\b(equipment|goods|materials|stationery|furniture|vehicles?|fuel)\b/i.test(title);
    const deadline = row.deadline ? new Date(row.deadline.replace(' ', 'T') + 'Z') : undefined;
    return {
      title,
      organization: this.cleanText(row.entity || 'Government of Uganda'),
      country: 'Uganda',
      type: consultancy ? 'consultancy' : supply ? 'supply' : 'tender',
      remote: false,
      description: this.cleanText(`${title}. Procurement type: ${procurementType || 'not stated'}. Sector: ${row.sector || 'not stated'}. Financial year: ${row.financial_year || 'not stated'}.`).slice(0, 12000),
      salary: row.estimatedValue ? `UGX ${Number(row.estimatedValue).toLocaleString('en-US')}` : undefined,
      deadline,
      sourceUrl: `https://gpp.ppda.go.ug/public/bid-invitations/tender-notice/${row.id}`,
      source: 'Uganda Government Procurement Portal',
    };
  }
}
