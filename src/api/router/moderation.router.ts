import Router from 'koa-router';
import dayjs from 'dayjs';
import { Types } from 'mongoose';
import { requireAuth } from '../../middleware/auth';
import { post_comment_model, post_model } from '../../models/post.model';
import { balloon_model } from '../../models/balloon.model';
import { message_model } from '../../models/message.model';
import { user_model } from '../../models/user.model';
import { inbox_model } from '../../models/inbox.model';
import { CONTAINER } from '../../s3';

import { applyStrike, getStanding } from '../services/moderation.service';
import {
  POLICY_CONSTANTS,
  REPORT_REASONS,
  REPORTABLE,
  ReportableType,
  ReportReason
} from '../../types/moderation.policy';
import { report_model } from '../../models/moderation.model';
import { s3Creator } from '../../mongodb';

export const moderationRouter = new Router();
moderationRouter.use(requireAuth);

// =============================================================================
// POST /report — user submits a report
// =============================================================================
moderationRouter.post('/', async (ctx) => {
  const { target_id, target_type, reason, details } = ctx.request.body as any;
  const reporter_id = ctx.state.user._id.toString();

  if (!REPORTABLE[target_type as ReportableType]) {
    return ctx.throw(400, 'Invalid target_type');
  }
  if (!REPORT_REASONS[reason as ReportReason]) {
    return ctx.throw(400, 'Invalid reason');
  }

  // Anti-spam: per-reporter cooldown
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

  const targetAuthorId = await resolveTargetAuthor(target_type, target_id);
  if (!targetAuthorId) return ctx.throw(404, 'Content not found');

  if (targetAuthorId.toString() === reporter_id) {
    return ctx.throw(400, 'You can\'t report your own content');
  }

  // Snapshot — for ephemeral OR deletable content. Images cloned to a
  // dedicated bucket so they survive the original being removed.
  const snapshot = await snapshotContent(target_type, target_id);

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
      ctx.body = { success: true, alreadyReported: true };
      return;
    }
    throw e;
  }

  await evaluateAutoModeration({
    type: target_type,
    targetId: target_id,
    targetAuthorId: targetAuthorId.toString(),
    reason,
    reporterId: reporter_id
  });

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
    .sort({ createdAt: 1 })
    .limit(50)
    .populate('reporter_id', 'name img')
    .populate('target_author_id', 'name img restriction strike_summary')
    .lean();

  // Sign any snapshot URLs so the mod dashboard can render them.
  // The bucket is private, so we hand out short-lived signed URLs only at
  // the moment the queue is being viewed.
  const signedReports = await Promise.all(reports.map(async (r: any) => {
    if (r.content_snapshot?.snapshot_url) {
      const signed = await s3Creator.getSnapshotSignedUrl(r.content_snapshot.snapshot_url);
      if (signed) r.content_snapshot.snapshot_signed_url = signed;
    }
    return r;
  }));

  ctx.body = { reports: signedReports };
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
    await applyStrike({
      userId: report.target_author_id.toString(),
      reason: report.reason as ReportReason,
      sourceReportId: report._id.toString(),
      adminId: ctx.state.user._id.toString()
    });
    await removeContent(report.target_type, report.target_id.toString());
  } else {
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
    case 'inbox_drawing':
      return (await inbox_model.findById(oid).select('sender').lean() as any)?.sender ?? null;
    case 'inbox_comment': {
      // Inbox comments are nested. The :id passed in is the comment _id;
      // we need to find the parent inbox doc and pull out the right comment.
      const inboxDoc = await inbox_model
        .findOne({ 'comments._id': oid })
        .select('comments')
        .lean() as any;
      if (!inboxDoc) return null;
      const comment = inboxDoc.comments?.find((c: any) => c._id.toString() === id);
      // Inbox comments store sender as a String (not ObjectId) per the schema.
      return comment?.sender ? new Types.ObjectId(comment.sender) : null;
    }
    case 'user':
      return oid;
    default:
      return null;
  }
}

