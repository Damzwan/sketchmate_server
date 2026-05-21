import Router from 'koa-router';
import { Types } from 'mongoose';
import { user_model } from '../../models/user.model';
import { getLevelConfig, ReportReason, STRIKE_LADDER } from '../../types/moderation.policy';
import { moderation_action_model, report_model } from '../../models/moderation.model';
import { applyStrike, getStanding, liftRestriction } from '../services/moderation.service';

/**
 * DEV-ONLY MODERATION ROUTER
 *
 * No auth. Two safety layers protect this from production:
 *   1. NODE_ENV check below — endpoints 404 in production
 *   2. Optional DEV_ADMIN_TOKEN — if set in env, every request must carry
 *      a matching x-dev-admin-token header. Leave unset for pure-localhost use.
 *
 * This router is meant to be called from a local admin dashboard with no user
 * session. Don't add requireAuth — there's no user to authenticate, and that
 * was the bug that made you read this file.
 */

export const devModerationRouter = new Router();

// Layer 1: refuse outside development. The mount-time guard in your app entry
// is the primary line of defense; this is the backup so a misconfigured deploy
// fails loud rather than silently shipping debug endpoints.
devModerationRouter.use(async (ctx, next) => {
  if (process.env.NODE_ENV === 'production') {
    return ctx.throw(404, 'Not found');
  }
  await next();
});

// Layer 2: optional shared-secret header. Skip entirely if DEV_ADMIN_TOKEN
// isn't set, which is the common case on a laptop.
devModerationRouter.use(async (ctx, next) => {
  const expected = process.env.DEV_ADMIN_TOKEN;
  if (!expected) return next();

  const provided = ctx.headers['x-dev-admin-token'];
  if (provided !== expected) {
    return ctx.throw(401, 'Invalid or missing x-dev-admin-token');
  }
  await next();
});


/**
 * POST /set-level
 *
 * Wipes existing strikes for the user, then applies N strikes through the
 * real applyStrike service so the full code path (audit log, restriction
 * recompute, socket emit) gets exercised.
 *
 * Body: { user_id: string, level: number, reason?: ReportReason }
 *
 * user_id is REQUIRED — there's no authenticated user to fall back to.
 */
devModerationRouter.post('/set-level', async (ctx) => {
  const body = ctx.request.body as { user_id?: string; level: number; reason?: ReportReason };
  const targetUserId = body.user_id;
  const targetLevel = body.level;
  const reason = body.reason || 'harassment';

  if (!targetUserId) return ctx.throw(400, 'user_id is required');
  if (typeof targetLevel !== 'number' || targetLevel < 0 || targetLevel >= STRIKE_LADDER.length) {
    return ctx.throw(400, `level must be 0..${STRIKE_LADDER.length - 1}`);
  }

  const user = await user_model.findById(targetUserId).select('_id name').lean() as any;
  if (!user) return ctx.throw(404, 'User not found');

  // Reset state so we always start from level 0. Direct writes here (not via
  // liftRestriction) because we want history wiped too, not just restriction.
  await Promise.all([
    moderation_action_model.deleteMany({
      user_id: new Types.ObjectId(targetUserId),
      action_type: { $in: ['strike_applied', 'restriction_applied', 'restriction_lifted'] }
    }),
    user_model.updateOne(
      { _id: targetUserId },
      {
        $set: {
          'restriction.level': 0,
          'restriction.blocked_capabilities': [],
          'restriction.reason': undefined,
          'restriction.applied_at': undefined,
          'restriction.expires_at': undefined,
          'strike_summary.active_strikes': 0,
          'strike_summary.total_strikes': 0,
          'strike_summary.last_strike_at': undefined
        }
      }
    )
  ]);

  // Walk up the ladder. The final applyStrike emits the socket event the
  // frontend modal listens for.
  const applied: any[] = [];
  for (let i = 0; i < targetLevel; i++) {
    const result = await applyStrike({
      userId: targetUserId,
      reason
    });
    applied.push({ step: i + 1, level: result.level });
  }

  const finalUser = await user_model
    .findById(targetUserId)
    .select('restriction strike_summary')
    .lean() as any;
  const config = getLevelConfig(finalUser?.restriction?.level ?? 0);

  ctx.body = {
    success: true,
    user_id: targetUserId,
    user_name: user.name,
    target_level: targetLevel,
    actual_level: finalUser?.restriction?.level ?? 0,
    level_name: config.name,
    level_description: config.description,
    blocks: config.blocks,
    expires_at: finalUser?.restriction?.expires_at ?? null,
    strikes_applied: applied,
    strike_summary: finalUser?.strike_summary,
    note: 'Watch the moderation:strike socket event on the client — the modal should fire.'
  };
});


