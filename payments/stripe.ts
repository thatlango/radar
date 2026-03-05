import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16'
});

export class PaymentSystem {
  /**
   * Create Stripe checkout session for Pro upgrade
   */
  async createProCheckout(userId: string, experimentVariant?: 'A' | 'B'): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, isPro: true }
    });

    if (!user) {
      throw new Error('User not found');
    }

    if (user.isPro) {
      throw new Error('User already has Pro subscription');
    }

    // A/B testing pricing
    const price = experimentVariant === 'B' ? 3900 : 4900; // $39 vs $49

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Radar Pro - Lifetime Access',
              description: 'One-time payment for AI-powered career tools',
              images: ['https://radar.app/pro-badge.png']
            },
            unit_amount: price
          },
          quantity: 1
        }
      ],
      success_url: `${process.env.APP_URL}/pro/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/pro`,
      client_reference_id: userId,
      metadata: {
        userId,
        experimentVariant: experimentVariant || 'A'
      }
    });

    // Track payment attempt
    await prisma.payment.create({
      data: {
        userId,
        amount: price / 100,
        currency: 'USD',
        status: 'pending',
        stripeSessionId: session.id,
        type: 'pro',
        metadata: {
          experimentVariant
        }
      }
    });

    return session.url!;
  }

  /**
   * Handle Stripe webhook events
   */
  async handleWebhook(event: Stripe.Event): Promise<void> {
    console.log(`[PaymentSystem] Processing webhook: ${event.type}`);

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'payment_intent.succeeded':
        await this.handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;

      case 'payment_intent.payment_failed':
        await this.handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  }

  /**
   * Handle successful checkout
   */
  private async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const userId = session.client_reference_id || session.metadata?.userId;

    if (!userId) {
      console.error('No userId found in checkout session');
      return;
    }

    try {
      // Upgrade user to Pro
      await prisma.user.update({
        where: { id: userId },
        data: { isPro: true }
      });

      // Update payment record
      await prisma.payment.updateMany({
        where: { stripeSessionId: session.id },
        data: {
          status: 'completed',
          stripePaymentIntent: session.payment_intent as string,
          paymentDate: new Date()
        }
      });

      // Track conversion event
      const payment = await prisma.payment.findFirst({
        where: { stripeSessionId: session.id }
      });

      if (payment?.metadata && (payment.metadata as any).experimentVariant) {
        await this.trackConversion(
          userId,
          (payment.metadata as any).experimentVariant
        );
      }

      // Send confirmation email
      await this.sendProWelcomeEmail(userId);

      console.log(`[PaymentSystem] User ${userId} upgraded to Pro`);

    } catch (error) {
      console.error('Error handling checkout completion:', error);
      throw error;
    }
  }

  /**
   * Handle successful payment intent
   */
  private async handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    await prisma.payment.updateMany({
      where: { stripePaymentIntent: paymentIntent.id },
      data: { status: 'completed' }
    });

    console.log(`[PaymentSystem] Payment succeeded: ${paymentIntent.id}`);
  }

  /**
   * Handle failed payment
   */
  private async handlePaymentFailed(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    await prisma.payment.updateMany({
      where: { stripePaymentIntent: paymentIntent.id },
      data: { status: 'failed' }
    });

    console.log(`[PaymentSystem] Payment failed: ${paymentIntent.id}`);
  }

  /**
   * Track conversion for A/B test
   */
  private async trackConversion(userId: string, variant: 'A' | 'B'): Promise<void> {
    // This would integrate with your A/B testing system
    console.log(`[PaymentSystem] Conversion tracked: User ${userId}, Variant ${variant}`);

    // Update experiment metrics
    // In production, this would update PostHog, Amplitude, etc.
  }

  /**
   * Send Pro welcome email
   */
  private async sendProWelcomeEmail(userId: string): Promise<void> {
    // Implementation would use your email service
    console.log(`[PaymentSystem] Sending Pro welcome email to user ${userId}`);
  }

  /**
   * Check and process referral rewards
   */
  async checkReferralRewards(userId: string): Promise<void> {
    const referralCount = await prisma.referral.count({
      where: {
        referrerId: userId,
        status: 'converted'
      }
    });

    // Unlock Pro after 3 successful referrals
    if (referralCount >= 3) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { isPro: true }
      });

      if (!user?.isPro) {
        await prisma.user.update({
          where: { id: userId },
          data: { isPro: true }
        });

        // Mark referrals as rewarded
        await prisma.referral.updateMany({
          where: {
            referrerId: userId,
            status: 'converted',
            rewardGranted: false
          },
          data: { rewardGranted: true }
        });

        console.log(`[PaymentSystem] User ${userId} unlocked Pro via referrals!`);
      }
    }
  }

  /**
   * Process referral conversion
   */
  async processReferralConversion(referredUserId: string): Promise<void> {
    const referral = await prisma.referral.findFirst({
      where: {
        referredId: referredUserId,
        status: 'pending'
      }
    });

    if (referral) {
      await prisma.referral.update({
        where: { id: referral.id },
        data: {
          status: 'converted',
          convertedAt: new Date()
        }
      });

      // Check if referrer should be rewarded
      await this.checkReferralRewards(referral.referrerId);

      console.log(`[PaymentSystem] Referral converted for user ${referredUserId}`);
    }
  }

  /**
   * Get payment history for user
   */
  async getPaymentHistory(userId: string): Promise<any[]> {
    return await prisma.payment.findMany({
      where: { userId },
      orderBy: { paymentDate: 'desc' }
    });
  }

  /**
   * Generate invoice/receipt
   */
  async generateReceipt(paymentId: string): Promise<{
    amount: number;
    date: Date;
    receiptUrl: string;
  }> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { user: true }
    });

    if (!payment) {
      throw new Error('Payment not found');
    }

    // In production, generate actual receipt PDF
    return {
      amount: payment.amount,
      date: payment.paymentDate || new Date(),
      receiptUrl: `https://radar.app/receipts/${paymentId}`
    };
  }

  /**
   * Handle refund request
   */
  async processRefund(
    paymentId: string,
    reason: string
  ): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId }
    });

    if (!payment || !payment.stripePaymentIntent) {
      throw new Error('Payment not found or not eligible for refund');
    }

    // Process Stripe refund
    const refund = await stripe.refunds.create({
      payment_intent: payment.stripePaymentIntent,
      reason: 'requested_by_customer'
    });

    // Update database
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'refunded' }
    });

    // Downgrade user
    await prisma.user.update({
      where: { id: payment.userId },
      data: { isPro: false }
    });

    console.log(`[PaymentSystem] Refund processed: ${refund.id}`);
  }

  /**
   * Get Pro upgrade statistics
   */
  async getProStats(): Promise<{
    totalRevenue: number;
    totalProUsers: number;
    conversionRate: number;
    averageTimeToConversion: number;
  }> {
    const [totalUsers, proUsers, payments] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isPro: true } }),
      prisma.payment.findMany({
        where: { status: 'completed', type: 'pro' }
      })
    ]);

    const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);
    const conversionRate = totalUsers > 0 ? (proUsers / totalUsers) * 100 : 0;

    return {
      totalRevenue,
      totalProUsers: proUsers,
      conversionRate,
      averageTimeToConversion: 0 // Calculate based on user creation vs upgrade time
    };
  }

  /**
   * Apply discount code
   */
  async applyDiscountCode(
    userId: string,
    code: string
  ): Promise<{
    valid: boolean;
    discountPercent?: number;
    newPrice?: number;
  }> {
    // Implement discount code logic
    const validCodes: Record<string, number> = {
      'LAUNCH50': 50,
      'AFRICA25': 25,
      'STUDENT30': 30
    };

    const discountPercent = validCodes[code.toUpperCase()];

    if (discountPercent) {
      const originalPrice = 49;
      const newPrice = originalPrice * (1 - discountPercent / 100);

      return {
        valid: true,
        discountPercent,
        newPrice
      };
    }

    return { valid: false };
  }
}
