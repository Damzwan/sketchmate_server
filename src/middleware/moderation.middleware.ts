import { Context, Next } from 'koa';
import { user_model } from '../models/user.model';
import { Capability, getLevelConfig, isCapabilityBlocked } from '../types/moderation.policy';
import { moderation_action_model } from '../models/moderation.model';

export function requireCapability(capability: Capability) {
  return async (ctx: Context, next: Next) => {
    const user = ctx.state.user;
    if (!user) return ctx.throw(401, 'Not authenticated');

    const restriction = user.restriction;
    const now = new Date();

    // 1. SELF-EXPIRY: lazily lift restrictions that have run their course.
    if (restriction?.expires_at && new Date(restriction.expires_at) < now) {
      await liftExpiredRestriction(user._id);
      ctx.state.user.restriction = { level: 0 };
      return next();
    }

    // 2. DYNAMIC CHECK: we only care about their current level
    const level = restriction?.level ?? 0;
    if (level === 0) return next();

    const isBlocked = isCapabilityBlocked(level, capability);
    if (!isBlocked) return next();

    // 3. STRUCTURED 403 — hydrate the blocked_capabilities from the config layout dynamically
    const config = getLevelConfig(level);
    ctx.status = 403;
    ctx.body = {
      error: 'capability_blocked',
      capability,
      restriction: {
        level,
        name: config.name,
        description: config.description,
        reason: restriction?.reason,
        expires_at: restriction?.expires_at,
        applied_at: restriction?.applied_at,
        blocked_capabilities: config.blocks // Fed dynamically directly down to frontend view layout builders
      }
    };
  };
}

async function liftExpiredRestriction(userId: string) {
  try {
    // Dynamic schema update: keeping the base fields safe without static redundancy trackers
    await user_model.updateOne(
      { _id: userId },
      {
        $set: {
          'restriction.level': 0,
          'restriction.expires_at': null,
          'restriction.reason': 'decay'
        }
      }
    );
    await moderation_action_model.create({
      user_id: userId,
      action_type: 'restriction_lifted',
      level: 0,
      notes: 'Auto-lifted on expiry'
    });
  } catch (err) {
    console.error('liftExpiredRestriction error:', err);
  }
}

export async function checkSocketCapability(
  userId: string,
  capability: Capability
): Promise<{ blocked: boolean; restriction?: any }> {
  const user = await user_model
    .findById(userId)
    .select('restriction')
    .lean() as any;

  const restriction = user?.restriction;
  if (!restriction || restriction.level === 0) return { blocked: false };

  if (restriction.expires_at && new Date(restriction.expires_at) < new Date()) {
    return { blocked: false };
  }

  const isBlocked = isCapabilityBlocked(restriction.level, capability);
  if (!isBlocked) return { blocked: false };

  const config = getLevelConfig(restriction.level);

  return {
    blocked: true,
    restriction: {
      level: restriction.level,
      reason: restriction.reason,
      expires_at: restriction.expires_at,
      blocked_capabilities: config.blocks
    }
  };
}