import axios from "axios";
import * as cheerio from "cheerio";
import { BaseScraper, RawOpportunity, ScraperConfig } from "./BaseScraper";

type ChallengeRow = { title?: string; main_title?: string; url?: string; apply_link?: string; date?: number; date_end?: number; coming_soon?: boolean; hidden?: boolean; initiative_title?: string; opportunity_description_summary?: string; opportunity_description?: string };
export class GrandChallengesScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 25, timeout: 30000, ...config }); }
  async fetch(): Promise<ChallengeRow[]> {
    const response = await axios.get("https://www.grandchallenges.org/grant-opportunities", { timeout: this.config.timeout, responseType: "text", headers: { "User-Agent": "Radar/1.0 (+https://radar.tukutuku.org)", Accept: "text/html" }, maxContentLength: 20 * 1024 * 1024 });
    const $ = cheerio.load(String(response.data || "")); const raw = $("#__NEXT_DATA__").text(); if (!raw) throw new Error("Grand Challenges listing payload was not found.");
    const data = JSON.parse(raw); const rows: ChallengeRow[] = data?.props?.pageProps?.initialData?.listing?.data || []; const now = Date.now();
    return rows.filter((row) => !row.hidden && row.title && (!row.date_end || Number(row.date_end) * 1000 >= now - 86400000));
  }
  normalize(row: ChallengeRow): RawOpportunity {
    const description = this.cleanText(cheerio.load(String(row.opportunity_description_summary || row.opportunity_description || "")).text());
    const title = this.cleanText(row.main_title || row.title || "Grand Challenges funding opportunity");
    const fellowship = /travel award|fellowship|scholarship|conference award/i.test(`${title} ${description}`);
    const sourceUrl = row.url ? new URL(row.url, "https://www.grandchallenges.org").toString() : String(row.apply_link || "https://www.grandchallenges.org/grant-opportunities");
    return { title, organization: this.cleanText(row.initiative_title || "Grand Challenges"), country: /LMIC|low.?and middle.?income|africa/i.test(description) ? "Global South" : "Global", type: fellowship ? "fellowship" : "grant", remote: false, description: description.slice(0, 30000), deadline: row.date_end ? new Date(Number(row.date_end) * 1000) : undefined, sourceUrl, applicationUrl: row.apply_link ? new URL(row.apply_link, "https://www.grandchallenges.org").toString() : undefined, source: "Grand Challenges" };
  }
}
