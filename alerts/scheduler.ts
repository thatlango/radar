import { PrismaClient } from '@prisma/client';
import nodemailer from 'nodemailer';
import { Twilio } from 'twilio';
import cron from 'node-cron';
import { scraperManager } from '../scrapers/scraperManager';

const prisma = new PrismaClient();
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
});
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

interface AlertOpportunity {
  id: string;
  title: string;
  organization: string;
  country: string;
  type: string;
  remote: boolean;
  deadline: Date | null;
  sourceUrl: string;
  source?: string;
  description?: string;
  matchScore?: number;
  explanation?: string;
}

export class AlertSystem {
  setupScheduler(): void {
    // Refresh the shared opportunity pool throughout the day so an 08:00/09:00 brief is never based on one stale crawl.
    cron.schedule('15 */4 * * *', async () => {
      try {
        console.log('[Radar] running cross-source opportunity scan');
        await scraperManager.runAll();
      } catch (error) { console.error('[Radar] scan error', error); }
    });

    // Check each user's local delivery hour. Users choose 08:00 or 09:00 in their own timezone.
    cron.schedule('5 * * * *', async () => {
      try { await this.processDailyBriefings(); }
      catch (error) { console.error('[Radar] daily briefing tick failed', error); }
    });

    // Keep freshness state truthful even when a source stops publishing a deadline.
    cron.schedule('35 * * * *', async () => {
      try {
        const now = new Date();
        const staleBefore = new Date(Date.now() - 72 * 3600000);
        const [expired, stale] = await Promise.all([
          prisma.opportunity.updateMany({ where: { deadline: { lt: now }, sourceStatus: { not: 'expired' } }, data: { sourceStatus: 'expired', verificationStatus: 'expired', closedAt: now } }),
          prisma.opportunity.updateMany({ where: { deadline: null, lastVerifiedAt: { lt: staleBefore }, sourceStatus: 'live' }, data: { sourceStatus: 'stale', verificationStatus: 'needs_review' } }),
        ]);
        if (expired.count || stale.count) console.log(`[Radar] freshness reconciled: ${expired.count} expired, ${stale.count} stale`);
      } catch (error) { console.error('[Radar] freshness reconciliation failed', error); }
    });

    // Preserve weekly and instant alert modes for existing accounts.
    cron.schedule('20 * * * *', async () => {
      try { await this.processInstantAlerts(); }
      catch (error) { console.error('[Radar] instant alerts failed', error); }
    });
    cron.schedule('30 8 * * 1', async () => {
      try { await this.processWeeklyAlerts(); }
      catch (error) { console.error('[Radar] weekly alerts failed', error); }
    });

    console.log('[Radar] opportunity scan + briefing scheduler initialized');
  }

  private prefs(user: any): any {
    return user?.preferences && typeof user.preferences === 'object' ? user.preferences : {};
  }

