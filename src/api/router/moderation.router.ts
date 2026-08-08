import Router from 'koa-router';
import dayjs from 'dayjs';
import { Types } from 'mongoose';
import { requireAuth } from '../../middleware/auth';
import { post_comment_model, post_model } from '../../models/post.model';
import { balloon_model } from '../../models/balloon.model';
import { message_model } from '../../models/message.model';
import { user_model } from '../../models/user.model';
import { inbox_model } from '../../models/inbox.model';
import {
  competition_comment_model,
  competition_entry_model
} from '../../models/competition.model';
import { CONTAINER } from '../../s3';

const MAX_REPORT_RATIO = 0.01;

// Strike/remove/restore used to be duplicated at the bottom of this file and in
// the dev router. The copies had drifted: neither touched the deletion queue, so
// content removed through THIS endpoint was never scheduled for deletion, and
// content restored through it stayed queued for deletion anyway. Now every
// decision path — here, and in /dev/moderation — goes through the services.
import {
  evaluateUserStanding,
  getStanding,
  notifyContentModeration
} from '../services/moderation.service';
import {
  getModerationQueue,
  parseQueueQuery,
  ResolveAction,
  resolveAuthorReports,
  resolveReport,
  restoreReport
} from '../services/moderationQueue.service';
import {
  POLICY_CONSTANTS,
  REPORT_REASONS,
  REPORTABLE,
  ReportableType,
  ReportReason
} from '../../types/moderation.policy';
import { report_model } from '../../models/moderation.model';
import { s3Creator } from '../../mongodb';
import { findInboxComment, setInboxCommentStatus } from '../services/inbox.service';

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
    ctx.status = 200;
    ctx.body = { success: true, message: 'Report submitted successfully' };
    return;
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
// MOD DASHBOARD
// =============================================================================
// Paginated, grouped by reported user, and identical to what /dev/moderation
// serves — same service, so the two dashboards cannot drift apart.

moderationRouter.get('/queue', async (ctx) => {
  if (!ctx.state.user.is_admin) return ctx.throw(403);
  ctx.body = await getModerationQueue(parseQueueQuery(ctx.query));
});

// POST /report/:id/resolve — closes every open report on the same content too.
moderationRouter.post('/:report_id/resolve', async (ctx) => {
  if (!ctx.state.user.is_admin) return ctx.throw(403);

  const { action } = ctx.request.body as { action: ResolveAction };
  if (!['uphold', 'remove_only', 'dismiss'].includes(action)) {
    return ctx.throw(400, 'Invalid action');
  }

  const result = await resolveReport({
    reportId: ctx.params.report_id,
    action,
    adminId: ctx.state.user._id.toString()
  });

  if (!result.ok) {
    return result.error === 'not_found' ? ctx.throw(404) : ctx.throw(400, 'Already resolved');
  }

  ctx.body = { success: true, ...result };
});

