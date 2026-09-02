import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CORE_INTERNAL_URL = (process.env.TUKU_CORE_INTERNAL_URL || process.env.TUKU_CORE_URL || 'https://core.tukutuku.org').replace(/\/$/, '');
const AI_KEY = process.env.TUKU_AI_INTEGRATION_KEY || '';

interface MatchingResult {
  score: number;
  explanation: string;
  keySkillMatches: string[];
  missingRequirements: string[];
  overqualifications: string[];
  hardConstraints: string[];
  specialistNeeds: string[];
  confidence: number;
}

export class AIMatchingEngine {
  async generateMatch(userId: string, opportunityId: string): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { resumeText: true, parsedSkills: true, parsedIndustries: true, preferences: true, capabilityProfile: true },
    });
    const opportunity = await prisma.opportunity.findUnique({
      where: { id: opportunityId },
      select: { title: true, organization: true, type: true, description: true, requirements: true, country: true, remote: true, createdAt: true, deadline: true },
    });
    if (!user || !opportunity) return;

    const preferences = user.preferences && typeof user.preferences === 'object' ? user.preferences as any : {};
    const aiResult = await this.calculateAIMatchScore({
      resumeText: user.resumeText || '',
      skills: user.parsedSkills || [],
      industries: user.parsedIndustries || [],
      preferences,
      capability: user.capabilityProfile,
      opportunity,
    });
    const locationScore = this.calculateLocationScore(preferences, opportunity.country, opportunity.remote);
    const freshnessScore = this.calculateFreshnessScore(opportunity.createdAt, opportunity.deadline);
    const behaviorScore = await this.calculateBehavioralScore(userId, opportunity.type);
    const finalRank = this.calculateFinalRank({ gpt: aiResult.score, location: locationScore, behavior: behaviorScore, freshness: freshnessScore });

    const evidence = { keySkillMatches: aiResult.keySkillMatches, missingRequirements: aiResult.missingRequirements, hardConstraints: aiResult.hardConstraints, specialistNeeds: aiResult.specialistNeeds, confidence: aiResult.confidence };
    await prisma.match.upsert({
      where: { userId_opportunityId: { userId, opportunityId } },
      update: { gptMatchScore: aiResult.score, explanation: aiResult.explanation, ...evidence, locationScore, behaviorScore, freshnessScore, finalRank },
      create: { userId, opportunityId, gptMatchScore: aiResult.score, explanation: aiResult.explanation, ...evidence, locationScore, behaviorScore, freshnessScore, finalRank },
    });
  }

  private async calculateAIMatchScore(input: any): Promise<MatchingResult> {
    const { resumeText, skills, industries, preferences, capability, opportunity } = input;
    if (!AI_KEY) return this.fallbackResult(skills, preferences, opportunity);
    const profileType = String(preferences.profileType || 'individual');
    const canRecruitSpecialists = preferences.canRecruitSpecialists === true;
    const whatLookingFor = String(preferences.whatLookingFor || '').trim();
    const instruction = `Score opportunity fit from 0-100 and return JSON only with score, confidence (0-1), explanation, keySkillMatches, missingRequirements, overqualifications, hardConstraints, specialistNeeds. Use only supplied facts. If the profile is a firm/both and can recruit specialists, do not reject an attractive opportunity merely because a sector specialist is not currently in-house: identify the specialist gap instead. Still penalize hard corporate eligibility that hiring cannot fix, such as mandatory local registration, audited turnover, licences, or required firm references.`;
    const context = {
      profile: {
        profileType,
        whatLookingFor,
        skills,
        industries,
        canRecruitSpecialists,
        resumeText: String(resumeText || '').slice(0, 22000),
        preferences, capability,
      },
      opportunity,
    };

    try {
      const response = await fetch(`${CORE_INTERNAL_URL}/api/v1/integrations/ai/assist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tuku-product-code': 'radar', 'x-tuku-integration-key': AI_KEY },
        body: JSON.stringify({ capability: 'analyze', instruction, context, subjectRef: `radar-match:${opportunity.organization}:${opportunity.title}`.slice(0, 220), maxOutputTokens: 850 }),
        signal: AbortSignal.timeout(Math.max(30000, Math.min(120000, Number(process.env.TUKU_AI_TIMEOUT_MS || 120000)))),
      });
      const payload: any = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || `Tuku AI returned ${response.status}`);
      const data = payload?.data ?? payload;
      const raw = String(data?.text || data?.output || '{}').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
      const result = JSON.parse(raw);
      return {
        score: Math.min(100, Math.max(0, Number(result.score || 0))),
        explanation: String(result.explanation || 'Match analysis unavailable'),
        keySkillMatches: Array.isArray(result.keySkillMatches) ? result.keySkillMatches : [],
        missingRequirements: Array.isArray(result.missingRequirements) ? result.missingRequirements : [],
        overqualifications: Array.isArray(result.overqualifications) ? result.overqualifications : [],
        hardConstraints: Array.isArray(result.hardConstraints) ? result.hardConstraints : [],
        specialistNeeds: Array.isArray(result.specialistNeeds) ? result.specialistNeeds : [],
        confidence: Math.min(1, Math.max(0, Number(result.confidence ?? 0.65))),
      };
    } catch (error) {
      console.error('[AIMatchingEngine] Tuku AI error:', error);
      return this.fallbackResult(skills, preferences, opportunity);
    }
  }

  private fallbackResult(skills: string[], preferences: any, opportunity: any): MatchingResult {
    const haystack = `${opportunity.title} ${opportunity.organization} ${opportunity.description} ${opportunity.requirements || ''}`.toLowerCase();
    const skillHits = (skills || []).filter((skill) => haystack.includes(String(skill).toLowerCase()));
    const intentTerms = String(preferences.whatLookingFor || '').toLowerCase().split(/[^a-z0-9+#.-]+/).filter((term: string) => term.length > 2);
    const intentHits = intentTerms.filter((term: string) => haystack.includes(term));
    let score = 42 + Math.min(28, skillHits.length * 5) + Math.min(20, intentHits.length * 2);
    if ((preferences.profileType === 'firm' || preferences.profileType === 'both') && preferences.canRecruitSpecialists && ['consultancy','tender','grant'].includes(opportunity.type)) score += 5;
    return {
      score: Math.min(100, score),
      explanation: `Radar found ${skillHits.length} direct skill matches${intentHits.length ? ` and ${intentHits.length} target-intent matches` : ''}. Run the detailed fit analysis for hard eligibility and specialist gaps.`,
      keySkillMatches: skillHits.slice(0, 10),
      missingRequirements: [],
      overqualifications: [],
      hardConstraints: [],
      specialistNeeds: [],
      confidence: 0.45,
    };
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
    const users = await prisma.user.findMany({ where: { OR: [{ resumeText: { not: null } }, { onboardingComplete: true }] }, select: { id: true } });
    for (const user of users) {
      try { await this.generateMatch(user.id, opportunityId); await this.sleep(250); }
      catch (error) { console.error(`[AIMatchingEngine] user ${user.id}:`, error); }
    }
  }

  async updateUserMatches(userId: string): Promise<void> {
    const recent = await prisma.opportunity.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 45 * 86400000) }, OR: [{ deadline: null }, { deadline: { gte: new Date() } }] },
      select: { id: true }, take: 150, orderBy: { createdAt: 'desc' },
    });
    for (const opportunity of recent) {
      try { await this.generateMatch(userId, opportunity.id); await this.sleep(180); }
      catch (error) { console.error(`[AIMatchingEngine] opportunity ${opportunity.id}:`, error); }
    }
  }

  private sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
}
