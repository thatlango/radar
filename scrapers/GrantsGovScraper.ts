import axios from "axios";
import { BaseScraper, RawOpportunity, ScraperConfig } from "./BaseScraper";

type GrantHit = { id: number | string; number?: string; title?: string; agency?: string; agencyName?: string; openDate?: string; closeDate?: string; oppStatus?: string; docType?: string; cfdaList?: string[] };

export class GrantsGovScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 30, timeout: 30000, ...config }); }
  async fetch(): Promise<GrantHit[]> {
    const response = await axios.post("https://api.grants.gov/v1/api/search2", {
      rows: Number(process.env.RADAR_GRANTSGOV_LIMIT || 120), oppStatuses: "posted", startRecordNum: 0,
    }, { timeout: this.config.timeout, headers: { "User-Agent": "Radar/1.0 (+https://radar.tukutuku.org)", Accept: "application/json", "Content-Type": "application/json" } });
    const now = Date.now();
    return (response.data?.data?.oppHits || []).filter((row: GrantHit) => {
      if (!row.title?.trim() || !row.id) return false;
      const deadline = row.closeDate ? new Date(row.closeDate).getTime() : 0;
      return !deadline || deadline >= now - 86400000;
    });
  }
  normalize(row: GrantHit): RawOpportunity {
    return {
      title: this.cleanText(row.title || "Federal funding opportunity"),
      organization: this.cleanText(row.agencyName || row.agency || "U.S. Federal Government"),
      country: "Global",
      type: "grant",
      remote: false,
      description: this.cleanText(`Opportunity number: ${row.number || "not stated"}. Agency: ${row.agencyName || row.agency || "not stated"}. Status: ${row.oppStatus || "posted"}. Assistance listings: ${(row.cfdaList || []).join(", ") || "not stated"}.`).slice(0, 12000),
      deadline: row.closeDate ? new Date(row.closeDate) : undefined,
      sourceUrl: `https://www.grants.gov/search-results-detail/${encodeURIComponent(String(row.id))}`,
      source: "Grants.gov",
    };
  }
}
