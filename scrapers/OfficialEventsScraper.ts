import axios from "axios";
import * as cheerio from "cheerio";
import { PrismaClient } from "@prisma/client";
import { BaseScraper, RawOpportunity, ScraperConfig } from "./BaseScraper";

const prisma = new PrismaClient();
type EventCandidate = { title: string; url: string; listingText?: string };
type EventDetail = EventCandidate & { html: string };

const EVENT_SIGNAL = /\b(conference|summit|forum|symposium|congress|annual meetings?|ministerial meeting|partnership platform|policy dialogue|convention|expo)\b/i;
const ACTION_SIGNAL = /\b(registration(?: is| now)? open|register now|register here|registration link|apply now|applications?(?: are| is)? open|call for (?:papers?|abstracts?|participants?|speakers?)|submit (?:an )?abstract|delegate application|attendance registration|open to the public|public events?|no registration required)\b/i;
const CLOSED_SIGNAL = /\b(registration closed|applications? closed|closed for registration|event has ended|this event has ended|past event)\b/i;
const MEDIA_ONLY = /\b(invitation to representatives? of the media|media accreditation only|press briefing|press conference)\b/i;

export class OfficialEventsScraper extends BaseScraper {
  constructor(config: ScraperConfig) { super({ rateLimit: 90, timeout: 22000, maxRetries: 2, ...config }); }

  async fetch(): Promise<EventDetail[]> {
    const source = await prisma.scraperSource.findUnique({ where: { id: this.config.sourceId } });
    const cfg = (source?.config && typeof source.config === "object" ? source.config : {}) as any;
    const pages = Array.isArray(cfg.pages) && cfg.pages.length ? cfg.pages : [source?.baseUrl].filter(Boolean);
    const urlIncludes = Array.isArray(cfg.eventUrlIncludes) ? cfg.eventUrlIncludes.map(String) : [];
    const candidates = new Map<string, EventCandidate>();

    for (const listing of pages.slice(0, 6)) {
      const page = String(listing);
      const response = await axios.get(page, { timeout: this.config.timeout, responseType: "text", maxRedirects: 5, headers: { "User-Agent": "Radar/1.0 (+https://radar.tukutuku.org)", Accept: "text/html,application/xhtml+xml" } });
      const $ = cheerio.load(String(response.data || ""));
      $("a[href]").each((_i, el) => {
        const a = $(el); const title = this.cleanText(a.text()); const href = String(a.attr("href") || "");
        if (!title || !EVENT_SIGNAL.test(title) || /^closed\b/i.test(title)) return;
        let url = ""; try { url = new URL(href, page).toString(); } catch { return; }
        if (urlIncludes.length && !urlIncludes.some((needle: string) => url.includes(needle))) return;
        const listingText = this.cleanText(a.closest("article,li,tr,.views-row,.event,.card,div").first().text()).slice(0, 2200);
        if (!candidates.has(url)) candidates.set(url, { title, url, listingText });
      });
      await this.sleep(120);
    }

    const details: EventDetail[] = [];
    for (const item of [...candidates.values()].slice(0, Math.max(20, Math.min(90, Number(cfg.candidateLimit || 60))))) {
      try {
        const response = await axios.get(item.url, { timeout: this.config.timeout, responseType: "text", maxRedirects: 5, headers: { "User-Agent": "Radar/1.0 (+https://radar.tukutuku.org)", Accept: "text/html,application/xhtml+xml" } });
        const html = String(response.data || ""); const $ = cheerio.load(html); const text = this.cleanText(`${item.listingText || ""} ${$("body").text()}`);
        const title = this.cleanText($("h1").first().text() || item.title);
        if (!EVENT_SIGNAL.test(title) || CLOSED_SIGNAL.test(text) || MEDIA_ONLY.test(text)) continue;
        const eventDates = this.eventDates($, text);
        if (!eventDates.start || eventDates.start.getTime() < Date.now() - 86400000) continue;
        if (eventDates.start.getTime() > Date.now() + 550 * 86400000) continue;
        if (!ACTION_SIGNAL.test(text)) continue;
        details.push({ ...item, title, html });
      } catch (error: any) {
        console.warn(`[OfficialEventsScraper] detail check failed ${item.url}: ${error?.message || error}`);
      }
      await this.sleep(80);
    }
    return details.slice(0, Math.max(10, Math.min(60, Number(cfg.limit || 40))));
  }

  normalize(item: EventDetail): RawOpportunity {
    const source: any = (this as any).__radarSource; const cfg: any = source?.config || {};
    const $ = cheerio.load(item.html); const text = this.cleanText($("body").text());
    const dates = this.eventDates($, `${item.listingText || ""} ${text}`); const location = this.eventLocation($, text);
    const action = $("a[href]").toArray().map((el) => ({ el, label: this.cleanText($(el).text()) })).find((x) => /register|apply|submit abstract|registration/i.test(x.label));
    let applicationUrl: string | undefined;
    if (action) { try { applicationUrl = new URL(String($(action.el).attr("href") || ""), item.url).toString(); } catch { applicationUrl = undefined; } }
    if (!applicationUrl && /open to the public|public events?|no registration required/i.test(text)) applicationUrl = item.url;
    const deadline = this.registrationDeadline(text);
    const dateNote = dates.start ? ` Event date: ${dates.start.toISOString().slice(0,10)}${dates.end ? ` to ${dates.end.toISOString().slice(0,10)}` : ""}.` : "";
    const locationNote = location ? ` Location: ${location}.` : "";
    return {
      title: this.cleanText(item.title),
      organization: String(cfg.organization || source?.name || "Event organiser").slice(0, 180),
      country: String(cfg.defaultCountry && cfg.defaultCountry !== "Global" ? this.inferCountry(location || text) || cfg.defaultCountry : this.inferCountry(location || text) || cfg.defaultCountry || "Global"),
      type: "conference",
      remote: /virtual|online|hybrid|zoom|webstream|livestream/i.test(text),
      description: this.cleanText(`${text.slice(0, 18000)}${dateNote}${locationNote}`).slice(0, 20000),
      deadline,
      sourceUrl: item.url,
      source: source?.name || "Official events",
      applicationUrl,
      applicationInstructions: applicationUrl ? (/no registration required|open to the public/i.test(text) ? "Public participation is available on the official event page." : "Registration or participation is open on the official organiser page.") : undefined,
    };
  }

