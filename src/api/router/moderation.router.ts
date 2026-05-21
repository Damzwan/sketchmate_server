import Router from 'koa-router';
import dayjs from 'dayjs';
import { Types } from 'mongoose';
import { requireAuth } from '../../middleware/auth';
import { post_comment_model, post_model } from '../../models/post.model';
import { balloon_model } from '../../models/balloon.model';
import { message_model } from '../../models/message.model';
import { user_model } from '../../models/user.model';

import { applyStrike, getStanding } from '../services/moderation.service';
import {
  POLICY_CONSTANTS,
  REPORT_REASONS,
  REPORTABLE,
  ReportableType,
  ReportReason
} from '../../types/moderation.policy';
import { report_model } from '../../models/moderation.model';

export const moderationRouter = new Router();
moderationRouter.use(requireAuth);

// =============================================================================
// POST /report — user submits a report
// =============================================================================
moderationRouter.post('/', async (ctx) => {
  const { target_id, target_type, reason, details } = ctx.request.body as any;
  const reporter_id = ctx.state.user._id.toString();

  // ---- Validation ----
  if (!REPORTABLE[target_type as ReportableType]) {
    return ctx.throw(400, 'Invalid target_type');
  }
  if (!REPORT_REASONS[reason as ReportReason]) {
    return ctx.throw(400, 'Invalid reason');
  }

  // ---- Anti-spam: per-reporter cooldown ----
  const recent = await report_model
    .findOne({ reporter_id })
    .sort({ createdAt: -1 })
    .select('createdAt')
    .lean() as any;
  if (
    recent &&
    dayjs(recent.createdAt).add(POLICY_CONSTANTS.REPORT_COOLDOWN_SECONDS, 'second').isAfter(dayjs())
  ) {
    return ctx.throw(429, 'Please wait a moment before reporting again');
  }

  // ---- Resolve the author of the reported content ----
  const targetAuthorId = await resolveTargetAuthor(target_type, target_id);
  if (!targetAuthorId) return ctx.throw(404, 'Content not found');

  if (targetAuthorId.toString() === reporter_id) {
    return ctx.throw(400, 'You can\'t report your own content');
  }

  // ---- Snapshot for ephemeral surfaces ----
  const snapshot = await snapshotContent(target_type, target_id);

  // ---- Insert (silently no-op on duplicate, thanks to the unique index) ----
  let report;
  try {
    report = await report_model.create({
      reporter_id,
      target_id,
      target_type,
      target_author_id: targetAuthorId,
      reason,
      details,
      content_snapshot: snapshot
    });
  } catch (e: any) {
    if (e.code === 11000) {
      // Already reported — pretend success
      ctx.body = { success: true, alreadyReported: true };
      return;
    }
    throw e;
  }

  // ---- Auto-moderation evaluation ----
  await evaluateAutoModeration({
    type: target_type,
    targetId: target_id,
    targetAuthorId: targetAuthorId.toString(),
    reason,
    reporterId: reporter_id
  });

  // Also evaluate cross-conversation DM pattern (one of the spec's tricky cases)
  if (target_type === 'dm_message') {
    await evaluateCrossConversationDmPattern(targetAuthorId.toString());
  }

  ctx.body = {
    success: true,
    message: 'Thanks — our team will review this. You can also block this user if you\'d like.'
  };
});

// =============================================================================
// GET /report/queue — mod dashboard
// =============================================================================
moderationRouter.get('/queue', async (ctx) => {
  if (!ctx.state.user.is_admin) return ctx.throw(403);

  const status = (ctx.query.status as string) || 'pending';
  const reports = await report_model
    .find({ status: { $in: status.split(',') } })
    .sort({ createdAt: 1 })  // FIFO
    .limit(50)
    .populate('reporter_id', 'name img')
    .populate('target_author_id', 'name img restriction strike_summary')
    .lean();

  ctx.body = { reports };
});

