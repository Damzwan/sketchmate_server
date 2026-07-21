import { DailyQuota, SubscriptionTier } from '../types/types';

// `mates_per_week: null` means unlimited — the whole point of Pro here is that
// the weekly friend-making cap is a free-tier pace limit, not a ceiling.
export const QUOTAS: Record<SubscriptionTier, DailyQuota> = {
  free: {
    balloons_per_day: 2,
    posts_per_day: 2,
    mates_per_week: 3
  },
  pro: {
    balloons_per_day: 5,
    posts_per_day: 6,
    mates_per_week: null
  },
  // Lifetime = all access; at least Pro limits.
  lifetime: {
    balloons_per_day: 5,
    posts_per_day: 6,
    mates_per_week: null
  }
};

// Rolling window for the weekly mate cap: today plus the 6 prior UTC days. A
// mate made on day D stops counting at the start of D+7, so slots free up one
// at a time rather than all at once on a fixed reset boundary.
export const MATE_WINDOW_DAYS = 7;

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
