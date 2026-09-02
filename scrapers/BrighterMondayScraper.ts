import axios from "axios";
import * as cheerio from "cheerio";
import { BaseScraper, RawOpportunity, ScraperConfig } from "./BaseScraper";

type JobRow = { title: string; organization: string; url: string; location: string; employment: string; category: string; description: string; remote: boolean };

export class BrighterMondayScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 25, timeout: 25000, ...config }); }
  async fetch(): Promise<JobRow[]> {
    const response = await axios.get("https://www.brightermonday.co.ug/jobs", { timeout: this.config.timeout, responseType: "text", headers: { "User-Agent": "Radar/1.0 (+https://radar.tukutuku.org)", Accept: "text/html" } });
    const $ = cheerio.load(String(response.data || "")); const rows: JobRow[] = [];
    $("[data-cy=listing-cards-components]").each((_i, el) => {
      const card = $(el); const link = card.find("[data-cy=listing-title-link]").first();
      const title = this.cleanText(link.attr("title") || link.text()); const url = String(link.attr("href") || ""); if (!title || !url) return;
      const text = this.cleanText(card.text());
      const org = this.cleanText(card.find("img[alt]").first().attr("alt") || card.find("p.text-sm.text-blue-700").first().text() || "BrighterMonday employer");
      const chips = card.find("span.rounded").map((_j, x) => this.cleanText($(x).text())).get().filter(Boolean);
      const location = chips[0] || "Uganda"; const employment = chips[1] || "";
      const description = this.cleanText(card.find("p.text-sm.font-normal.text-gray-700").last().text() || text);
      const category = this.cleanText(card.find("p.text-sm.text-gray-500").first().text());
      rows.push({ title, organization: org, url, location, employment, category, description, remote: /remote|home.?based/i.test(`${location} ${description}`) });
    });
    return rows.slice(0, Number(process.env.RADAR_BRIGHTERMONDAY_LIMIT || 50));
  }
  normalize(row: JobRow): RawOpportunity {
    const consultancy = /consultant|consultancy|advisor|advisory|technical assistance/i.test(`${row.title} ${row.employment} ${row.category}`);
    return { title: row.title, organization: row.organization, country: "Uganda", region: row.location, type: consultancy ? "consultancy" : "job", remote: row.remote, description: this.cleanText(`${row.description}. Employment: ${row.employment || "not stated"}. Function: ${row.category || "not stated"}. Location: ${row.location}.`).slice(0, 12000), sourceUrl: row.url, source: "BrighterMonday Uganda" };
  }
}
