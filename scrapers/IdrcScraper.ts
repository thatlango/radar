import axios from "axios";
import * as cheerio from "cheerio";
import { BaseScraper, RawOpportunity, ScraperConfig } from "./BaseScraper";

type FundingRow = { title: string; url: string; callFor: string; deadline: string; description: string };
export class IdrcScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 25, timeout: 25000, ...config }); }
  async fetch(): Promise<FundingRow[]> {
    const response = await axios.get("https://idrc-crdi.ca/en/funding", { timeout: this.config.timeout, responseType: "text", headers: { "User-Agent": "Radar/1.0 (+https://radar.tukutuku.org)", Accept: "text/html" } });
    const $ = cheerio.load(String(response.data || "")); const rows: FundingRow[] = [];
    $(".views-row").each((_i, el) => {
      const row = $(el); const link = row.find(".views-field-title a[href*=\"/funding/\"]").first(); const title = this.cleanText(link.text()); const deadline = String(row.find(".views-field-field-award-deadline time").attr("datetime") || ""); if (!title || !deadline) return;
      const date = new Date(deadline); if (Number.isNaN(date.getTime()) || date.getTime() < Date.now() - 86400000) return;
      rows.push({ title, url: new URL(String(link.attr("href")), "https://idrc-crdi.ca").toString(), callFor: this.cleanText(row.find(".views-field-field-award-call-for .field-content").text()), deadline, description: this.cleanText(row.text()) });
    });
    return rows.slice(0, Number(process.env.RADAR_IDRC_LIMIT || 80));
  }
  normalize(row: FundingRow): RawOpportunity {
    const fellowship = /fellowship|research award|scholarship|studentship/i.test(row.title);
    const country = /sub-saharan africa|africa|african/i.test(row.title) ? "Africa" : /global south/i.test(row.title) ? "Global South" : "Global";
    return { title: row.title, organization: "International Development Research Centre (IDRC)", country, type: fellowship ? "fellowship" : "grant", remote: false, description: this.cleanText(`${row.title}. Call for: ${row.callFor || "applications"}. ${row.description}`).slice(0, 12000), deadline: new Date(row.deadline), sourceUrl: row.url, source: "IDRC Funding" };
  }
}
