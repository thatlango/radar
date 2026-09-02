import axios from "axios";
import * as cheerio from "cheerio";
import { BaseScraper, RawOpportunity, ScraperConfig } from "./BaseScraper";

type JobRow = { title: string; organization: string; location: string; grade: string; url: string };
export class ImpactpoolScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 25, timeout: 25000, ...config }); }
  async fetch(): Promise<JobRow[]> {
    const response = await axios.get("https://www.impactpool.org/search", { timeout: this.config.timeout, responseType: "text", headers: { "User-Agent": "Radar/1.0 (+https://radar.tukutuku.org)", Accept: "text/html" } });
    const $ = cheerio.load(String(response.data || "")); const rows: JobRow[] = [];
    $("#job_list .job").each((_i, el) => {
      const link = $(el).find("a[href^=\"/jobs/\"]").first(); const url = String(link.attr("href") || "");
      const title = this.cleanText(link.find("[type=cardTitle]").first().text());
      const emph = link.find("[type=bodyEmphasis]").map((_j, x) => this.cleanText($(x).text())).get().filter(Boolean);
      if (!url || !title) return;
      rows.push({ title, organization: emph[0] || "Impactpool employer", location: emph[1] || "Global", grade: emph[2] || "", url: new URL(url, "https://www.impactpool.org").toString() });
    });
    return rows.slice(0, Number(process.env.RADAR_IMPACTPOOL_LIMIT || 80));
  }
  normalize(row: JobRow): RawOpportunity {
    const consultancy = /consultant|consultancy|advisor|advisory|individual contractor/i.test(`${row.title} ${row.grade}`);
    const remote = /remote|home.?based/i.test(row.location);
    const country = remote ? "Remote / Global" : this.locationCountry(row.location);
    return { title: row.title, organization: row.organization, country, region: row.location, type: consultancy ? "consultancy" : "job", remote, description: this.cleanText(`${row.title}. ${row.organization}. Location: ${row.location}. Level: ${row.grade || "not stated"}.`).slice(0, 12000), sourceUrl: row.url, source: "Impactpool" };
  }
  private locationCountry(value: string): string { if (/washington|d\.?\s*c\.?/i.test(value)) return "United States"; const parts = value.split(/\||,/).map((x) => x.trim()).filter(Boolean); return parts.at(-1) || "Global"; }
}
