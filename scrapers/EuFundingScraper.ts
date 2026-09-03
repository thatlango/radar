import axios from "axios";
import FormData from "form-data";
import * as cheerio from "cheerio";
import { BaseScraper, RawOpportunity, ScraperConfig } from "./BaseScraper";

type EuResult = { summary?: string; url?: string; metadata?: Record<string, any> };

const STRUCTURED_METADATA_KEYS = /(?:budgetYearsColumns|budgetTopicActions|expectedGrants|minContribution|maxContribution|aggregationField|facet|metadata)/i;

export class EuFundingScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 30, timeout: 30000, ...config }); }

  async fetch(): Promise<EuResult[]> {
    const query = { bool: { must: [{ terms: { type: ["1", "8"] } }, { terms: { status: ["31094501", "31094502"] } }] } };
    const form = new FormData();
    form.append("query", JSON.stringify(query), { contentType: "application/json", filename: "query.json" });
    form.append("languages", JSON.stringify(["en"]), { contentType: "application/json", filename: "languages.json" });
    form.append("displayLanguage", "en", { contentType: "text/plain" });
    const response = await axios.post("https://api.tech.ec.europa.eu/search-api/prod/rest/search", form, {
      params: { apiKey: "SEDIA", text: "*", pageSize: Number(process.env.RADAR_EU_FUNDING_LIMIT || 140), pageNumber: 1, sortBy: "deadline", orderBy: "ASC" },
      timeout: this.config.timeout,
      headers: { ...form.getHeaders(), "User-Agent": "Radar/1.0 (+https://radar.tukutuku.org)", Accept: "application/json" },
      maxContentLength: 15 * 1024 * 1024,
    });
    const now = Date.now();
    return (response.data?.results || []).filter((row: EuResult) => {
      const deadlines = this.deadlines(row.metadata?.deadlineDate);
      return !deadlines.length || deadlines.some((date) => date.getTime() >= now - 86400000);
    });
  }

  normalize(row: EuResult): RawOpportunity {
    const metadata = row.metadata || {};
    const identifier = this.first(metadata.identifier) || this.first(metadata.callIdentifier) || "";
    const title = this.cleanText(this.first(metadata.title) || row.summary || identifier || "EU funding opportunity");
    const description = this.cleanText(cheerio.load(String(this.first(metadata.description) || row.summary || "")).text());
    const deadline = this.deadlines(metadata.deadlineDate).filter((date) => date.getTime() >= Date.now() - 86400000).sort((a, b) => a.getTime() - b.getTime())[0];
    const budget = this.displayScalar(metadata.budgetOverview) || this.displayScalar(metadata.budget);
    return {
      title,
      organization: "European Commission",
      country: "Global",
      type: "grant",
      remote: false,
      description: this.cleanText(`${identifier ? `Reference: ${identifier}. ` : ""}${this.first(metadata.callTitle) || ""}. ${description}`).slice(0, 30000),
      salary: budget,
      deadline,
      sourceUrl: identifier ? `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/${encodeURIComponent(identifier)}` : String(row.url || "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-search"),
      source: "EU Funding & Tenders — Grants & Calls",
    };
  }

  private first(value: any): string {
    const values = Array.isArray(value) ? value : [value];
    const candidate = values.find((item) => typeof item === "string" || typeof item === "number");
    return candidate == null ? "" : String(candidate);
  }

  private displayScalar(value: any): string | undefined {
    const values = Array.isArray(value) ? value : [value];
    for (const candidate of values) {
      if (typeof candidate !== "string" && typeof candidate !== "number") continue;
      const text = this.cleanText(String(candidate));
      if (!text || text.length > 180) continue;
      if (/^[\[{]/.test(text) || STRUCTURED_METADATA_KEYS.test(text)) continue;
      if (/[\[{].*[:]/.test(text)) continue;
      return text;
    }
    return undefined;
  }

  private deadlines(value: any): Date[] {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    return items.map((item) => new Date(String(item))).filter((date) => !Number.isNaN(date.getTime()));
  }
}
