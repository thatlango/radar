import axios from "axios";
import * as cheerio from "cheerio";
import { BaseScraper, RawOpportunity, ScraperConfig } from "./BaseScraper";

type ResearchRow = { title: string; organization: string; url: string; description: string; location: string; field: string; profile: string; deadline?: string; label: string };
export class EuraxessScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 25, timeout: 25000, ...config }); }
  async fetch(): Promise<ResearchRow[]> {
    const response = await axios.get("https://euraxess.ec.europa.eu/jobs/search", { timeout: this.config.timeout, responseType: "text", headers: { "User-Agent": "Radar/1.0 (+https://radar.tukutuku.org)", Accept: "text/html" } });
    const $ = cheerio.load(String(response.data || "")); const rows: ResearchRow[] = [];
    $("article.ecl-content-item").each((_i, el) => {
      const card = $(el); const link = card.find("h3 a[href^=\"/jobs/\"]").first(); const title = this.cleanText(link.text()); if (!title) return;
      const primary = card.find(".ecl-content-block__primary-meta-item").first(); const organization = this.cleanText(primary.find("a").first().text() || primary.text());
      const get = (klass: string) => this.cleanText(card.find(`.${klass} .ecl-text-standard`).first().text());
      const deadline = card.find(".id-Application-Deadline time").first().attr("datetime");
      rows.push({ title, organization: organization || "EURAXESS institution", url: new URL(String(link.attr("href")), "https://euraxess.ec.europa.eu").toString(), description: this.cleanText(card.find(".ecl-content-block__description").text()), location: get("id-Work-Locations"), field: get("id-Research-Field"), profile: get("id-Researcher-Profile"), deadline, label: this.cleanText(card.find(".ecl-label").first().text()) });
    });
    const now = Date.now(); return rows.filter((row) => !row.deadline || new Date(row.deadline).getTime() >= now - 86400000).slice(0, Number(process.env.RADAR_EURAXESS_LIMIT || 80));
  }
  normalize(row: ResearchRow): RawOpportunity {
    const fellowship = /fellow|phd|doctoral|postdoc|post-doctor|research grant|scholarship|studentship/i.test(`${row.title} ${row.label} ${row.profile}`);
    const country = this.countryFromLocation(row.location);
    return { title: row.title, organization: row.organization, country, region: row.location || country, type: fellowship ? "fellowship" : "job", remote: /remote|home.?based/i.test(row.location), description: this.cleanText(`${row.description} Research field: ${row.field || "not stated"}. Researcher profile: ${row.profile || "not stated"}. Location: ${row.location || "not stated"}.`).slice(0, 20000), deadline: row.deadline ? new Date(row.deadline) : undefined, sourceUrl: row.url, source: "EURAXESS Jobs & Research Opportunities" };
  }
  private countryFromLocation(value: string): string { const match = value.match(/Number of offers:\s*\d+\s*,\s*([^,]+)/i); return this.cleanText(match?.[1] || "Global"); }
}