  private localParts(timeZone: string, date = new Date()): { date: string; hour: number } {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
      }).formatToParts(date);
      const value = (type: string) => parts.find((part) => part.type === type)?.value || '';
      return { date: `${value('year')}-${value('month')}-${value('day')}`, hour: Number(value('hour')) };
    } catch {
      const iso = date.toISOString();
      return { date: iso.slice(0, 10), hour: date.getUTCHours() };
    }
  }

  private dueNow(alert: any): boolean {
    const prefs = this.prefs(alert.user);
    if (prefs.dailyBriefEnabled !== true) return false;
    const timeZone = String(prefs.timezone || 'Africa/Kampala');
    const deliveryHour = [8, 9].includes(Number(prefs.deliveryHour)) ? Number(prefs.deliveryHour) : 8;
    const now = this.localParts(timeZone);
    if (now.hour !== deliveryHour) return false;
    if (!alert.lastSent) return true;
    return this.localParts(timeZone, new Date(alert.lastSent)).date !== now.date;
  }

  private async processDailyBriefings(): Promise<void> {
    const alerts = await prisma.alert.findMany({ where: { frequency: 'daily', active: true }, include: { user: true } });
    for (const alert of alerts) {
      if (!this.dueNow(alert)) continue;
      try {
        const opportunities = await this.getMatchingOpportunities(alert, 'daily');
        if (!opportunities.length) {
          console.log(`[Radar] no new qualifying opportunities for ${alert.user.email}; no brief sent`);
          continue;
        }
        await this.deliver(alert.user, opportunities, 'daily');
        await prisma.alert.update({ where: { id: alert.id }, data: { lastSent: new Date(), sendCount: { increment: 1 } } });
        await prisma.match.updateMany({
          where: { userId: alert.userId, opportunityId: { in: opportunities.map((item) => item.id) } },
          data: { notified: true },
        }).catch(() => undefined);
      } catch (error) { console.error(`[Radar] briefing failed for ${alert.userId}`, error); }
    }
  }

  private async processWeeklyAlerts(): Promise<void> {
    const alerts = await prisma.alert.findMany({ where: { frequency: 'weekly', active: true }, include: { user: true } });
    for (const alert of alerts) {
      try {
        const opportunities = await this.getMatchingOpportunities(alert, 'weekly');
        if (!opportunities.length) continue;
        await this.deliver(alert.user, opportunities, 'weekly');
        await prisma.alert.update({ where: { id: alert.id }, data: { lastSent: new Date(), sendCount: { increment: 1 } } });
      } catch (error) { console.error('[Radar] weekly alert failed', error); }
    }
  }

  private async processInstantAlerts(): Promise<void> {
    const alerts = await prisma.alert.findMany({ where: { frequency: 'instant', active: true, user: { isPro: true } }, include: { user: true } });
    for (const alert of alerts) {
      try {
        const opportunities = await this.getMatchingOpportunities(alert, 'instant');
        if (!opportunities.length) continue;
        await this.deliver(alert.user, opportunities.slice(0, 5), 'instant');
        await prisma.alert.update({ where: { id: alert.id }, data: { lastSent: new Date(), sendCount: { increment: 1 } } });
      } catch (error) { console.error('[Radar] instant alert failed', error); }
    }
  }

  private async getMatchingOpportunities(alert: any, frequency: string): Promise<AlertOpportunity[]> {
    const user = alert.user;
    const prefs = this.prefs(user);
    const cutoffHours = frequency === 'weekly' ? 168 : frequency === 'instant' ? 1 : 36;
    const cutoff = alert.lastSent && frequency === 'daily'
      ? new Date(Math.max(new Date(alert.lastSent).getTime() - 2 * 3600000, Date.now() - 72 * 3600000))
      : new Date(Date.now() - cutoffHours * 3600000);
    const minDays = Math.max(0, Math.min(60, Number(prefs.minDaysToDeadline ?? 7)));
    const minFit = Math.max(0, Math.min(100, Number(prefs.minFitScore ?? 60)));
    const countries = Array.isArray(prefs.countries) ? prefs.countries.map((x: any) => String(x).toLowerCase()) : [];
    const regions = Array.isArray(prefs.regions) ? prefs.regions.map((x: any) => String(x).toLowerCase()) : [];
    const types = Array.isArray(prefs.types) ? prefs.types.map(String) : [];

    const rows = await prisma.opportunity.findMany({
      where: {
        createdAt: { gte: cutoff },
        OR: [{ deadline: null }, { deadline: { gte: new Date(Date.now() + minDays * 86400000) } }],
        ...(types.length ? { type: { in: types } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { qualityScore: 'desc' }],
      take: 160,
    });

    const narrowed = rows.filter((opp) => {
      if (!countries.length && !regions.length) return true;
      if (opp.remote && prefs.remote !== false) return true;
      const location = `${opp.country || ''} ${opp.region || ''}`.toLowerCase();
      return countries.some((value: string) => location.includes(value)) || regions.some((value: string) => location.includes(value));
    });

    const ids = narrowed.map((opp) => opp.id);
    const matches = new Map((await prisma.match.findMany({ where: { userId: user.id, opportunityId: { in: ids } } })).map((match) => [match.opportunityId, match]));
    const opportunities = narrowed.map((opp) => {
      const match = matches.get(opp.id);
      const score = match?.finalRank ?? this.fallbackFit(user, opp);
      return {
        id: opp.id,
        title: opp.title,
        organization: opp.organization,
        country: opp.country,
        type: opp.type,
        remote: opp.remote,
        deadline: opp.deadline,
        sourceUrl: opp.sourceUrl,
        source: opp.source,
        description: opp.aiSummary || opp.description,
        matchScore: score,
        explanation: match?.explanation,
      } as AlertOpportunity;
    });

    return opportunities
      .filter((opp) => Number(opp.matchScore || 0) >= minFit)
      .sort((a, b) => Number(b.matchScore || 0) - Number(a.matchScore || 0))
      .slice(0, frequency === 'weekly' ? 15 : 10);
  }

  private fallbackFit(user: any, opportunity: any): number {
    const prefs = this.prefs(user);
    const haystack = `${opportunity.title} ${opportunity.organization} ${opportunity.description} ${opportunity.requirements || ''}`.toLowerCase();
    const skillTerms = [...(user.parsedSkills || []), ...(user.parsedIndustries || [])].map((x) => String(x).toLowerCase());
    const intentTerms = String(prefs.whatLookingFor || '').toLowerCase().split(/[^a-z0-9+#.-]+/).filter((x) => x.length > 2);
    let score = 42;
    score += Math.min(28, skillTerms.filter((term) => haystack.includes(term)).length * 5);
    score += Math.min(20, intentTerms.filter((term) => haystack.includes(term)).length * 2);
    if (Array.isArray(prefs.types) && prefs.types.includes(opportunity.type)) score += 7;
    if (opportunity.remote && prefs.remote === true) score += 5;
    if ((prefs.profileType === 'firm' || prefs.profileType === 'both') && prefs.canRecruitSpecialists && ['consultancy','tender','grant'].includes(opportunity.type)) score += 4;
    return Math.min(100, score);
  }

  private maskRecipient(value: string): string {
    const raw = String(value || '');
    if (raw.includes('@')) { const [local, domain] = raw.split('@'); return `${local.slice(0,2)}***@${domain}`; }
    return raw.length > 6 ? `${raw.slice(0,3)}***${raw.slice(-3)}` : '***';
  }

  private async trackedDelivery(user: any, kind: string, channel: string, recipient: string, send: () => Promise<any>): Promise<void> {
    const event = await prisma.deliveryEvent.create({ data: { userId: user.id, kind, channel, status: 'sending', recipientMasked: this.maskRecipient(recipient), attemptCount: 1 } });
    try {
      const result: any = await send();
      await prisma.deliveryEvent.update({ where: { id: event.id }, data: { status: 'sent', sentAt: new Date(), providerMessageId: String(result?.messageId || result?.sid || '').slice(0, 240) || null } });
    } catch (error: any) {
      await prisma.deliveryEvent.update({ where: { id: event.id }, data: { status: 'failed', lastError: String(error?.message || error).slice(0, 8000) } }).catch(() => undefined);
      throw error;
    }
  }

  private async deliver(user: any, opportunities: AlertOpportunity[], frequency: string): Promise<void> {
    const prefs = this.prefs(user);
    const tasks: Promise<any>[] = [];
    if (prefs.emailBrief !== false && user.email) tasks.push(this.trackedDelivery(user, `${frequency}_brief`, 'email', user.email, () => this.sendEmail(user, opportunities, frequency)));
    if (prefs.whatsappBrief === true && user.phone) tasks.push(this.trackedDelivery(user, `${frequency}_brief`, 'whatsapp', user.phone, () => this.sendWhatsApp(user, opportunities)));
    if (!tasks.length && user.email) tasks.push(this.trackedDelivery(user, `${frequency}_brief`, 'email', user.email, () => this.sendEmail(user, opportunities, frequency)));
    await Promise.all(tasks);
  }

  private async sendEmail(user: any, opportunities: AlertOpportunity[], frequency: string): Promise<any> {
    if (!process.env.SMTP_HOST) throw new Error('SMTP is not configured.');
    const subject = frequency === 'instant' ? 'Radar: a new strong-fit opportunity' : `Radar ${frequency === 'weekly' ? 'weekly' : 'daily'} brief — ${opportunities.length} matches`;
    return emailTransporter.sendMail({
      from: process.env.RADAR_ALERT_FROM || '"Radar by Tuku-Tuku" <radar@tukutuku.org>',
      to: user.email,
      subject,
      html: this.generateEmailHTML(user, opportunities, frequency),
    });
  }

  private async sendWhatsApp(user: any, opportunities: AlertOpportunity[]): Promise<any> {
    if (!twilioClient || !process.env.TWILIO_WHATSAPP_FROM) throw new Error('WhatsApp delivery is not configured.');
    const top = opportunities.slice(0, 5).map((opp, index) => {
      const score = opp.matchScore ? `${Math.round(opp.matchScore)}%` : 'fit';
      const due = opp.deadline ? new Date(opp.deadline).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : 'open';
      return `${index + 1}. ${opp.title} — ${opp.organization}\n${score} · ${opp.country} · ${due}\n${opp.sourceUrl}`;
    }).join('\n\n');
    const body = `*Your Radar brief*\n${opportunities.length} new opportunities matched what you are looking for.\n\n${top}\n\nOpen Radar for fit notes and next steps: https://radar.tukutuku.org/app`;
    return twilioClient.messages.create({
      body: body.slice(0, 3500),
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
      to: `whatsapp:${this.normalizePhone(user.phone)}`,
    });
  }

  private normalizePhone(value: string): string {
    const raw = String(value || '').trim().replace(/[\s()-]/g, '');
    return raw.startsWith('+') ? raw : `+${raw}`;
  }

  private generateEmailHTML(user: any, opportunities: AlertOpportunity[], frequency: string): string {
    const prefs = this.prefs(user);
    const cards = opportunities.map((opp) => {
      const score = opp.matchScore == null ? '' : `<span style="background:#eaf7ef;color:#126b35;padding:4px 8px;border-radius:999px;font-size:12px;font-weight:700">${Math.round(opp.matchScore)}% fit</span>`;
      const deadline = opp.deadline ? new Date(opp.deadline).toLocaleDateString('en-GB', { dateStyle: 'medium' }) : 'Open / not listed';
      const explanation = opp.explanation ? `<p style="margin:10px 0 0;color:#4b5563;font-size:14px;white-space:pre-line">${this.escapeHtml(opp.explanation)}</p>` : '';
      return `<div style="border:1px solid #e5e7eb;border-radius:14px;padding:18px;margin:0 0 14px;background:#fff">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start"><div><h3 style="margin:0 0 6px;font-size:17px;color:#111827">${this.escapeHtml(opp.title)}</h3><div style="color:#6b7280">${this.escapeHtml(opp.organization)} · ${this.escapeHtml(opp.country)}</div></div>${score}</div>
        <div style="margin-top:9px;color:#6b7280;font-size:13px">${this.escapeHtml(opp.type)} · Deadline: ${this.escapeHtml(deadline)} · ${this.escapeHtml(opp.source || 'source')}</div>
        ${explanation}
        <a href="${this.escapeHtml(opp.sourceUrl)}" style="display:inline-block;margin-top:14px;background:#111827;color:#fff;text-decoration:none;padding:9px 14px;border-radius:9px">Open source</a>
      </div>`;
    }).join('');
    return `<!doctype html><html><body style="margin:0;background:#f5f6f3;font-family:Inter,Arial,sans-serif;color:#111827"><div style="max-width:680px;margin:0 auto;padding:28px 18px">
      <div style="margin-bottom:24px"><div style="font-size:26px;font-weight:800">Radar</div><div style="color:#6b7280">Opportunity intelligence by Tuku-Tuku</div></div>
      <h2 style="margin:0 0 8px">Good morning ${this.escapeHtml(user.name || 'there')}.</h2>
      <p style="color:#4b5563;margin:0 0 6px">We found ${opportunities.length} new ${frequency === 'weekly' ? 'weekly' : 'daily'} matches worth reviewing.</p>
      ${prefs.whatLookingFor ? `<p style="color:#6b7280;margin:0 0 22px"><strong>Looking for:</strong> ${this.escapeHtml(String(prefs.whatLookingFor).slice(0, 500))}</p>` : '<div style="height:14px"></div>'}
      ${cards}
      <div style="margin-top:22px;padding:16px;border-radius:12px;background:#eef1eb;color:#374151;font-size:13px">Radar scans LinkedIn, Opportunity Desk, Global South Opportunities, UN/IFI procurement sources, NGO tender pages and other development-sector sources, then ranks new items against your saved profile. Manage your scan at <a href="https://radar.tukutuku.org/app" style="color:#111827">radar.tukutuku.org</a>.</div>
    </div></body></html>`;
  }

  private escapeHtml(value: string): string {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
  }

  async notifyNewMatch(userId: string, opportunityId: string, matchScore: number): Promise<void> {
    if (matchScore < 80) return;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isPro) return;
    const opportunity = await prisma.opportunity.findUnique({ where: { id: opportunityId } });
    if (!opportunity) return;
    await this.deliver(user, [{
      id: opportunity.id,
      title: opportunity.title,
      organization: opportunity.organization,
      country: opportunity.country,
      type: opportunity.type,
      remote: opportunity.remote,
      deadline: opportunity.deadline,
      sourceUrl: opportunity.sourceUrl,
      source: opportunity.source,
      description: opportunity.aiSummary || opportunity.description,
      matchScore,
    }], 'instant');
  }
}

export const alertSystem = new AlertSystem();
alertSystem.setupScheduler();
