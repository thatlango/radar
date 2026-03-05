import { PrismaClient } from '@prisma/client';
import nodemailer from 'nodemailer';
import { Twilio } from 'twilio';
import cron from 'node-cron';

const prisma = new PrismaClient();

// Email configuration
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// SMS configuration
const twilioClient = new Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

interface AlertOpportunity {
  id: string;
  title: string;
  organization: string;
  country: string;
  type: string;
  remote: boolean;
  deadline: Date | null;
  sourceUrl: string;
  matchScore?: number;
}

export class AlertSystem {
  /**
   * Schedule alert jobs
   */
  setupScheduler(): void {
    // Daily alerts at 8 AM UTC
    cron.schedule('0 8 * * *', async () => {
      console.log('[AlertSystem] Running daily alerts...');
      await this.processDailyAlerts();
    });

    // Weekly alerts every Monday at 8 AM UTC
    cron.schedule('0 8 * * 1', async () => {
      console.log('[AlertSystem] Running weekly alerts...');
      await this.processWeeklyAlerts();
    });

    // Instant alerts run every 5 minutes for Pro users
    cron.schedule('*/5 * * * *', async () => {
      console.log('[AlertSystem] Running instant alerts...');
      await this.processInstantAlerts();
    });

    console.log('[AlertSystem] Scheduler initialized');
  }

  /**
   * Process daily alerts
   */
  private async processDailyAlerts(): Promise<void> {
    const alerts = await prisma.alert.findMany({
      where: {
        frequency: 'daily',
        active: true
      },
      include: {
        user: true
      }
    });

    console.log(`Processing ${alerts.length} daily alerts`);

    for (const alert of alerts) {
      try {
        await this.sendAlert(alert);
      } catch (error) {
        console.error(`Error sending alert for user ${alert.userId}:`, error);
      }
    }
  }

  /**
   * Process weekly alerts
   */
  private async processWeeklyAlerts(): Promise<void> {
    const alerts = await prisma.alert.findMany({
      where: {
        frequency: 'weekly',
        active: true
      },
      include: {
        user: true
      }
    });

    console.log(`Processing ${alerts.length} weekly alerts`);

    for (const alert of alerts) {
      try {
        await this.sendAlert(alert);
      } catch (error) {
        console.error(`Error sending alert for user ${alert.userId}:`, error);
      }
    }
  }

