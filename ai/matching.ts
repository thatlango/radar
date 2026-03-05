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
  /**
   * Generate match for a user and opportunity using GPT-4
   */
  async generateMatch(userId: string, opportunityId: string): Promise<void> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          resumeText: true,
          parsedSkills: true,
          parsedIndustries: true,
          preferences: true
        }
      });

      const opportunity = await prisma.opportunity.findUnique({
        where: { id: opportunityId },
        select: {
          title: true,
          organization: true,
          type: true,
          description: true,
          requirements: true,
          country: true,
          remote: true
        }
      });

      if (!user || !opportunity) {
        console.error('User or opportunity not found');
        return;
      }

      // Calculate GPT match score
      const gptResult = await this.calculateGPTMatchScore(
        user.resumeText || '',
        opportunity
      );

      // Calculate location score
      const locationScore = this.calculateLocationScore(
        user.preferences,
        opportunity.country,
        opportunity.remote
      );

      // Calculate freshness score
      const freshnessScore = this.calculateFreshnessScore(opportunityId);

      // Calculate behavioral score (based on past interactions)
      const behaviorScore = await this.calculateBehavioralScore(
        userId,
        opportunity.type
      );

      // Calculate final weighted rank
      const finalRank = this.calculateFinalRank({
        gpt: gptResult.score,
        location: locationScore,
        behavior: behaviorScore,
        freshness: freshnessScore
      });

      // Store match in database
      await prisma.match.upsert({
        where: {
          userId_opportunityId: {
            userId,
            opportunityId
          }
        },
        update: {
          gptMatchScore: gptResult.score,
          explanation: gptResult.explanation,
          locationScore,
          behaviorScore,
          freshnessScore,
          finalRank
        },
        create: {
          userId,
          opportunityId,
          gptMatchScore: gptResult.score,
          explanation: gptResult.explanation,
          locationScore,
          behaviorScore,
          freshnessScore,
          finalRank
        }
      });

      console.log(`Match created: User ${userId} - Opportunity ${opportunityId} - Score: ${finalRank}`);

    } catch (error) {
      console.error('Error generating match:', error);
      throw error;
    }
  }

  /**
   * Use GPT-4 to calculate match score
   */
  private async calculateGPTMatchScore(
    resumeText: string,
    opportunity: any
  ): Promise<MatchingResult> {
    const prompt = `You are an expert career counselor and recruiter. Analyze how well this candidate matches this job opportunity.

CANDIDATE RESUME:
${resumeText || 'No resume provided'}

OPPORTUNITY:
Title: ${opportunity.title}
Organization: ${opportunity.organization}
Type: ${opportunity.type}
Description: ${opportunity.description}
Requirements: ${opportunity.requirements || 'Not specified'}

Provide a detailed matching analysis in JSON format:
{
  "score": <0-100>,
  "explanation": "<2-3 sentence explanation of the match>",
  "keySkillMatches": ["skill1", "skill2", ...],
  "missingRequirements": ["requirement1", "requirement2", ...],
  "overqualifications": ["area1", "area2", ...]
}

Score Guidelines:
- 90-100: Excellent match, candidate exceeds requirements
- 75-89: Strong match, candidate meets all key requirements
- 60-74: Good match, candidate meets most requirements
- 40-59: Moderate match, some skill gaps exist
- 0-39: Poor match, significant gaps in requirements

Focus on:
1. Technical skills alignment
2. Experience level match
3. Industry experience
4. Educational background
5. Career trajectory fit`;

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are an expert career counselor. Provide objective, helpful matching analysis in valid JSON format only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 1000
      });

      const content = completion.choices[0].message.content || '{}';
      const result = JSON.parse(content);

      return {
        score: Math.min(100, Math.max(0, result.score || 0)),
        explanation: result.explanation || 'Match analysis unavailable',
        keySkillMatches: result.keySkillMatches || [],
        missingRequirements: result.missingRequirements || [],
        overqualifications: result.overqualifications || []
      };

    } catch (error) {
      console.error('GPT matching error:', error);
      return {
        score: 0,
        explanation: 'Unable to generate match score',
        keySkillMatches: [],
        missingRequirements: [],
        overqualifications: []
      };
    }
  }

  /**
   * Calculate location preference score
   */
  private calculateLocationScore(
    preferences: any,
    opportunityCountry: string,
    isRemote: boolean
  ): number {
    if (isRemote) return 100; // Remote jobs score highest for flexibility

    const preferredCountries = preferences?.countries || [];
    const openToRelocation = preferences?.openToRelocation || false;

    if (preferredCountries.includes(opportunityCountry)) {
      return 100;
    }

    if (openToRelocation) {
      return 70;
    }

    return 30; // Lower score for non-preferred locations
  }

  /**
   * Calculate opportunity freshness score
   */
  private calculateFreshnessScore(opportunityId: string): number {
    // Opportunities get stale over time
    // This would use opportunity.createdAt in real implementation
    // For now, return a placeholder
    return 80;
  }

  /**
   * Calculate behavioral score based on user's past interactions
   */
  private async calculateBehavioralScore(
    userId: string,
    opportunityType: string
  ): Promise<number> {
    const interactions = await prisma.interaction.findMany({
      where: { userId },
      include: { opportunity: true },
      take: 100,
      orderBy: { createdAt: 'desc' }
    });

    if (interactions.length === 0) return 50; // Neutral score for new users

    // Calculate type preference
    const typeInteractions = interactions.filter(
      i => i.opportunity.type === opportunityType
    );
    const typePreference = (typeInteractions.length / interactions.length) * 100;

    // Calculate engagement level
    const appliedCount = interactions.filter(i => i.type === 'applied').length;
    const viewedCount = interactions.filter(i => i.type === 'viewed').length;
    const engagementRate = viewedCount > 0 ? (appliedCount / viewedCount) * 100 : 50;

    // Combine scores
    return (typePreference * 0.6) + (engagementRate * 0.4);
  }

  /**
   * Calculate final weighted ranking score
   */
  private calculateFinalRank(scores: {
    gpt: number;
    location: number;
    behavior: number;
    freshness: number;
  }): number {
    const weights = {
      gpt: 0.50,        // 50% - Most important
      location: 0.20,   // 20% - Important for relevance
      behavior: 0.20,   // 20% - Learning user preferences
      freshness: 0.10   // 10% - Recency matters
    };

    return (
      scores.gpt * weights.gpt +
      scores.location * weights.location +
      scores.behavior * weights.behavior +
      scores.freshness * weights.freshness
    );
  }

  /**
   * Generate matches for all users when new opportunity is added
   */
  async matchNewOpportunity(opportunityId: string): Promise<void> {
    try {
      const users = await prisma.user.findMany({
        where: {
          resumeText: { not: null }
        },
        select: { id: true }
      });

      console.log(`Generating matches for ${users.length} users...`);

      for (const user of users) {
        try {
          await this.generateMatch(user.id, opportunityId);
          
          // Rate limit GPT calls
          await this.sleep(500);
        } catch (error) {
          console.error(`Error matching user ${user.id}:`, error);
        }
      }

      console.log(`Completed matching for opportunity ${opportunityId}`);

    } catch (error) {
      console.error('Error in matchNewOpportunity:', error);
      throw error;
    }
  }

  /**
   * Update matches for a user when they upload/update resume
   */
  async updateUserMatches(userId: string): Promise<void> {
    try {
      // Get recent opportunities (last 30 days)
      const recentOpportunities = await prisma.opportunity.findMany({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
          }
        },
        select: { id: true },
        take: 100
      });

      console.log(`Updating matches for user ${userId} with ${recentOpportunities.length} opportunities...`);

      for (const opportunity of recentOpportunities) {
        try {
          await this.generateMatch(userId, opportunity.id);
          await this.sleep(500);
        } catch (error) {
          console.error(`Error matching opportunity ${opportunity.id}:`, error);
        }
      }

      console.log(`Completed updating matches for user ${userId}`);

    } catch (error) {
      console.error('Error in updateUserMatches:', error);
      throw error;
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