/**
 * Snapshot the reported content so the moderator can review it even after
 * the original is gone. For visual content we clone the thumbnail (cheap)
 * to a private S3 bucket; for text we just store inline JSON.
 *
 * Returns a JSON object stored on the report document. May contain:
 *   - snapshot_url: cloned S3 path (visual content only)
 *   - original_url: the original thumbnail URL (for reference)
 *   - text fields: description, message, content, etc.
 *   - context: surrounding messages for DMs
 *
 * Fire-and-forget on clone failure — we never want a snapshot failure to
 * cause the report submission to fail. Partial evidence is fine.
 */
async function snapshotContent(type: string, id: string): Promise<any> {
  const oid = new Types.ObjectId(id);

  switch (type) {
    case 'post': {
      const post = await post_model
        .findById(oid)
        .select('description thumbnail_url')
        .lean() as any;
      if (!post) return null;

      const snapshot_url = post.thumbnail_url
        ? await s3Creator.cloneToSnapshot(post.thumbnail_url, CONTAINER.drawings)
        : null;

      return {
        description: post.description,
        original_url: post.thumbnail_url,
        snapshot_url
      };
    }

    case 'comment': {
      const comment = await post_comment_model
        .findById(oid)
        .select('message')
        .lean() as any;
      return comment ? { message: comment.message } : null;
    }

    case 'balloon': {
      const b = await balloon_model
        .findById(oid)
        .select('message thumbnail')
        .lean() as any;
      if (!b) return null;

      const snapshot_url = b.thumbnail
        ? await s3Creator.cloneToSnapshot(b.thumbnail, CONTAINER.drawings)
        : null;

      return {
        message: b.message,
        original_url: b.thumbnail,
        snapshot_url
      };
    }

    case 'inbox_drawing': {
      const item = await inbox_model
        .findById(oid)
        .select('thumbnail sender')
        .lean() as any;
      if (!item) return null;

      const snapshot_url = item.thumbnail
        ? await s3Creator.cloneToSnapshot(item.thumbnail, CONTAINER.drawings)
        : null;

      return {
        original_url: item.thumbnail,
        snapshot_url
      };
    }

    case 'inbox_comment': {
      // Inbox comments are nested in the inbox document. Find the parent
      // and extract just the reported comment text.
      const inboxDoc = await inbox_model
        .findOne({ 'comments._id': oid })
        .select('comments')
        .lean() as any;
      if (!inboxDoc) return null;
      const comment = inboxDoc.comments?.find((c: any) => c._id.toString() === id);
      return comment ? { message: comment.message } : null;
    }

    case 'dm_message': {
      const msg = await message_model.findById(oid).lean() as any;
      if (!msg) return null;
      // Context window: messages within a 10-minute window around the report
      // give the moderator enough conversational flow to judge.
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
  const score = (upheld + 1) / (upheld + dismissed + 2);
  return Math.max(
    POLICY_CONSTANTS.REPORTER_TRUST_MIN,
    Math.min(POLICY_CONSTANTS.REPORTER_TRUST_MAX, score * 1.5 + 0.5)
  );
}

async function evaluateAutoModeration(params: {
  type: string;
  targetId: string;
  targetAuthorId: string;
  reason: string;
  reporterId: string;
}) {
  const surfaceCfg = REPORTABLE[params.type as ReportableType];
  if (!surfaceCfg) return;

  if (surfaceCfg.auto_hide) {
    await quarantineContent(params.type, params.targetId);
    return;
  }

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

  let totalWeight = 0;
  for (const r of reports) {
    const reasonWeight = REPORT_REASONS[r.reason as ReportReason]?.weight ?? 1;
    totalWeight += reasonWeight;
  }
  totalWeight *= reporterTrust;

  const isNewAccount =
    author?.createdAt &&
    dayjs().diff(dayjs(author.createdAt), 'day') < POLICY_CONSTANTS.NEW_ACCOUNT_GRACE_DAYS;
  const threshold = isNewAccount
    ? surfaceCfg.quarantine_threshold * POLICY_CONSTANTS.NEW_ACCOUNT_THRESHOLD_MULTIPLIER
    : surfaceCfg.quarantine_threshold;

  const isCritical = REPORT_REASONS[params.reason as ReportReason]?.severity === 'critical';

  if (isCritical || totalWeight >= threshold) {
    await quarantineContent(params.type, params.targetId);
  }
}

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
  const now = new Date();

  switch (type) {
    case 'post':
      await post_model.updateOne(
        { _id: oid, status: 'active' },
        { $set: { status: 'under_review', 'moderation.quarantined_at': now } }
      );
      break;
    case 'balloon':
      await balloon_model.updateOne(
        { _id: oid, moderation_status: 'active' },
        { $set: { moderation_status: 'under_review', 'moderation.quarantined_at': now } }
      );
      break;
    case 'inbox_drawing':
      await inbox_model.updateOne(
        { _id: oid, status: 'active' },
        { $set: { status: 'under_review', 'moderation.quarantined_at': now } }
      );
      break;
    case 'comment':
      await post_comment_model.updateOne(
        { _id: oid, status: 'active' },
        { $set: { status: 'under_review' } }
      );
      break;
    case 'inbox_comment':
      await inbox_model.updateOne(
        { 'comments._id': oid, 'comments.status': 'active' },
        { $set: { 'comments.$.status': 'removed' } }
      );
      break;
    case 'dm_message':
      await message_model.updateOne(
        { _id: oid, moderation_status: 'active' },
        { $set: { moderation_status: 'removed' } }
      );
      break;
  }

  await report_model.updateMany(
    { target_id: oid, target_type: type, status: 'pending' },
    { $set: { status: 'auto_actioned' } }
  );
}

async function restoreContent(type: string, id: string) {
  const oid = new Types.ObjectId(id);
  switch (type) {
    case 'post':
      await post_model.updateOne(
        { _id: oid, status: 'under_review' },
        { $set: { status: 'active' } }
      );
      break;
    case 'balloon':
      await balloon_model.updateOne(
        { _id: oid, moderation_status: 'under_review' },
        { $set: { moderation_status: 'active' } }
      );
      break;
    case 'inbox_drawing':
      await inbox_model.updateOne(
        { _id: oid, status: 'under_review' },
        { $set: { status: 'active' } }
      );
      break;
    case 'comment':
      await post_comment_model.updateOne(
        { _id: oid, status: 'under_review' },
        { $set: { status: 'active' } }
      );
      break;
    case 'inbox_comment':
      await inbox_model.updateOne(
        { 'comments._id': oid, 'comments.status': 'removed' },
        { $set: { 'comments.$.status': 'active' } }
      );
      break;
    case 'dm_message':
      await message_model.updateOne(
        { _id: oid, moderation_status: 'removed' },
        { $set: { moderation_status: 'active' } }
      );
      break;
  }
}

async function removeContent(type: string, id: string) {
  const oid = new Types.ObjectId(id);
  const now = new Date();

  switch (type) {
    case 'post':
      await post_model.updateOne(
        { _id: oid },
        { $set: { status: 'removed', 'moderation.removed_at': now } }
      );
      break;
    case 'balloon':
      await balloon_model.updateOne(
        { _id: oid },
        { $set: { moderation_status: 'removed', 'moderation.removed_at': now } }
      );
      break;
    case 'inbox_drawing':
      await inbox_model.updateOne(
        { _id: oid },
        { $set: { status: 'removed', 'moderation.removed_at': now } }
      );
      break;
    case 'comment':
      await post_comment_model.updateOne(
        { _id: oid },
        { $set: { status: 'removed' } }
      );
      break;
    case 'inbox_comment':
      await inbox_model.updateOne(
        { 'comments._id': oid },
        { $set: { 'comments.$.status': 'removed' } }
      );
      break;
    case 'dm_message':
      await message_model.updateOne(
        { _id: oid },
        { $set: { moderation_status: 'removed' } }
      );
      break;
  }
}

// =============================================================================
// GET /report/standing — user-facing "Your Standing" page
// =============================================================================
moderationRouter.get('/standing', async (ctx) => {
  ctx.body = await getStanding(ctx.state.user._id.toString());
});