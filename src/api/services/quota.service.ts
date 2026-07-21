import dayjs from 'dayjs';
import { user_model } from '../../models/user.model';
import { DailyQuota, QuotaState, QuotaSummary } from '../../types/types';
import { Types } from 'mongoose';
import { MATE_WINDOW_DAYS, nextResetAt, quotaForTier, startOfUtcDay } from '../../config/quota.config';
import { quota_usage_model } from '../../models/quota_usage.model';

export class QuotaExceededError extends Error {
  public readonly kind: 'balloon' | 'post' | 'mate';
  public readonly state: QuotaState;

  constructor(kind: 'balloon' | 'post' | 'mate', state: QuotaState) {
    super(`Daily ${kind} quota exceeded`);
    this.name = 'QuotaExceededError';
    this.kind = kind;
    this.state = state;
  }
}

export async function getTier(userId: string): Promise<string> {
  const user = await user_model
    .findById(userId)
    .select('subscription_tier')
    .lean() as { subscription_tier?: string } | null;
  return user?.subscription_tier ?? 'free';
}

/**
 * Count the number of balloons this user has SENT today. Cancelled and
 * expired balloons still count — once you've launched it, you've used
 * the slot for the day.
 */
async function countBalloonsToday(userId: string): Promise<number> {
  const usage = await quota_usage_model.findOne({
    user_id: new Types.ObjectId(userId),
    date: startOfUtcDay()
  }).lean();

  return usage?.balloons_sent || 0;
}

/**
 * Count active posts created today. Deleted posts don't count — if you
 * delete and re-post, that's fine.
 */
async function countPostsToday(userId: string): Promise<number> {
  const usage = await quota_usage_model.findOne({
    user_id: new Types.ObjectId(userId),
    date: startOfUtcDay()
  }).lean();

  return usage?.posts_created || 0;
}

function buildState(used: number, limit: number): QuotaState {
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    reset_at: nextResetAt().toISOString()
  };
}

export async function getBalloonQuota(userId: string): Promise<QuotaState> {
  const tier = await getTier(userId);
  const limit = quotaForTier(tier).balloons_per_day;
  const used = await countBalloonsToday(userId);
  return buildState(used, limit);
}

export async function getPostQuota(userId: string): Promise<QuotaState> {
  const tier = await getTier(userId);
  const limit = quotaForTier(tier).posts_per_day;
  const used = await countPostsToday(userId);
  return buildState(used, limit);
}

/**
 * New mates this user has made in the rolling window, plus when the oldest of
 * them ages out (so the client can say "resets in 2 days"). Cancelled/unfriended
 * mates are NOT subtracted: you spent the slot the moment you formed the bond.
 */
async function countMatesThisWeek(
  userId: string
): Promise<{ count: number; resetAt?: string }> {
  const windowStart = startOfUtcDay(
    dayjs().subtract(MATE_WINDOW_DAYS - 1, 'day').toDate()
  );

  const docs = await quota_usage_model
    .find({
      user_id: new Types.ObjectId(userId),
      date: { $gte: windowStart },
      mates_made: { $gt: 0 }
    })
    .select('date mates_made')
    .lean();

  const count = docs.reduce((sum, d: any) => sum + (d.mates_made || 0), 0);

  let resetAt: string | undefined;
  if (docs.length) {
    const oldest = docs.reduce(
      (min: Date, d: any) => (d.date < min ? d.date : min),
      docs[0].date as Date
    );
    resetAt = dayjs(oldest).add(MATE_WINDOW_DAYS, 'day').toISOString();
  }

  return { count, resetAt };
}

/** Increment today's mate counter. Called once per user each time a mate forms. */
export async function recordMateMade(userId: string): Promise<void> {
  await quota_usage_model.updateOne(
    { user_id: new Types.ObjectId(userId), date: startOfUtcDay() },
    { $inc: { mates_made: 1 } },
    { upsert: true }
  );
}

export async function getMateQuota(userId: string): Promise<QuotaState> {
  const tier = await getTier(userId);
  const limit = quotaForTier(tier).mates_per_week;

  const { count, resetAt } = await countMatesThisWeek(userId);

  // Unlimited (Pro/Lifetime): report usage for context, but no ceiling. reset_at
  // is meaningless without a cap, so it's omitted.
  if (limit === null) {
    return { used: count, limit: null, remaining: Number.MAX_SAFE_INTEGER };
  }

  return {
    used: count,
    limit,
    remaining: Math.max(0, limit - count),
    reset_at: resetAt
  };
}

export async function getQuotaSummary(userId: string): Promise<QuotaSummary> {
  const tier = await getTier(userId);
  const q: DailyQuota = quotaForTier(tier);

  const [balloonsUsed, postsUsed, mateState] = await Promise.all([
    countBalloonsToday(userId),
    countPostsToday(userId),
    getMateQuota(userId)
  ]);

  return {
    tier,
    balloons: buildState(balloonsUsed, q.balloons_per_day),
    posts: buildState(postsUsed, q.posts_per_day),
    mates: mateState
  };
}


export async function assertBalloonQuota(userId: string): Promise<QuotaState> {
  const state = await getBalloonQuota(userId);
  if (state.remaining <= 0) {
    throw new QuotaExceededError('balloon', state);
  }
  return state;
}

export async function assertPostQuota(userId: string): Promise<QuotaState> {
  const state = await getPostQuota(userId);
  if (state.remaining <= 0) {
    throw new QuotaExceededError('post', state);
  }
  return state;
}

export async function assertMateQuota(userId: string): Promise<QuotaState> {
  const state = await getMateQuota(userId);
  if (state.remaining <= 0) {
    throw new QuotaExceededError('mate', state);
  }
  return state;
}