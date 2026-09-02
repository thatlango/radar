import axios from "axios";
import { BaseScraper, RawOpportunity, ScraperConfig } from "./BaseScraper";

type UnPartnerRow = { id?: number; displayID?: string; title?: string; countries?: string[]; agency_name?: string; specializations?: Array<{ name?: string; category?: string }>; deadline_date?: string; pdf_export_url?: string; date_created?: string };

export class UnPartnerScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 30, timeout: 25000, ...config }); }
  async fetch(): Promise<UnPartnerRow[]> {
    let url: string | null = "https://www.unpartnerportal.org/api/public/projects/";
    const rows: UnPartnerRow[] = [];
    while (url && rows.length < Number(process.env.RADAR_UNPARTNER_LIMIT || 160)) {
      const response = await axios.get(url, { timeout: this.config.timeout, headers: { "User-Agent": "Radar/1.0 (+https://radar.tukutuku.org)", Accept: "application/json" } });
      rows.push(...(response.data?.results || []));
      url = response.data?.next ? String(response.data.next) : null;
    }
    const now = Date.now();
    return rows.filter((row) => row.title?.trim() && (!row.deadline_date || new Date(row.deadline_date).getTime() >= now - 86400000));
  }
  normalize(row: UnPartnerRow): RawOpportunity {
    const countries = Array.isArray(row.countries) ? row.countries.filter(Boolean) : [];
    const specializations = (row.specializations || []).map((item) => item.name || item.category).filter(Boolean);
    const pdf = row.pdf_export_url ? new URL(row.pdf_export_url, "https://www.unpartnerportal.org").toString() : "https://www.unpartnerportal.org/landing/opportunities/";
    return {
      title: this.cleanText(row.title || "UN partnership opportunity"),
      organization: this.cleanText(row.agency_name || "United Nations"),
      country: this.cleanText(countries.join(", ") || "Global"),
      type: "grant",
      remote: false,
      description: this.cleanText(`UN Partner Portal partnership opportunity${row.displayID ? ` ${row.displayID}` : ""}. Countries: ${countries.join(", ") || "not stated"}. Thematic areas: ${specializations.join(", ") || "not stated"}.`).slice(0, 12000),
      requirements: specializations.length ? `Specializations: ${specializations.join(", ")}` : undefined,
      deadline: row.deadline_date ? new Date(row.deadline_date) : undefined,
      sourceUrl: pdf,
      source: "UN Partner Portal",
    };
  }
}
