import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface MatchingResult {
  score: number;
  explanation: string;
  keySkillMatches: string[];
  missingRequirements: string[];
  overqualifications: string[];
}

export class AIMatchingEngine {
  async generateMatch(userId: string, opportunityId: string): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { resumeText: true, parsedSkills: true, parsedIndustries: true, preferences: true },
    });
    const opportunity = await prisma.opportunity.findUnique({
      where: { id: opportunityId },
      select: { title: true, organization: true, type: true, description: true, requirements: true, country: true, remote: true, createdAt: true, deadline: true },
    });
    if (!user || !opportunity) return;

    const preferences = user.preferences && typeof user.preferences === 'object' ? user.preferences as any : {};
    const gptResult = await this.calculateGPTMatchScore({
      resumeText: user.resumeText || '',
      skills: user.parsedSkills || [],
      industries: user.parsedIndustries || [],
      preferences,
      opportunity,
    });
    const locationScore = this.calculateLocationScore(preferences, opportunity.country, opportunity.remote);
    const freshnessScore = this.calculateFreshnessScore(opportunity.createdAt, opportunity.deadline);
    const behaviorScore = await this.calculateBehavioralScore(userId, opportunity.type);
    const finalRank = this.calculateFinalRank({ gpt: gptResult.score, location: locationScore, behavior: behaviorScore, freshness: freshnessScore });

    await prisma.match.upsert({
      where: { userId_opportunityId: { userId, opportunityId } },
      update: { gptMatchScore: gptResult.score, explanation: gptResult.explanation, locationScore, behaviorScore, freshnessScore, finalRank },
      create: { userId, opportunityId, gptMatchScore: gptResult.score, explanation: gptResult.explanation, locationScore, behaviorScore, freshnessScore, finalRank },
    });
  }

  private async calculateGPTMatchScore(input: any): Promise<MatchingResult> {
    const { resumeText, skills, industries, preferences, opportunity } = input;
    const profileType = String(preferences.profileType || 'individual');
    const canRecruitSpecialists = preferences.canRecruitSpecialists === true;
    const whatLookingFor = String(preferences.whatLookingFor || '').trim();
    const prompt = `You are Radar, an opportunity-fit analyst. Score how well this opportunity fits the supplied profile. Use only supplied facts.

PROFILE TYPE: ${profileType}
WHAT THEY ARE LOOKING FOR: ${whatLookingFor || 'Not specified'}
SKILLS: ${skills.join(', ') || 'Not specified'}
INDUSTRIES: ${industries.join(', ') || 'Not specified'}
CAN RECRUIT/CONTRACT DOMAIN SPECIALISTS: ${canRecruitSpecialists ? 'Yes' : 'No'}
CV/PROFILE TEXT:\n${String(resumeText || '').slice(0, 18000) || 'No CV supplied'}

OPPORTUNITY:
Title: ${opportunity.title}
Organization: ${opportunity.organization}
Type: ${opportunity.type}
Country: ${opportunity.country}
Remote: ${opportunity.remote}
Description: ${opportunity.description}
Requirements: ${opportunity.requirements || 'Not specified'}

If profileType is firm or both and CAN RECRUIT is Yes, evaluate whether the organisation can credibly lead programme design, implementation methodology, project management, research, stakeholder engagement, capacity building, enterprise/private-sector support, digital systems, MEL, facilitation, innovation design or QA while recruiting technical specialists. Do not downgrade an otherwise attractive opportunity solely because a sector specialist is not currently in-house; instead identify the specialist gap. Still penalize hard corporate eligibility requirements that cannot be solved by hiring an expert (for example local registration, required audited turnover, mandatory licences, or firm references).

Return valid JSON only:
{
  "score": 0-100,
  "explanation": "2-4 concise sentences explaining fit, hard constraints and best next move",
  "keySkillMatches": ["..."],
  "missingRequirements": ["..."],
  "overqualifications": ["..."]
}`;

    try {
      const completion = await openai.chat.completions.create({
        model: process.env.RADAR_MATCHING_MODEL || 'gpt-4o',
        messages: [
          { role: 'system', content: 'Return objective opportunity-fit analysis as valid JSON only. Never invent candidate or firm experience.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 900,
      });
      const raw = completion.choices[0].message.content || '{}';
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
      const result = JSON.parse(cleaned);
      return {
        score: Math.min(100, Math.max(0, Number(result.score || 0))),
        explanation: String(result.explanation || 'Match analysis unavailable'),
        keySkillMatches: Array.isArray(result.keySkillMatches) ? result.keySkillMatches : [],
        missingRequirements: Array.isArray(result.missingRequirements) ? result.missingRequirements : [],
        overqualifications: Array.isArray(result.overqualifications) ? result.overqualifications : [],
      };
    } catch (error) {
      console.error('[AIMatchingEngine] model error:', error);
      return { score: 0, explanation: 'Unable to generate AI match score.', keySkillMatches: [], missingRequirements: [], overqualifications: [] };
    }
  }

  private calculateLocationScore(preferences: any, opportunityCountry: string, isRemote: boolean): number {
    if (isRemote && preferences.remote !== false) return 100;
    const preferredCountries = Array.isArray(preferences.countries) ? preferences.countries.map((x: any) => String(x).toLowerCase()) : [];
    const preferredRegions = Array.isArray(preferences.regions) ? preferences.regions.map((x: any) => String(x).toLowerCase()) : [];
    const country = String(opportunityCountry || '').toLowerCase();
    if (preferredCountries.some((x: string) => country.includes(x) || x.includes(country))) return 100;
    if (preferredRegions.some((x: string) => country.includes(x))) return 85;
    if (preferences.openToRelocation === true) return 70;
    return preferredCountries.length ? 35 : 65;
  }

  private calculateFreshnessScore(createdAt: Date, deadline: Date | null): number {
    const ageDays = Math.max(0, (Date.now() - new Date(createdAt).getTime()) / 86400000);
    let score = Math.max(20, 100 - ageDays * 3);
    if (deadline) {
      const daysLeft = (new Date(deadline).getTime() - Date.now()) / 86400000;
      if (daysLeft < 0) return 0;
      if (daysLeft < 3) score -= 15;
      else if (daysLeft >= 7 && daysLeft <= 30) score += 5;
    }
    return Math.max(0, Math.min(100, score));
  }

  private async calculateBehavioralScore(userId: string, opportunityType: string): Promise<number> {
    const interactions = await prisma.interaction.findMany({ where: { userId }, include: { opportunity: true }, take: 100, orderBy: { createdAt: 'desc' } });
    if (!interactions.length) return 50;
    const sameType = interactions.filter((item) => item.opportunity.type === opportunityType).length / interactions.length;
    const weights: Record<string, number> = { applied: 1, saved: 0.8, viewed: 0.3, dismissed: -0.6, unsaved: -0.3 };
    const engagement = interactions.reduce((sum, item) => sum + (weights[item.type] || 0), 0) / Math.max(1, interactions.length);
    return Math.max(0, Math.min(100, 45 + sameType * 40 + engagement * 25));
  }

  private calculateFinalRank(scores: { gpt: number; location: number; behavior: number; freshness: number }): number {
    return scores.gpt * 0.58 + scores.location * 0.15 + scores.behavior * 0.12 + scores.freshness * 0.15;
  }

  async matchNewOpportunity(opportunityId: string): Promise<void> {
    const users = await prisma.user.findMany({
      where: { OR: [{ resumeText: { not: null } }, { onboardingComplete: true }] },
      select: { id: true },
    });
    for (const user of users) {
      try { await this.generateMatch(user.id, opportunityId); await this.sleep(250); }
      catch (error) { console.error(`[AIMatchingEngine] user ${user.id}:`, error); }
    }
  }

  async updateUserMatches(userId: string): Promise<void> {
    const recent = await prisma.opportunity.findMany({
      where: {
        createdAt: { gte: new Date(Date.now() - 45 * 86400000) },
        OR: [{ deadline: null }, { deadline: { gte: new Date() } }],
      },
      select: { id: true },
      take: 150,
      orderBy: { createdAt: 'desc' },
    });
    for (const opportunity of recent) {
      try { await this.generateMatch(userId, opportunity.id); await this.sleep(180); }
      catch (error) { console.error(`[AIMatchingEngine] opportunity ${opportunity.id}:`, error); }
    }
  }

  private sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
}