/**
 * POST /clear
 *
 * Resets the user to good standing AND wipes strike history.
 * The liftRestriction call writes an audit entry; the subsequent deleteMany
 * wipes the strike events themselves (something liftRestriction deliberately
 * does NOT do in production).
 */
devModerationRouter.post('/clear', async (ctx) => {
  const body = ctx.request.body as { user_id?: string };
  const targetUserId = body.user_id;

  if (!targetUserId) return ctx.throw(400, 'user_id is required');

  // adminId is mandatory on liftRestriction. We pass the target's own ID as
  // a placeholder — there's no real admin here. The audit entry will note
  // it was a DEV operation via the `notes` field.
  await liftRestriction({
    userId: targetUserId,
    adminId: targetUserId,
    notes: 'DEV: cleared via /dev/moderation/clear',
    reason: 'manual_override'
  });

  await Promise.all([
    moderation_action_model.deleteMany({
      user_id: new Types.ObjectId(targetUserId),
      action_type: 'strike_applied'
    }),
    user_model.updateOne(
      { _id: targetUserId },
      {
        $set: {
          'strike_summary.active_strikes': 0,
          'strike_summary.total_strikes': 0,
          'strike_summary.last_strike_at': undefined
        }
      }
    )
  ]);

  ctx.body = { success: true, user_id: targetUserId, note: 'All strikes and restrictions cleared.' };
});


/**
 * GET /inspect?user_id=...
 *
 * Returns the same payload as the production /report/standing endpoint —
 * verifies what the frontend Standing page would render for this user.
 */
devModerationRouter.get('/inspect', async (ctx) => {
  const targetUserId = ctx.query.user_id as string;
  if (!targetUserId) return ctx.throw(400, 'user_id query param is required');
  const standing = await getStanding(targetUserId);
  ctx.body = standing;
});


/**
 * POST /simulate-report
 *
 * Inserts synthetic reports against a target without running auto-moderation.
 * Each report uses a fresh fake reporter_id so the unique index lets them
 * accumulate (a real reporter can only report a target once).
 *
 * Body: { target_id, target_type, reason, count?, target_author_id? }
 *
 * target_author_id is the user who'll receive strikes if the reports are
 * upheld. Required because we don't have an auth session to default to.
 */
devModerationRouter.post('/simulate-report', async (ctx) => {
  const { target_id, target_type, reason, count = 5, target_author_id } = ctx.request.body as {
    target_id: string;
    target_type: string;
    reason: ReportReason;
    count?: number;
    target_author_id?: string;
  };

  if (!target_id || !target_type || !reason) {
    return ctx.throw(400, 'target_id, target_type, and reason are required');
  }
  if (!target_author_id) {
    return ctx.throw(400, 'target_author_id is required (the user who would receive strikes)');
  }

  const inserts = [];
  for (let i = 0; i < count; i++) {
    inserts.push({
      reporter_id: new Types.ObjectId(),  // fresh fake reporter each time
      target_id: new Types.ObjectId(target_id),
      target_type,
      target_author_id: new Types.ObjectId(target_author_id),
      reason,
      status: 'pending',
      content_snapshot: { dev_simulated: true }
    });
  }

  await report_model.insertMany(inserts);

  ctx.body = {
    success: true,
    inserted: count,
    note: `Inserted ${count} reports against ${target_id}. Auto-moderation does NOT run automatically — call /dev/moderation/trigger-auto-mod or upload-resolve manually to test thresholds.`
  };
});

export default devModerationRouter;