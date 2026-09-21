import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CORE_AI_URL = (process.env.TUKU_CORE_INTERNAL_URL || process.env.TUKU_CORE_URL || 'https://core.tukutuku.org').replace(/\/$/, '');
const CORE_AI_KEY = process.env.TUKU_AI_INTEGRATION_KEY || '';

type CoreCapability = 'analyze' | 'classify' | 'extract' | 'summarize' | 'recommend' | 'draft' | 'explain';

async function coreAiText(
  capability: CoreCapability,
  instruction: string,
  context: Record<string, unknown>,
  maxOutputTokens: number,
  temperature: number,
  subjectRef?: string,
) {
  if (!CORE_AI_KEY) throw new Error('Radar Tuku AI integration is not configured');
  const response = await fetch(CORE_AI_URL + '/api/v1/integrations/ai/assist', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tuku-product-code': 'radar',
      'x-tuku-integration-key': CORE_AI_KEY,
    },
    body: JSON.stringify({
      capability,
      instruction,
      context,
      maxOutputTokens,
      temperature,
      ...(subjectRef ? { subjectRef } : {}),
    }),
    signal: AbortSignal.timeout(Math.max(30000, Math.min(120000, Number(process.env.TUKU_AI_TIMEOUT_MS || 90000)))),
  });
  const payload: any = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.message || 'Tuku AI returned HTTP ' + response.status);
  }
  const result = payload?.data ?? payload;
  if (typeof result?.text !== 'string' || !result.text.trim()) {
    throw new Error('Tuku AI returned an empty response');
  }
  return result.text.trim();
}


