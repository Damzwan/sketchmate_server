import Router from 'koa-router';
import { Types } from 'mongoose';
import { user_model } from '../../models/user.model';
import { ReportReason, STRIKE_LADDER } from '../../types/moderation.policy';
import { moderation_action_model, report_model } from '../../models/moderation.model';
import {
  applyStrike,
  getStanding,
  liftRestriction
} from '../services/moderation.service';
import {
  getModerationQueue,
  parseQueueQuery,
  ResolveAction,
  resolveAuthorReports,
  resolveReport,
  restoreReport
} from '../services/moderationQueue.service';
import { requireAdminAuth } from '../../middleware/adminAuth.middleware';

export const devModerationRouter = new Router();

devModerationRouter.use(requireAdminAuth);

// =============================================================================
// PRODUCTION-PARITY ENDPOINTS
// =============================================================================

devModerationRouter.get('/standing/:user_id', async (ctx) => {
  const targetUserId = ctx.params.user_id;
  if (!targetUserId) return ctx.throw(400, 'user_id is required');
  ctx.body = await getStanding(targetUserId);
});

const RESOLVE_ACTIONS: ResolveAction[] = ['uphold', 'remove_only', 'dismiss'];

devModerationRouter.post('/:report_id/resolve', async (ctx) => {
  const { action } = ctx.request.body as { action: ResolveAction };
  if (!RESOLVE_ACTIONS.includes(action)) return ctx.throw(400, 'Invalid action');

  const result = await resolveReport({
    reportId: ctx.params.report_id,
    action,
    adminId: ctx.state.user._id.toString()
  });

  if (!result.ok) {
    return result.error === 'not_found'
      ? ctx.throw(404)
      : ctx.throw(400, 'Already resolved');
  }

  ctx.body = { success: true, ...result };
});

/**
 * POST /user/:user_id/resolve — one decision for everything open on an author.
 *
 * The queue groups by user because that is how the judgement is actually made;
 * this is the button that matches it. One strike for the batch, every distinct
 * piece of content actioned once.
 */
devModerationRouter.post('/user/:user_id/resolve', async (ctx) => {
  const { action } = ctx.request.body as { action: ResolveAction };
  if (!RESOLVE_ACTIONS.includes(action)) return ctx.throw(400, 'Invalid action');

  const result = await resolveAuthorReports({
    authorId: ctx.params.user_id,
    action,
    adminId: ctx.state.user._id.toString()
  });

  if (!result.ok) {
    return result.error === 'nothing_open'
      ? ctx.throw(400, 'No open reports for this user')
      : ctx.throw(404);
  }

  ctx.body = { success: true, ...result };
});

/**
 * POST /:report_id/restore — undo a resolution.
 *
 * /resolve refuses to touch an already-resolved report, which left removed
 * content with no way back: it drops out of the pending queue the moment it is
 * actioned, so a mistaken removal (or a granted appeal) was unrecoverable from
 * the dashboard. This is the one endpoint that accepts a resolved report.
 */
devModerationRouter.post('/:report_id/restore', async (ctx) => {
  const result = await restoreReport({
    reportId: ctx.params.report_id,
    adminId: ctx.state.user._id.toString()
  });
  if (!result.ok) return ctx.throw(404);

  ctx.body = { success: true, restored: result.restored };
});

// =============================================================================
// DEV UTILITIES
// =============================================================================

devModerationRouter.post('/set-level', async (ctx) => {
  const { user_id, level, reason = 'harassment' } = ctx.request.body as {
    user_id?: string;
    level: number;
    reason?: ReportReason
  };

  if (!user_id) return ctx.throw(400, 'user_id is required');
  if (typeof level !== 'number' || level < 0 || level >= STRIKE_LADDER.length) {
    return ctx.throw(400, `level must be 0..${STRIKE_LADDER.length - 1}`);
  }

  // Clear tracking state
  await Promise.all([
    moderation_action_model.deleteMany({ user_id: new Types.ObjectId(user_id) }),
    user_model.updateOne(
      { _id: user_id },
      {
        $set: {
          'restriction.level': 0,
          'strike_summary.active_strikes': 0,
          'strike_summary.total_strikes': 0,
          'strike_summary.last_strike_at': null
        },
        $unset: { 'restriction.reason': 1, 'restriction.expires_at': 1 }
      }
    )
  ]);

  // If selecting level 0, we are already explicitly configured and cleared!

  if (level > 0) {
    const currentAdminId = ctx.state.user._id ? String(ctx.state.user._id) : undefined;
    for (let i = 0; i < level; i++) {
      await applyStrike({
        userId: user_id,
        reason,
        adminId: currentAdminId
      });
    }
  }

  ctx.body = await getStanding(user_id);
});

devModerationRouter.post('/clear', async (ctx) => {
  const { user_id } = ctx.request.body as { user_id?: string };
  if (!user_id) return ctx.throw(400, 'user_id is required');

  await liftRestriction({
    userId: user_id,
    adminId: ctx.state.user._id.toString(),
    reason: 'manual_override',
    notes: 'ADMIN: cleared via admin panel'
  });

  await moderation_action_model.deleteMany({ user_id: new Types.ObjectId(user_id) });

  await user_model.updateOne(
    { _id: user_id },
    { $set: { 'strike_summary.active_strikes': 0, 'strike_summary.total_strikes': 0 } }
  );

  ctx.body = { success: true };
});

devModerationRouter.post('/simulate-report', async (ctx) => {
  const { target_id, target_type, reason, count = 5, target_author_id } = ctx.request.body as any;

  const inserts = Array.from({ length: count }).map(() => ({
    reporter_id: new Types.ObjectId(),
    target_id: new Types.ObjectId(target_id),
    target_type,
    target_author_id: new Types.ObjectId(target_author_id),
    reason,
    status: 'pending'
  }));

  await report_model.insertMany(inserts);
  ctx.body = { success: true, count };
});

devModerationRouter.get('/queue', async (ctx) => {
  ctx.body = await getModerationQueue(parseQueueQuery(ctx.query));
});

export default devModerationRouter;