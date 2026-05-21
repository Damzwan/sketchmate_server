import { Context, Next } from 'koa';
import { user_model } from '../models/user.model';
import { Capability, getLevelConfig, isCapabilityBlocked } from '../types/moderation.policy';
import { moderation_action_model } from '../models/moderation.model';

/**
 * Koa middleware factory: returns a middleware that lets the request through
 * only if the authenticated user has the given capability.
 *
 * Usage:
 *   postRouter.post('/publish', requireAuth, requireCapability(Capability.CREATE_POST), handler)
 *
 * The middleware:
 *   1. Reads the user's current restriction (already loaded by requireAuth).
 *   2. Lazily expires restrictions whose expires_at has passed (self-healing).
 *   3. Returns 403 with structured data the frontend can use to show the
 *      "Your Standing" sheet — never a generic "forbidden".
 */
export function requireCapability(capability: Capability) {
  return async (ctx: Context, next: Next) => {
    const user = ctx.state.user;
    if (!user) return ctx.throw(401, 'Not authenticated');

    const restriction = user.restriction;
    const now = new Date();

    // 1. SELF-EXPIRY: lazily lift restrictions that have run their course.
    // Cheaper than a cron job; checked at most once per gated request per user.
    if (restriction?.expires_at && new Date(restriction.expires_at) < now) {
      await liftExpiredRestriction(user._id);
      // ctx.state.user is stale now, but the request can proceed — they're clean
      ctx.state.user.restriction = { level: 0, blocked_capabilities: [] };
      return next();
    }

    // 2. Check capability against current restriction
    const level = restriction?.level ?? 0;
    if (level === 0) return next();

    const isBlocked =
      restriction?.blocked_capabilities?.includes(capability) ||
      isCapabilityBlocked(level, capability);

    if (!isBlocked) return next();

    // 3. STRUCTURED 403 — frontend uses this to render the restriction sheet
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
        applied_at: restriction?.applied_at
      }
    };
  };
}

/**
 * Lifts an expired restriction back to level 0 and appends a moderation_action
 * for the audit trail. Fire-and-forget — we don't block the request on this.
 */
async function liftExpiredRestriction(userId: string) {
  try {
    await user_model.updateOne(
      { _id: userId },
      {
        $set: {
          'restriction.level': 0,
          'restriction.blocked_capabilities': [],
          'restriction.expires_at': null
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

/**
 * Socket-side equivalent: check capability without throwing.
 * Returns null if allowed, or the restriction object if blocked.
 *
 * Use this in your socket handlers (chat:send_message, balloon emits, etc.)
 * because they can't use Koa middleware.
 */
export function checkCapability(user: any, capability: Capability): {
  blocked: boolean;
  restriction?: any;
} {
  const restriction = user?.restriction;
  if (!restriction || restriction.level === 0) return { blocked: false };

  if (restriction.expires_at && new Date(restriction.expires_at) < new Date()) {
    // Don't lift here — the next HTTP request will. Just treat as expired.
    return { blocked: false };
  }

  const blocked =
    restriction.blocked_capabilities?.includes(capability) ||
    isCapabilityBlocked(restriction.level, capability);

  if (!blocked) return { blocked: false };

  const config = getLevelConfig(restriction.level);
  return {
    blocked: true,
    restriction: {
      level: restriction.level,
      name: config.name,
      description: config.description,
      reason: restriction.reason,
      expires_at: restriction.expires_at
    }
  };
}