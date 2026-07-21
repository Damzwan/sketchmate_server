import Router from 'koa-router';
import { Types } from 'mongoose';
import { user_model } from '../../models/user.model';
import { ReportReason, STRIKE_LADDER } from '../../types/moderation.policy';
import { moderation_action_model, report_model } from '../../models/moderation.model';
import {
  applyStrike,
  getStanding,
  liftRestriction,
  notifyContentModeration,
  removeContent,
  restoreContent
} from '../services/moderation.service';
import { requireAdminAuth } from '../../middleware/adminAuth.middleware';
import { s3Creator } from '../../mongodb';

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

devModerationRouter.post('/:report_id/resolve', async (ctx) => {
  if (!ctx.state.user.is_admin) return ctx.throw(403);

  // ADDED 'remove_only'
  const { action } = ctx.request.body as { action: 'uphold' | 'dismiss' | 'remove_only' };
  const report = await report_model.findById(ctx.params.report_id);
  if (!report) return ctx.throw(404);
  if (report.status === 'upheld' || report.status === 'dismissed') {
    return ctx.throw(400, 'Already resolved');
  }

  // Both 'uphold' and 'remove_only' mean we agreed the content was bad (upheld the report)
  report.status = action === 'dismiss' ? 'dismissed' : 'upheld';
  report.resolved_at = new Date();
  report.resolved_by = ctx.state.user._id;
  await report.save();

  let notify: 'removed' | 'restored' | null = null;

  if (action === 'uphold') {
    // 1. Strike the user AND remove the content
    await applyStrike({
      userId: report.target_author_id.toString(),
      reason: report.reason as ReportReason,
      sourceReportId: report._id.toString(),
      adminId: ctx.state.user._id.toString()
    });
    await removeContent(report.target_type, report.target_id.toString());
    notify = 'removed';
  } else if (action === 'remove_only') {
    await removeContent(report.target_type, report.target_id.toString());
    notify = 'removed';
  } else {
    // Only announce a restore that actually restored something.
    const restored = await restoreContent(report.target_type, report.target_id.toString());
    if (restored) notify = 'restored';
  }

  // 'remove_only' skips the strike, but the author still has to be told their
  // content is gone — this was the silent path that made posts look like they
  // had simply vanished.
  if (notify && report.target_type !== 'user') {
    await notifyContentModeration({
      authorId: report.target_author_id.toString(),
      type: report.target_type,
      targetId: report.target_id.toString(),
      event: notify
    });
  }

  ctx.body = { success: true };
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
  const report = await report_model.findById(ctx.params.report_id);
  if (!report) return ctx.throw(404);

  const restored = report.target_type === 'user'
    ? false
    : await restoreContent(report.target_type, report.target_id.toString());

  report.status = 'dismissed';
  report.resolved_at = new Date();
  report.resolved_by = ctx.state.user._id;
  await report.save();

  if (restored) {
    await notifyContentModeration({
      authorId: report.target_author_id.toString(),
      type: report.target_type,
      targetId: report.target_id.toString(),
      event: 'restored'
    });
  }

  ctx.body = { success: true, restored };
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
  const status = (ctx.query.status as string) || 'pending';
  const reports = await report_model
    .find({ status: { $in: status.split(',') } })
    .sort({ createdAt: 1 })
    .limit(50)
    .populate('reporter_id', 'name img')
    .populate('target_author_id', 'name img restriction strike_summary')
    .lean();

  const signedReports = await Promise.all(reports.map(async (r: any) => {
    if (r.content_snapshot?.snapshot_url) {
      const signed = await s3Creator.getSnapshotSignedUrl(r.content_snapshot.snapshot_url);
      if (signed) r.content_snapshot.snapshot_signed_url = signed;
    }
    return r;
  }));

  ctx.body = { reports: signedReports };
});

export default devModerationRouter;