// POST /report/user/:user_id/resolve — one decision for an author's whole queue.
moderationRouter.post('/user/:user_id/resolve', async (ctx) => {
  if (!ctx.state.user.is_admin) return ctx.throw(403);

  const { action } = ctx.request.body as { action: ResolveAction };
  if (!['uphold', 'remove_only', 'dismiss'].includes(action)) {
    return ctx.throw(400, 'Invalid action');
  }

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

// POST /report/:id/restore — undo a resolution; the strike stays.
moderationRouter.post('/:report_id/restore', async (ctx) => {
  if (!ctx.state.user.is_admin) return ctx.throw(403);

  const result = await restoreReport({
    reportId: ctx.params.report_id,
    adminId: ctx.state.user._id.toString()
  });
  if (!result.ok) return ctx.throw(404);

  ctx.body = { success: true, restored: result.restored };
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
      const c = await findInboxComment(oid);
      return c?.sender ?? null;
    }
    case 'competition_entry':
      return (await competition_entry_model.findById(oid).select('user_id').lean() as any)?.user_id ?? null;
    case 'competition_comment':
      return (await competition_comment_model.findById(oid).select('author_id').lean() as any)?.author_id ?? null;
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

    case 'competition_entry': {
      const entry = await competition_entry_model
        .findById(oid)
        .select('caption thumbnail_url')
        .lean() as any;
      if (!entry) return null;

      const snapshot_url = entry.thumbnail_url
        ? await s3Creator.cloneToSnapshot(entry.thumbnail_url, CONTAINER.drawings)
        : null;

      return {
        description: entry.caption,
        original_url: entry.thumbnail_url,
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

    case 'competition_comment': {
      const comment = await competition_comment_model
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
      const c = await findInboxComment(oid);
      return c ? { message: c.message } : null;
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

  const [reports, author, reporterTrust] = await Promise.all([
    report_model
      .find({
        target_id: new Types.ObjectId(params.targetId),
        target_type: params.type,
        status: { $in: ['pending', 'auto_actioned'] }
      })
      .select('reporter_id reason status')
      .lean() as Promise<any[]>,
    user_model.findById(params.targetAuthorId).select('createdAt').lean() as any,
    getReporterTrust(params.reporterId)
  ]);

  // FIX 2: Prevent double jeopardy. If one of these reports is already
  // 'auto_actioned', we already quarantined this content. Stop here.
  if (reports.some(r => r.status === 'auto_actioned')) {
    return;
  }

  if (surfaceCfg.auto_hide) {
    await quarantineContent(params.type, params.targetId);
    await notifyContentModeration({
      authorId: params.targetAuthorId,
      type: params.type,
      targetId: params.targetId,
      event: 'under_review'
    });
    await evaluateUserStanding(params.targetAuthorId, params.reporterId);
    return;
  }

  let totalWeight = 0;
  for (const r of reports) {
    const reasonWeight = REPORT_REASONS[r.reason as ReportReason]?.weight ?? 1;
    totalWeight += reasonWeight;
  }
  totalWeight *= reporterTrust;

  const isNewAccount =
    author?.createdAt &&
    dayjs().diff(dayjs(author.createdAt), 'day') < POLICY_CONSTANTS.NEW_ACCOUNT_GRACE_DAYS;
  const absoluteThreshold = isNewAccount
    ? surfaceCfg.quarantine_threshold * POLICY_CONSTANTS.NEW_ACCOUNT_THRESHOLD_MULTIPLIER
    : surfaceCfg.quarantine_threshold;

  let relativeThreshold = 0;
  if (params.type === 'post') {
    const post = await post_model.findById(params.targetId).select('views').lean() as any;
    if (post?.views) relativeThreshold = post.views * MAX_REPORT_RATIO;
  } else if (params.type === 'comment') {
    const comment = await post_comment_model.findById(params.targetId).select('post_id').lean() as any;
    if (comment?.post_id) {
      const parentPost = await post_model.findById(comment.post_id).select('views').lean() as any;
      if (parentPost?.views) relativeThreshold = parentPost.views * MAX_REPORT_RATIO;
    }
  }

  const finalThreshold = Math.max(absoluteThreshold, relativeThreshold);

  if (totalWeight >= finalThreshold) {
    await quarantineContent(params.type, params.targetId);
    await notifyContentModeration({
      authorId: params.targetAuthorId,
      type: params.type,
      targetId: params.targetId,
      event: 'under_review'
    });
    await evaluateUserStanding(params.targetAuthorId, params.reporterId);
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
    case 'competition_entry':
      // Votes are deliberately preserved: if the report is dismissed the entry
      // re-enters the running with its standing intact.
      await competition_entry_model.updateOne(
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
    case 'competition_comment':
      await competition_comment_model.updateOne(
        { _id: oid, status: 'active' },
        { $set: { status: 'under_review' } }
      );
      break;
    case 'inbox_comment':
      await setInboxCommentStatus(oid, 'active', 'removed');
      break;
    case 'dm_message':
      // `$ne: 'removed'` rather than `=== 'active'`: messages written before
      // the field existed on the schema have no `moderation_status` at all, and
      // an equality match would skip every one of them.
      await message_model.updateOne(
        { _id: oid, moderation_status: { $ne: 'removed' } },
        { $set: { moderation_status: 'removed' } }
      );
      break;
  }

  await report_model.updateMany(
    { target_id: oid, target_type: type, status: 'pending' },
    { $set: { status: 'auto_actioned' } }
  );
}

moderationRouter.get('/standing', async (ctx) => {
  ctx.body = await getStanding(ctx.state.user._id.toString());
});