// =============================================================================
// POST /report/:id/resolve — mod uphold/dismiss
// =============================================================================
moderationRouter.post('/:report_id/resolve', async (ctx) => {
  if (!ctx.state.user.is_admin) return ctx.throw(403);

  const { action } = ctx.request.body as { action: 'uphold' | 'dismiss' };
  const report = await report_model.findById(ctx.params.report_id);
  if (!report) return ctx.throw(404);
  if (report.status === 'upheld' || report.status === 'dismissed') {
    return ctx.throw(400, 'Already resolved');
  }

  report.status = action === 'uphold' ? 'upheld' : 'dismissed';
  report.resolved_at = new Date();
  report.resolved_by = ctx.state.user._id;
  await report.save();

  if (action === 'uphold') {
    // Author gets a strike — the service handles cascading restriction, audit, socket
    await applyStrike({
      userId: report.target_author_id.toString(),
      reason: report.reason as ReportReason,
      sourceReportId: report._id.toString(),
      adminId: ctx.state.user._id.toString()
    });
    // Hard-remove content (was quarantined → now removed)
    await removeContent(report.target_type, report.target_id.toString());
  } else {
    // Restore if we had auto-quarantined
    await restoreContent(report.target_type, report.target_id.toString());
  }

  ctx.body = { success: true };
});

// =============================================================================
// HELPERS
// =============================================================================

async function resolveTargetAuthor(
  type: string,
  id: string
): Promise<Types.ObjectId | null> {
  const oid = new Types.ObjectId(id);
  switch (type) {
    case 'post':
      return (await post_model.findById(oid).select('author_id').lean() as any)?.author_id ?? null;
    case 'comment':
      return (await post_comment_model.findById(oid).select('author_id').lean() as any)?.author_id ?? null;
    case 'balloon':
      return (await balloon_model.findById(oid).select('sender').lean() as any)?.sender ?? null;
    case 'dm_message':
      return (await message_model.findById(oid).select('sender_id').lean() as any)?.sender_id ?? null;
    case 'user':
      return oid;
    // ... inbox_drawing, inbox_comment, lobby_*: each does a similar lookup
    default:
      return null;
  }
}

/**
 * For ephemeral content (balloons, DMs, lobby chat), the original may be
 * deleted before review. Capture enough that the moderator can decide.
 * DMs include a context window of surrounding messages.
 */
async function snapshotContent(type: string, id: string): Promise<any> {
  const oid = new Types.ObjectId(id);

  switch (type) {
    case 'balloon': {
      const b = await balloon_model.findById(oid).select('message img thumbnail').lean() as any;
      return b ? { message: b.message, img: b.img, thumbnail: b.thumbnail } : null;
    }
    case 'dm_message': {
      const msg = await message_model.findById(oid).lean() as any;
      if (!msg) return null;
      // Context window: 5 messages before and after, so the mod sees the conversation
      const context = await message_model
        .find({
          conversation_id: msg.conversation_id,
          createdAt: {
            $gte: dayjs(msg.createdAt).subtract(10, 'minute').toDate(),
            $lte: dayjs(msg.createdAt).add(10, 'minute').toDate()
          }
        })
        .sort({ createdAt: 1 })
        .limit(11)
        .select('sender_id content createdAt')
        .lean();
      return { reported_message: msg.content, context };
    }
    default:
      return null;
  }
}

/**
 * Reporter trust: have this user's past reports been upheld? Caps prevent any
 * single user from singlehandedly nuking content, and floors prevent serial
 * spammers from being completely silenced (they still count, just weakly).
 */
async function getReporterTrust(reporterId: string): Promise<number> {
  const stats = await report_model.aggregate([
    {
      $match: {
        reporter_id: new Types.ObjectId(reporterId),
        status: { $in: ['upheld', 'dismissed'] }
      }
    },
    {
      $group: {
        _id: null,
        upheld: { $sum: { $cond: [{ $eq: ['$status', 'upheld'] }, 1, 0] } },
        dismissed: { $sum: { $cond: [{ $eq: ['$status', 'dismissed'] }, 1, 0] } }
      }
    }
  ]);
  if (!stats.length) return POLICY_CONSTANTS.REPORTER_TRUST_DEFAULT;
  const { upheld, dismissed } = stats[0];
  // Laplace-smoothed: bias toward 1.0 with little data
  const score = (upheld + 1) / (upheld + dismissed + 2);
  return Math.max(
    POLICY_CONSTANTS.REPORTER_TRUST_MIN,
    Math.min(POLICY_CONSTANTS.REPORTER_TRUST_MAX, score * 1.5 + 0.5)
  );
}

/**
 * Sums weighted report scores against this target. If past threshold, quarantine.
 * Threshold is halved for content from new accounts (grace = stricter, not looser).
 */