  async run(): Promise<{ success: boolean; scraped: number; inserted: number; duplicates: number; errors: number }> {
    (this as any).__radarSource = await prisma.scraperSource.findUnique({ where: { id: this.config.sourceId } });
    return super.run();
  }

  private eventDates($: cheerio.CheerioAPI, text: string): { start?: Date; end?: Date } {
    const scripts = $("script[type=\"application/ld+json\"]").toArray();
    for (const el of scripts) {
      try {
        const raw = JSON.parse($(el).text()); const queue = Array.isArray(raw) ? [...raw] : [raw];
        while (queue.length) {
          const node: any = queue.shift(); if (!node || typeof node !== "object") continue;
          if (Array.isArray(node)) { queue.push(...node); continue; }
          const type = Array.isArray(node["@type"]) ? node["@type"].join(" ") : String(node["@type"] || "");
          if (/Event/i.test(type) && node.startDate) {
            const start = new Date(node.startDate); const end = node.endDate ? new Date(node.endDate) : undefined;
            if (!Number.isNaN(start.getTime())) return { start, end: end && !Number.isNaN(end.getTime()) ? end : undefined };
          }
          if (node["@graph"]) queue.push(node["@graph"]);
        }
      } catch {}
    }
    const range = text.match(/\b(\d{1,2})\s*[–-]\s*(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i);
    if (range) return { start: this.makeDate(range[1], range[3], range[4]), end: this.makeDate(range[2], range[3], range[4]) };
    const single = text.match(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i)
      || text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
    if (single) return /^\d/.test(single[1]) ? { start: this.makeDate(single[1], single[2], single[3]) } : { start: this.makeDate(single[2], single[1], single[3]) };
    return {};
  }

  private eventLocation($: cheerio.CheerioAPI, text: string): string {
    for (const el of $("script[type=\"application/ld+json\"]").toArray()) {
      try {
        const raw: any = JSON.parse($(el).text()); const blob = JSON.stringify(raw);
        const m = blob.match(/"location"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i); if (m) return this.cleanText(m[1]);
      } catch {}
    }
    const m = text.match(/\b(?:where|location|venue)\s*:\s*([^.;|]{3,180})/i); return m ? this.cleanText(m[1]) : "";
  }

  private registrationDeadline(text: string): Date | undefined {
    const m = text.match(/\b(?:registration|application|submission)\s+deadline\s*[:–-]?\s*(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i);
    return m ? this.makeDate(m[1], m[2], m[3]) : undefined;
  }

  private inferCountry(text: string): string {
    if (!text) return "";
    const hints: Array<[RegExp,string]> = [[/\bKampala\b/i,"Uganda"],[/\bNairobi\b/i,"Kenya"],[/\bKigali\b/i,"Rwanda"],[/\bAddis Ababa\b/i,"Ethiopia"],[/\bBangkok\b/i,"Thailand"],[/\bGeneva\b/i,"Switzerland"],[/\bAbidjan\b/i,"Côte d’Ivoire"],[/\bSeoul\b/i,"Republic of Korea"],[/\b(?:Johannesburg|Cape Town|Pretoria)\b/i,"South Africa"]];
    const hinted = hints.find(([re]) => re.test(text)); if (hinted) return hinted[1];
    const countries = ["Uganda","Kenya","Rwanda","Tanzania","Ethiopia","Ghana","Nigeria","Senegal","South Africa","Zambia","Zimbabwe","Morocco","Tunisia","Egypt","Thailand","Switzerland","Germany","France","Republic of Korea","Côte d’Ivoire","Cote d Ivoire"];
    const lower = text.toLowerCase(); const found = countries.find((c) => lower.includes(c.toLowerCase()));
    if (found) return found === "Cote d Ivoire" ? "Côte d’Ivoire" : found;
    if (/africa|african/i.test(text)) return "Africa"; if (/virtual|online|global/i.test(text)) return "Remote / Global"; return "";
  }

  private monthIndex(value: string): number { return ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(value.slice(0,3).toLowerCase()) + 1; }
  private makeDate(day: string, month: string, year: string): Date | undefined { const m = /^\d+$/.test(month) ? Number(month) : this.monthIndex(month); const d = Number(day); const y = Number(year); if (!m || !d || y < 2020) return undefined; const date = new Date(Date.UTC(y,m-1,d,12,0,0)); return Number.isNaN(date.getTime()) ? undefined : date; }
}
