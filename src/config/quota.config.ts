import { DailyQuota, SubscriptionTier } from '../types/types';

export const QUOTAS: Record<SubscriptionTier, DailyQuota> = {
  free: {
    balloons_per_day: 2,
    posts_per_day: 2
  },
  pro: {
    balloons_per_day: 5,
    posts_per_day: 6
  }
};

export function quotaForTier(tier: string | undefined): DailyQuota {
  return QUOTAS[(tier as SubscriptionTier)] ?? QUOTAS.free;
}


export function startOfUtcDay(now = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}


export function nextResetAt(now = new Date()): Date {
  const d = startOfUtcDay(now);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
