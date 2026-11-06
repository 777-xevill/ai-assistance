// Subscription plans. Prices and limits are placeholders: adjust them to your pricing.
// Billing collection is not wired up yet; a super admin assigns plans from the Admin page.

export interface Plan {
  id: string;
  name: string;
  priceMonthly: number; // USD
  aiRepliesPerMonth: number;
  channels: number;
  seats: number;
  highlights: string[];
}

export const PLANS: Plan[] = [
  {
    id: 'trial',
    name: 'Free trial',
    priceMonthly: 0,
    aiRepliesPerMonth: 300,
    channels: 3,
    seats: 2,
    highlights: ['All features', '300 AI replies', '14 days'],
  },
  {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 29,
    aiRepliesPerMonth: 2000,
    channels: 3,
    seats: 3,
    highlights: ['2,000 AI replies / month', '3 channels', 'Daily reports'],
  },
  {
    id: 'growth',
    name: 'Growth',
    priceMonthly: 79,
    aiRepliesPerMonth: 8000,
    channels: 8,
    seats: 8,
    highlights: ['8,000 AI replies / month', '8 channels', 'Priority support'],
  },
  {
    id: 'scale',
    name: 'Scale',
    priceMonthly: 199,
    aiRepliesPerMonth: 30000,
    channels: 30,
    seats: 30,
    highlights: ['30,000 AI replies / month', '30 channels', 'Dedicated onboarding'],
  },
];

export function getPlan(id: string): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}
