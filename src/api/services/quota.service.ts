import { user_model } from '../../models/user.model';
import { DailyQuota, QuotaState, QuotaSummary } from '../../types/types';
import { balloon_model } from '../../models/balloon.model';
import { Types } from 'mongoose';
import { nextResetAt, quotaForTier, startOfUtcDay } from '../../config/quota.config';
import { post_model } from '../../models/post.model';

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

async function getTier(userId: string): Promise<string> {
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
  return balloon_model.countDocuments({
    sender: new Types.ObjectId(userId),
    createdAt: { $gte: startOfUtcDay() }
  });
}

/**
 * Count active posts created today. Deleted posts don't count — if you
 * delete and re-post, that's fine.
 */
async function countPostsToday(userId: string): Promise<number> {
  return post_model.countDocuments({
    author_id: new Types.ObjectId(userId),
    status: 'active',
    createdAt: { $gte: startOfUtcDay() }
  });
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
    posts: buildState(postsUsed, q.posts_per_day)
  };
}

/**
 * Throw if the user has no balloon budget remaining. Call this at the
 * start of `createBalloonV2`. Returns the fresh state for callers that
 * want to attach it to a success response.
 */
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