  /**
   * Process instant alerts for Pro users
   */
  private async processInstantAlerts(): Promise<void> {
    const alerts = await prisma.alert.findMany({
      where: {
        frequency: 'instant',
        active: true,
        user: {
          isPro: true
        }
      },
      include: {
        user: true
      }
    });

    // Get opportunities created in last 5 minutes
    const recentOpportunities = await prisma.opportunity.findMany({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 5 * 60 * 1000)
        }
      }
    });

    if (recentOpportunities.length === 0) return;

    console.log(`Processing ${alerts.length} instant alerts for ${recentOpportunities.length} new opportunities`);

    for (const alert of alerts) {
      try {
        const matchingOpportunities = this.filterOpportunities(
          recentOpportunities,
          alert
        );

        if (matchingOpportunities.length > 0) {
          await this.sendInstantAlert(alert, matchingOpportunities);
        }
      } catch (error) {
        console.error(`Error sending instant alert for user ${alert.userId}:`, error);
      }
    }
  }

  /**
   * Send alert to user
   */
  private async sendAlert(alert: any): Promise<void> {
    const opportunities = await this.getMatchingOpportunities(alert);

    if (opportunities.length === 0) {
      console.log(`No matching opportunities for alert ${alert.id}`);
      return;
    }

    // Send via email
    if (alert.user.email) {
      await this.sendEmailAlert(alert.user, opportunities, alert.frequency);
    }

    // Send via SMS if Pro user and prefers SMS
    if (alert.user.isPro && alert.user.prefersSMS && alert.user.phone) {
      await this.sendSMSAlert(alert.user, opportunities);
    }

    // Update alert metadata
    await prisma.alert.update({
      where: { id: alert.id },
      data: {
        lastSent: new Date(),
        sendCount: { increment: 1 }
      }
    });
  }

  /**
   * Send instant alert for Pro users
   */
  private async sendInstantAlert(alert: any, opportunities: any[]): Promise<void> {
    console.log(`Sending instant alert to ${alert.user.email} for ${opportunities.length} opportunities`);

    // Send via email
    await this.sendEmailAlert(alert.user, opportunities, 'instant');

    // Send via SMS if preferred
    if (alert.user.prefersSMS && alert.user.phone) {
      await this.sendSMSAlert(alert.user, opportunities);
    }
  }

  /**
   * Get opportunities matching alert criteria
   */
  private async getMatchingOpportunities(alert: any): Promise<AlertOpportunity[]> {
    const timeCutoff = this.getTimeCutoff(alert.frequency);

    const opportunities = await prisma.opportunity.findMany({
      where: {
        createdAt: {
          gte: timeCutoff
        },
        ...(alert.typePreference && { type: alert.typePreference }),
        ...(alert.locationPreference && {
          OR: [
            { country: { contains: alert.locationPreference } },
            { remote: true }
          ]
        })
      },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    // Filter by keywords
    const filtered = this.filterByKeywords(opportunities, alert.keywords);

    // Get match scores if user has resume
    const withScores = await this.addMatchScores(filtered, alert.userId);

    return withScores;
  }

  /**
   * Filter opportunities by alert keywords
   */
  private filterByKeywords(opportunities: any[], keywords: string): any[] {
    if (!keywords || keywords.trim().length === 0) {
      return opportunities;
    }

    const keywordList = keywords.toLowerCase().split(',').map(k => k.trim());

    return opportunities.filter(opp => {
      const searchText = `${opp.title} ${opp.description} ${opp.organization}`.toLowerCase();
      return keywordList.some(keyword => searchText.includes(keyword));
    });
  }

  /**
   * Filter opportunities for instant alerts
   */
  private filterOpportunities(opportunities: any[], alert: any): any[] {
    let filtered = opportunities;

    // Type filter
    if (alert.typePreference) {
      filtered = filtered.filter(opp => opp.type === alert.typePreference);
    }

    // Location filter
    if (alert.locationPreference) {
      filtered = filtered.filter(opp => 
        opp.country.includes(alert.locationPreference) || opp.remote
      );
    }

    // Keyword filter
    filtered = this.filterByKeywords(filtered, alert.keywords);

    return filtered;
  }

  /**
   * Add match scores to opportunities
   */
  private async addMatchScores(
    opportunities: any[],
    userId: string
  ): Promise<AlertOpportunity[]> {
    const opportunitiesWithScores: AlertOpportunity[] = [];

    for (const opp of opportunities) {
      const match = await prisma.match.findUnique({
        where: {
          userId_opportunityId: {
            userId,
            opportunityId: opp.id
          }
        }
      });

      opportunitiesWithScores.push({
        id: opp.id,
        title: opp.title,
        organization: opp.organization,
        country: opp.country,
        type: opp.type,
        remote: opp.remote,
        deadline: opp.deadline,
        sourceUrl: opp.sourceUrl,
        matchScore: match?.finalRank
      });
    }

    // Sort by match score if available
    return opportunitiesWithScores.sort((a, b) => 
      (b.matchScore || 0) - (a.matchScore || 0)
    );
  }

  /**
   * Send email alert
   */
  private async sendEmailAlert(
    user: any,
    opportunities: AlertOpportunity[],
    frequency: string
  ): Promise<void> {
    const subject = frequency === 'instant'
      ? '🚀 New Opportunities Just Added to Radar!'
      : `📊 Your ${this.capitalizeFirst(frequency)} Radar Opportunities`;

    const html = this.generateEmailHTML(user, opportunities, frequency);

    try {
      await emailTransporter.sendMail({
        from: '"Radar by Tuku-Tuku" <alerts@radar.app>',
        to: user.email,
        subject,
        html
      });

      console.log(`Email alert sent to ${user.email}`);
    } catch (error) {
      console.error('Email send error:', error);
      throw error;
    }
  }

  /**
   * Send SMS alert
   */
  private async sendSMSAlert(
    user: any,
    opportunities: AlertOpportunity[]
  ): Promise<void> {
    const topOpportunity = opportunities[0];
    
    const message = `🎯 Radar Alert: New match! ${topOpportunity.title} at ${topOpportunity.organization}. ${opportunities.length > 1 ? `+${opportunities.length - 1} more` : ''} View: radar.app/matches`;

    try {
      await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: user.phone
      });

      console.log(`SMS alert sent to ${user.phone}`);
    } catch (error) {
      console.error('SMS send error:', error);
      throw error;
    }
  }

  /**
   * Generate email HTML
   */
  private generateEmailHTML(
    user: any,
    opportunities: AlertOpportunity[],
    frequency: string
  ): string {
    const opportunitiesHTML = opportunities.map(opp => `
      <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
        <h3 style="margin: 0 0 8px 0; color: #111111;">
          ${opp.title}
          ${opp.matchScore ? `<span style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-left: 8px;">${Math.round(opp.matchScore)}% Match</span>` : ''}
        </h3>
        <p style="margin: 4px 0; color: #6b7280;">
          ${opp.organization} • ${opp.country}${opp.remote ? ' • 🌐 Remote' : ''}
        </p>
        <p style="margin: 8px 0; color: #9ca3af; font-size: 14px;">
          ${opp.type} ${opp.deadline ? `• Deadline: ${new Date(opp.deadline).toLocaleDateString()}` : ''}
        </p>
        <a href="${opp.sourceUrl}" style="display: inline-block; background: #111111; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; margin-top: 8px;">
          View & Apply
        </a>
      </div>
    `).join('');

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #111111; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="font-family: 'Georgia', serif; font-size: 28px; margin: 0;">Radar</h1>
          <p style="color: #6b7280; margin: 4px 0;">A product of Tuku-Tuku Innovation Labs</p>
        </div>

        <h2 style="margin-bottom: 16px;">Hi ${user.name || 'there'}! 👋</h2>
        
        <p style="margin-bottom: 24px;">
          We found ${opportunities.length} ${frequency === 'instant' ? 'new' : ''} ${opportunities.length === 1 ? 'opportunity' : 'opportunities'} matching your preferences:
        </p>

        ${opportunitiesHTML}

        ${!user.isPro ? `
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border-radius: 8px; padding: 20px; margin-top: 24px; text-align: center;">
            <h3 style="margin: 0 0 8px 0;">Upgrade to Radar Pro</h3>
            <p style="margin: 0 0 16px 0; opacity: 0.9;">Get instant alerts, AI cover letters, and priority matching</p>
            <a href="https://radar.app/pro" style="display: inline-block; background: white; color: #667eea; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
              Upgrade Now - $49 One-Time
            </a>
          </div>
        ` : ''}

        <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">
          <p>📱 <a href="https://radar.app/alerts" style="color: #0066ff;">Manage your alerts</a></p>
          <p>🚀 <a href="https://radar.app/opportunities" style="color: #0066ff;">Browse all opportunities</a></p>
          <p style="margin-top: 16px;">
            <a href="https://radar.app/unsubscribe?alert=${user.id}" style="color: #9ca3af; text-decoration: none;">Unsubscribe from these alerts</a>
          </p>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Get time cutoff based on frequency
   */
  private getTimeCutoff(frequency: string): Date {
    const now = Date.now();
    
    switch (frequency) {
      case 'daily':
        return new Date(now - 24 * 60 * 60 * 1000);
      case 'weekly':
        return new Date(now - 7 * 24 * 60 * 60 * 1000);
      case 'instant':
        return new Date(now - 5 * 60 * 1000);
      default:
        return new Date(now - 24 * 60 * 60 * 1000);
    }
  }

  /**
   * Capitalize first letter
   */
  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Send notification for new match (called when matching engine runs)
   */
  async notifyNewMatch(userId: string, opportunityId: string, matchScore: number): Promise<void> {
    // Only notify for high-quality matches
    if (matchScore < 75) return;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        phone: true,
        isPro: true,
        prefersSMS: true
      }
    });

    if (!user) return;

    // Pro users get instant notifications
    if (user.isPro) {
      const opportunity = await prisma.opportunity.findUnique({
        where: { id: opportunityId }
      });

      if (opportunity) {
        await this.sendInstantAlert(
          { user },
          [{ ...opportunity, matchScore }]
        );
      }
    }
  }
}