export class ProAIFeatures {
  /**
   * Rewrite resume to be more competitive for global opportunities
   */
  async rewriteResume(userId: string): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { resumeText: true, isPro: true }
    });

    if (!user?.isPro) {
      throw new Error('Pro subscription required for resume rewrite');
    }

    if (!user.resumeText) {
      throw new Error('No resume found for user');
    }

    const prompt = `You are an expert resume writer and career coach specializing in African talent seeking global opportunities.

ORIGINAL RESUME:
${user.resumeText}

Rewrite this resume to be MORE COMPETITIVE for international opportunities while maintaining honesty:

1. **Action-Oriented Language**: Use strong action verbs (Led, Architected, Drove, Optimized)
2. **Quantifiable Achievements**: Add metrics and impact where possible
3. **Global Standards**: Format to international best practices
4. **ATS-Friendly**: Include relevant keywords for applicant tracking systems
5. **Africa Context**: Highlight unique African market expertise as an asset
6. **Clarity**: Remove jargon, make accomplishments crystal clear

CRITICAL RULES:
- DO NOT fabricate experience or qualifications
- DO enhance descriptions of real accomplishments
- DO add quantifiable metrics where they can be inferred from context
- DO use professional, confident language
- DO highlight transferable skills

Return the rewritten resume in clean, professional format.`;

    try {
      const aiText = await coreAiText('draft', prompt, { surface: 'radar-resume-rewrite', userId }, 2000, 0.7, 'user:' + userId);

      return aiText || 'Unable to generate rewrite';

    } catch (error) {
      console.error('Resume rewrite error:', error);
      throw new Error('Failed to rewrite resume');
    }
  }

  /**
   * Generate personalized cover letter for an opportunity
   */
  async generateCoverLetter(
    userId: string,
    opportunityId: string
  ): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, resumeText: true, isPro: true }
    });

    if (!user?.isPro) {
      throw new Error('Pro subscription required for cover letter generation');
    }

    const opportunity = await prisma.opportunity.findUnique({
      where: { id: opportunityId }
    });

    if (!opportunity) {
      throw new Error('Opportunity not found');
    }

    const match = await prisma.match.findUnique({
      where: {
        userId_opportunityId: {
          userId,
          opportunityId
        }
      }
    });

    const prompt = `Generate a compelling cover letter for this application.

CANDIDATE:
Name: ${user.name || 'Applicant'}
Resume: ${user.resumeText || 'Not provided'}

OPPORTUNITY:
Title: ${opportunity.title}
Organization: ${opportunity.organization}
Description: ${opportunity.description}
Requirements: ${opportunity.requirements || 'Not specified'}

MATCH ANALYSIS:
${match?.explanation || 'Strong alignment with opportunity'}

Write a professional cover letter that:
1. Opens with enthusiasm and specific interest in this role
2. Demonstrates understanding of the organization's mission
3. Highlights 2-3 most relevant experiences/achievements
4. Shows cultural fit and motivation
5. Closes with confidence and call to action
6. Is concise (250-350 words)
7. Uses specific examples, not generic statements

Tone: Professional, confident, authentic, enthusiastic
Format: Standard business letter structure`;

    try {
      const aiText = await coreAiText('draft', prompt, { surface: 'radar-cover-letter', userId, opportunityId }, 1000, 0.7, 'opportunity:' + opportunityId);

      const coverLetter = aiText || '';

      // Store the generated cover letter
      await prisma.application.upsert({
        where: {
          userId_opportunityId: {
            userId,
            opportunityId
          }
        },
        update: {
          coverLetter,
          aiGenerated: true
        },
        create: {
          userId,
          opportunityId,
          coverLetter,
          aiGenerated: true,
          status: 'draft'
        }
      });

      return coverLetter;

    } catch (error) {
      console.error('Cover letter generation error:', error);
      throw new Error('Failed to generate cover letter');
    }
  }

  /**
   * Generate interview preparation questions and answers
   */
  async generateInterviewPrep(
    userId: string,
    opportunityId: string
  ): Promise<{
    questions: Array<{
      question: string;
      answerStrategy: string;
      exampleAnswer: string;
    }>;
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { resumeText: true, isPro: true }
    });

    if (!user?.isPro) {
      throw new Error('Pro subscription required for interview preparation');
    }

    const opportunity = await prisma.opportunity.findUnique({
      where: { id: opportunityId }
    });

    if (!opportunity) {
      throw new Error('Opportunity not found');
    }

    const prompt = `Generate 10 likely interview questions for this role with answer strategies and examples.

ROLE:
Title: ${opportunity.title}
Organization: ${opportunity.organization}
Description: ${opportunity.description}
Requirements: ${opportunity.requirements || 'Not specified'}

CANDIDATE BACKGROUND:
${user.resumeText || 'Not provided'}

For each question, provide:
1. The likely interview question
2. Strategy for answering effectively
3. Example answer using STAR method where applicable

Cover these categories:
- Technical/Role-specific (3 questions)
- Behavioral (3 questions)
- Situational (2 questions)
- Culture fit (2 questions)

Return as JSON array:
[
  {
    "question": "...",
    "answerStrategy": "...",
    "exampleAnswer": "..."
  }
]`;

    try {
      const aiText = await coreAiText('recommend', prompt, { surface: 'radar-interview-prep', userId, opportunityId }, 3000, 0.7, 'opportunity:' + opportunityId);

      const content = aiText || '[]';
      const questions = JSON.parse(content);

      return { questions };

    } catch (error) {
      console.error('Interview prep generation error:', error);
      throw new Error('Failed to generate interview preparation');
    }
  }

  /**
   * Generate salary negotiation advice
   */
  async generateSalaryNegotiation(
    userId: string,
    opportunityId: string,
    offeredSalary: number
  ): Promise<{
    analysis: string;
    suggestedRange: { min: number; max: number };
    negotiationScript: string;
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { resumeText: true, isPro: true }
    });

    if (!user?.isPro) {
      throw new Error('Pro subscription required for salary negotiation');
    }

    const opportunity = await prisma.opportunity.findUnique({
      where: { id: opportunityId }
    });

    if (!opportunity) {
      throw new Error('Opportunity not found');
    }

    const prompt = `Provide salary negotiation guidance for this situation.

ROLE: ${opportunity.title} at ${opportunity.organization}
LOCATION: ${opportunity.country}${opportunity.remote ? ' (Remote)' : ''}
OFFERED SALARY: $${offeredSalary}

CANDIDATE EXPERIENCE:
${user.resumeText || 'Not provided'}

Provide:
1. Market analysis and fairness assessment
2. Suggested counter-offer range
3. Negotiation script with specific talking points
4. Non-salary benefits to negotiate if salary is fixed

Return as JSON:
{
  "analysis": "...",
  "suggestedRange": { "min": X, "max": Y },
  "negotiationScript": "...",
  "alternativeBenefits": ["..."]
}`;

    try {
      const aiText = await coreAiText('recommend', prompt, { surface: 'radar-salary-negotiation', userId, opportunityId, offeredSalary }, 1500, 0.7, 'opportunity:' + opportunityId);

      const result = JSON.parse(aiText || '{}');

      return {
        analysis: result.analysis || '',
        suggestedRange: result.suggestedRange || { min: offeredSalary, max: offeredSalary * 1.15 },
        negotiationScript: result.negotiationScript || ''
      };

    } catch (error) {
      console.error('Salary negotiation error:', error);
      throw new Error('Failed to generate salary negotiation advice');
    }
  }

  /**
   * Parse and extract structured data from resume
   */
  async parseResume(resumeText: string): Promise<{
    skills: string[];
    industries: string[];
    yearsOfExperience: number;
    educationLevel: string;
    certifications: string[];
  }> {
    const prompt = `Parse this resume and extract structured information.

RESUME:
${resumeText}

Extract and return as JSON:
{
  "skills": ["skill1", "skill2", ...],
  "industries": ["industry1", "industry2", ...],
  "yearsOfExperience": <number>,
  "educationLevel": "High School | Bachelor's | Master's | PhD",
  "certifications": ["cert1", "cert2", ...]
}`;

    try {
      const aiText = await coreAiText('extract', prompt, { surface: 'radar-resume-parser' }, 1000, 0.3, 'resume-parse');

      const result = JSON.parse(aiText || '{}');

      return {
        skills: result.skills || [],
        industries: result.industries || [],
        yearsOfExperience: result.yearsOfExperience || 0,
        educationLevel: result.educationLevel || 'Not specified',
        certifications: result.certifications || []
      };

    } catch (error) {
      console.error('Resume parsing error:', error);
      return {
        skills: [],
        industries: [],
        yearsOfExperience: 0,
        educationLevel: 'Not specified',
        certifications: []
      };
    }
  }

  /**
   * Generate opportunity summary for quick scanning
   */
  async summarizeOpportunity(opportunityId: string): Promise<string> {
    const opportunity = await prisma.opportunity.findUnique({
      where: { id: opportunityId }
    });

    if (!opportunity) {
      throw new Error('Opportunity not found');
    }

    const prompt = `Summarize this opportunity in 2-3 concise sentences highlighting the most important aspects.

${opportunity.title}
${opportunity.description}

Focus on: role responsibilities, ideal candidate, and key benefits.
Make it scannable and action-oriented.`;

    try {
      const aiText = await coreAiText('summarize', prompt, { surface: 'radar-opportunity-summary', opportunityId }, 200, 0.5, 'opportunity:' + opportunityId);

      const summary = aiText || '';

      // Store AI summary
      await prisma.opportunity.update({
        where: { id: opportunityId },
        data: { aiSummary: summary }
      });

      return summary;

    } catch (error) {
      console.error('Opportunity summarization error:', error);
      return opportunity.description.substring(0, 200) + '...';
    }
  }
}
