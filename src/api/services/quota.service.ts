import { user_model } from '../../models/user.model';
import { DailyQuota, QuotaState, QuotaSummary } from '../../types/types';
import { Types } from 'mongoose';
import { nextResetAt, quotaForTier, startOfUtcDay } from '../../config/quota.config';
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

export async function getMateQuota(userId: string): Promise<QuotaState> {
  const user = await user_model
    .findById(userId)
    .select('subscription_tier stats.mates')
    .lean() as any;

  const tier = user?.subscription_tier ?? 'free';
  const limit = quotaForTier(tier).max_mates;
  const used = user?.stats?.mates || 0;

  return {
    used,
    limit,
    remaining: Math.max(0, limit - used)
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