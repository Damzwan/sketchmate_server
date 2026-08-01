import { user_model } from '../../models/user.model';
import { DailyQuota, QuotaState, QuotaSummary } from '../../types/types';
import { Types } from 'mongoose';
import { nextResetAt, quotaForTier, startOfUtcDay } from '../../config/quota.config';
import { quota_usage_model } from '../../models/quota_usage.model';

export class QuotaExceededError extends Error {
  public readonly kind: 'balloon' | 'post';
  public readonly state: QuotaState;

  constructor(kind: 'balloon' | 'post', state: QuotaState) {
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
 * Give back a post slot when a post from the current quota day is deleted.
 *
 * The guarded update makes retries safe and prevents a corrupt/legacy usage row
 * from going negative. Posts from an earlier UTC day never affect today's quota.
 */
export async function releasePostQuota(
  userId: string,
  postCreatedAt: Date,
  now = new Date()
): Promise<QuotaState> {
  const dayStart = startOfUtcDay(now);
  const dayEnd = nextResetAt(now);
  const belongsToCurrentQuotaDay =
    postCreatedAt >= dayStart && postCreatedAt < dayEnd;

  if (belongsToCurrentQuotaDay) {
    await quota_usage_model.updateOne(
      {
        user_id: new Types.ObjectId(userId),
        date: dayStart,
        posts_created: { $gt: 0 }
      },
      { $inc: { posts_created: -1 } }
    );
  }

  return getPostQuota(userId);
}

export async function getQuotaSummary(userId: string): Promise<QuotaSummary> {
  const tier = await getTier(userId);
  const q: DailyQuota = quotaForTier(tier);

  const [balloonsUsed, postsUsed] = await Promise.all([
    countBalloonsToday(userId),
    countPostsToday(userId)
  ]);

  return {
    tier,
    balloons: buildState(balloonsUsed, q.balloons_per_day),
    posts: buildState(postsUsed, q.posts_per_day),
    // Mobile releases are staggered. Older clients still read this field and
    // treat a missing value as zero, so report explicit unlimited access until
    // those versions have aged out; current clients ignore it.
    mates: { used: 0, limit: null, remaining: Number.MAX_SAFE_INTEGER }
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