async function evaluateAutoModeration(params: {
  type: string;
  targetId: string;
  targetAuthorId: string;
  reason: string;
  reporterId: string;
}) {
  const surfaceCfg = REPORTABLE[params.type as ReportableType];
  if (!surfaceCfg) return;

  // Auto-hide surfaces (balloons) quarantine on first report
  if (surfaceCfg.auto_hide) {
    await quarantineContent(params.type, params.targetId);
    return;
  }

  // Weighted threshold evaluation
  const [reports, author, reporterTrust] = await Promise.all([
    report_model
      .find({
        target_id: new Types.ObjectId(params.targetId),
        target_type: params.type,
        status: { $in: ['pending', 'auto_actioned'] }
      })
      .select('reporter_id reason')
      .lean() as Promise<any[]>,
    user_model.findById(params.targetAuthorId).select('createdAt').lean() as any,
    getReporterTrust(params.reporterId)
  ]);

  // Sum weights — different reasons carry different severity
  let totalWeight = 0;
  for (const r of reports) {
    const reasonWeight = REPORT_REASONS[r.reason as ReportReason]?.weight ?? 1;
    // Lookup that reporter's trust would be a per-report query; for v1 we
    // approximate using just the current reporter's trust as the marginal.
    totalWeight += reasonWeight;
  }
  totalWeight *= reporterTrust;

  // New-account multiplier — stricter for users in their first week
  const isNewAccount =
    author?.createdAt &&
    dayjs().diff(dayjs(author.createdAt), 'day') < POLICY_CONSTANTS.NEW_ACCOUNT_GRACE_DAYS;
  const threshold = isNewAccount
    ? surfaceCfg.quarantine_threshold * POLICY_CONSTANTS.NEW_ACCOUNT_THRESHOLD_MULTIPLIER
    : surfaceCfg.quarantine_threshold;

  // Critical reasons bypass thresholds entirely
  const isCritical = REPORT_REASONS[params.reason as ReportReason]?.severity === 'critical';

  if (isCritical || totalWeight >= threshold) {
    await quarantineContent(params.type, params.targetId);
  }
}

/**
 * Cross-conversation DM pattern: 3+ different people reported this user's DMs
 * in the last 30 days. Each individual report didn't trip a threshold (because
 * DMs have a huge threshold), but the pattern is meaningful — apply a strike.
 */
async function evaluateCrossConversationDmPattern(authorId: string) {
  const cutoff = dayjs().subtract(30, 'day').toDate();
  const reports = await report_model
    .find({
      target_author_id: new Types.ObjectId(authorId),
      target_type: 'dm_message',
      createdAt: { $gte: cutoff }
    })
    .select('reporter_id')
    .lean();

  const uniqueReporters = new Set(reports.map((r: any) => r.reporter_id.toString()));
  if (uniqueReporters.size >= POLICY_CONSTANTS.CROSS_CONVERSATION_DM_THRESHOLD) {
    // Don't auto-strike — auto-action the reports so they hit the mod queue
    // with elevated priority. You still make the final call.
    await report_model.updateMany(
      {
        target_author_id: new Types.ObjectId(authorId),
        target_type: 'dm_message',
        status: 'pending',
        createdAt: { $gte: cutoff }
      },
      { $set: { status: 'auto_actioned' } }
    );
  }
}

async function quarantineContent(type: string, id: string) {
  const oid = new Types.ObjectId(id);
  switch (type) {
    case 'post':
      await post_model.updateOne(
        { _id: oid, status: 'active' },
        { $set: { status: 'under_review' } }
      );
      break;
    case 'balloon':
      await balloon_model.updateOne(
        { _id: oid },
        { $set: { status: 'under_review' } }
      );
      break;
    // ... inbox_drawing, comment, lobby_message: each hides from feeds while preserving data
  }
  await report_model.updateMany(
    { target_id: oid, target_type: type, status: 'pending' },
    { $set: { status: 'auto_actioned' } }
  );
}

async function restoreContent(type: string, id: string) {
  const oid = new Types.ObjectId(id);
  if (type === 'post') {
    await post_model.updateOne(
      { _id: oid, status: 'under_review' },
      { $set: { status: 'active' } }
    );
  }
  // ... mirror for each content type
}

async function removeContent(type: string, id: string) {
  const oid = new Types.ObjectId(id);
  if (type === 'post') {
    await post_model.updateOne(
      { _id: oid },
      { $set: { status: 'removed' } }
    );
  }
  // ... mirror for each content type
}

// =============================================================================
// GET /report/standing — user-facing "Your Standing" page
// =============================================================================
moderationRouter.get('/standing', async (ctx) => {
  ctx.body = await getStanding(ctx.state.user._id.toString());
});