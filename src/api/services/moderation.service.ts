import dayjs from 'dayjs';
import { moderationThresholds } from '../../config/moderation.thresholds';
import { Types } from 'mongoose';
import {
  getLevelConfig,
  POLICY_CONSTANTS,
  REPORTABLE,
  ReportableType,
  ReportReason,
  STRIKE_LADDER
} from '../../types/moderation.policy';
import { moderation_action_model, report_model } from '../../models/moderation.model';
import { user_model } from '../../models/user.model';
import { sendSocketNotificationToUser } from '../socket/socket';

import { post_model, post_comment_model } from '../../models/post.model';
import { balloon_model } from '../../models/balloon.model';
import { inbox_model } from '../../models/inbox.model';
import {
  competition_comment_model,
  competition_entry_model
} from '../../models/competition.model';
import { message_model } from '../../models/message.model';
import { deletion_queue_model } from '../../models/deletion.model';
import { setInboxCommentStatus } from './inbox.service';
import { dispatchNotification } from './notification.service';
import { banDevicesForUser, BANNED_LEVEL } from './deviceRecall.service';
import {
  moderationContentPushNotification,
  moderationLiftedPushNotification,
  moderationStrikePushNotification
} from '../../config/notification.config';

export type ContentModerationEvent = 'under_review' | 'removed' | 'restored';

/**
 * Tell an author what happened to their content.
 *
 * Without this, moderation was silent from the author's side: a quarantined or
 * removed post simply stopped appearing, with no way to tell it apart from a bug
 * or from having deleted it themselves. Silence also makes the review look
 * permanent, which is exactly wrong for `under_review` — that state is temporary
 * by definition and most of it gets restored.
 *
 * Deliberately says nothing about WHO reported it or how many did: that's the
 * information a retaliating author would act on.
 *
 * Never throws — moderation must not fail because a notification did.
 */
export async function notifyContentModeration(params: {
  authorId: string;
  type: string;
  targetId: string;
  event: ContentModerationEvent;
}) {
  const { authorId, type, targetId, event } = params;
  const label = (REPORTABLE[type as ReportableType]?.label ?? 'post').toLowerCase();

  const copy = {
    under_review: {
      title: `Your ${label} is being reviewed`,
      body: `It's hidden while our team takes a look. If everything's fine, it comes straight back.`
    },
    removed: {
      title: `Your ${label} was removed`,
      body: `Our team reviewed it and found it went against the community guidelines.`
    },
    restored: {
      title: `Your ${label} is back`,
      body: `We reviewed it and put it back where it was. Thanks for your patience.`
    }
  }[event];

  const payload = { status: event, content_type: type, target_id: targetId, ...copy };

  try {
    await dispatchNotification({
      recipient_id: authorId,
      type: 'moderation_content',
      target_type: 'system',
      channels: {
        in_app: true,
        socket: { event: 'moderation:content', data: payload },
        push: moderationContentPushNotification(copy.title, copy.body)
      },
      payload
    });
  } catch (err) {
    console.error('Content moderation notice failed:', err);
  }
}

export async function applyStrike(params: {
  userId: string;
  reason: ReportReason;
  sourceReportId?: string;
  adminId?: string;
}) {
  const { userId, reason, sourceReportId, adminId } = params;

  await moderation_action_model.create({
    user_id: new Types.ObjectId(userId),
    action_type: 'strike_applied',
    reason,
    source_report_id: sourceReportId ? new Types.ObjectId(sourceReportId) : undefined,
    admin_id: adminId ? new Types.ObjectId(adminId) : undefined
  });

  const summary = await recomputeStrikeSummary(userId);
  const newLevel = Math.min(summary.active_strikes, STRIKE_LADDER.length - 1);
  const config = getLevelConfig(newLevel);
  const expiresAt = config.duration_days
    ? dayjs().add(config.duration_days, 'day').toDate()
    : null;

  // A manual ban (or a device recall match) is not derived from the strike
  // count, so recomputing the level from strikes would UNDO it. Someone banned
  // by hand who then has one unrelated report upheld would drop from level 3 to
  // level 1 and be back in the app. Keep the stronger restriction; the strike
  // itself is still recorded in the audit log and in strike_summary.
  const existing = await user_model
    .findById(userId)
    .select('restriction')
    .lean() as any;
  const keepManual =
    existing?.restriction?.manual === true &&
    (existing.restriction.level ?? 0) > newLevel;

  const restriction = {
    level: newLevel,
    reason,
    applied_at: new Date(),
    expires_at: expiresAt,
    manual: false
  };

  await user_model.updateOne(
    { _id: userId },
    keepManual
      ? { $set: { strike_summary: summary } }
      : { $set: { restriction, strike_summary: summary } }
  );

  // Reaching the banned rung is the moment the account stops being the unit of
  // enforcement. Remember the hardware, so the next anonymous sign-up from this
  // phone is recognised instead of starting clean. Non-fatal: failing to record
  // a device must never roll back a ban that was correctly applied.
  if (newLevel >= BANNED_LEVEL) {
    banDevicesForUser(userId, `ban_level_${newLevel}`).catch((err) =>
      console.error('banDevicesForUser failed:', err)
    );
  }

  if (newLevel > 0) {
    await moderation_action_model.create({
      user_id: new Types.ObjectId(userId),
      action_type: 'restriction_applied',
      level: newLevel,
      reason,
      expires_at: expiresAt,
      blocked_capabilities: [...config.blocks],
      source_report_id: sourceReportId ? new Types.ObjectId(sourceReportId) : undefined
    });
  }

  // ─── REPLACES: sendSocketNotificationToUser('moderation:strike', ...) ───
  const strikePayload = {
    level: newLevel,
    name: config.name,
    description: config.description,
    reason,
    expires_at: expiresAt,
    blocked_capabilities: [...config.blocks]
  };

  dispatchNotification({
    recipient_id: userId,
    type: 'moderation_strike',
    target_type: 'system',
    channels: {
      in_app: true,
      socket: { event: 'moderation:strike', data: strikePayload },
      push: moderationStrikePushNotification(config.name, config.description)
    },
    payload: strikePayload  // Same data, persisted on the feed entry for retrospective viewing
  }).catch(err => console.error('Strike dispatch failed:', err));

  return { level: newLevel, restriction };
}

/**
 * MANUAL BAN — a human decided, directly, without a report to point at.
 *
 * Not applyStrike(): that derives the level from the count of upheld reports,
 * so it can only ever move someone one rung at a time and it cannot express
 * "I have read this account and it is done". This writes the top rung directly.
 *
 * Deliberately NOT the /set-level dev endpoint either. That one deletes the
 * user's entire moderation_actions history before fabricating synthetic strikes
 * to reach the requested level — fine for testing a UI, destructive in
 * production, where that collection is the source of truth for appeals.
 *
 * `manual: true` on the restriction is what stops a later applyStrike() from
 * recomputing the level and quietly undoing this.
 */
export async function applyManualBan(params: {
  userId: string;
  adminId: string;
  reason: string;
  notes: string;
}) {
  const { userId, adminId, reason, notes } = params;
  const level = STRIKE_LADDER.length - 1;
  const config = getLevelConfig(level);

  const restriction = {
    level,
    reason,
    applied_at: new Date(),
    expires_at: null,
    manual: true
  };

  await user_model.updateOne({ _id: userId }, { $set: { restriction } });

  await moderation_action_model.create({
    user_id: new Types.ObjectId(userId),
    action_type: 'manual_suspension',
    level,
    reason,
    admin_id: new Types.ObjectId(adminId),
    blocked_capabilities: [...config.blocks],
    notes
  });

  // A hand-placed ban is exactly the case device recall exists for — this is
  // someone a human looked at and decided about, so remember the hardware.
  banDevicesForUser(userId, `manual_ban:${reason}`).catch((err) =>
    console.error('banDevicesForUser failed:', err)
  );

  const payload = {
    level,
    name: config.name,
    description: config.description,
    reason,
    expires_at: null,
    blocked_capabilities: [...config.blocks]
  };

  dispatchNotification({
    recipient_id: userId,
    type: 'moderation_strike',
    target_type: 'system',
    channels: {
      in_app: true,
      socket: { event: 'moderation:strike', data: payload },
      push: moderationStrikePushNotification(config.name, config.description)
    },
    payload
  }).catch((err) => console.error('Manual ban dispatch failed:', err));

  return { level, restriction };
}

export async function recomputeStrikeSummary(userId: string) {
  const decayCutoff = dayjs()
    .subtract(POLICY_CONSTANTS.STRIKE_DECAY_DAYS, 'day')
    .toDate();

  const [activeCount, totalCount, lastStrike] = await Promise.all([
    // Active = not decayed AND not forgiven. Forgiveness is an admin
    // shortcutting the decay window, so it belongs in the same clause.
    moderation_action_model.countDocuments({
      user_id: new Types.ObjectId(userId),
      action_type: 'strike_applied',
      createdAt: { $gte: decayCutoff },
      forgiven_at: { $exists: false }
    }),
    moderation_action_model.countDocuments({
      user_id: new Types.ObjectId(userId),
      action_type: 'strike_applied'
    }),
    moderation_action_model
      .findOne({
        user_id: new Types.ObjectId(userId),
        action_type: 'strike_applied'
      })
      .sort({ createdAt: -1 })
      .lean()
  ]);

  return {
    active_strikes: activeCount,
    total_strikes: totalCount,
    last_strike_at: lastStrike?.createdAt ?? null
  };
}

/**
 * Lift an active restriction.
 *
 * Two strengths, because "you can come back" and "we forgot" are different
 * mercies and conflating them was surprising in practice:
 *
 *   clearStrikes: false (default) — lifts the restriction, leaves the strike
 *     record alone. Strikes keep decaying on the normal 90-day schedule, so a
 *     user lifted today can still be one strike from the next rung tomorrow.
 *
 *   clearStrikes: true — also forgives every currently-active strike, giving a
 *     genuine clean slate. Rows are marked `forgiven_at`, never deleted: unlike
 *     the /clear dev endpoint, this does not destroy the audit trail, and
 *     lifetime total_strikes still counts them.
 */
export async function liftRestriction(params: {
  userId: string;
  adminId: string;
  notes?: string;
  reason: 'appeal_granted' | 'manual_override';
  clearStrikes?: boolean;
}) {
  await Promise.all([
    user_model.updateOne(
      { _id: params.userId },
      {
        $set: {
          'restriction.level': 0,
          'restriction.expires_at': null,
          'restriction.reason': 'clear',
          // Clear the manual flag too, or the next applyStrike would compare
          // against a stale "this was hand-placed" marker.
          'restriction.manual': false
        }
      }
    ),
    moderation_action_model.create({
      user_id: new Types.ObjectId(params.userId),
      action_type: params.reason === 'appeal_granted' ? 'appeal_granted' : 'restriction_lifted',
      admin_id: new Types.ObjectId(params.adminId),
      notes: params.notes
    })
  ]);

  if (params.clearStrikes) {
    const decayCutoff = dayjs()
      .subtract(POLICY_CONSTANTS.STRIKE_DECAY_DAYS, 'day')
      .toDate();

    // Only strikes that were still counting. Re-forgiving an already-forgiven
    // or already-decayed row would rewrite history for no behavioural change.
    const result = await moderation_action_model.updateMany(
      {
        user_id: new Types.ObjectId(params.userId),
        action_type: 'strike_applied',
        createdAt: { $gte: decayCutoff },
        forgiven_at: { $exists: false }
      },
      { $set: { forgiven_at: new Date() } }
    );

    await moderation_action_model.create({
      user_id: new Types.ObjectId(params.userId),
      action_type: 'strike_decayed',
      admin_id: new Types.ObjectId(params.adminId),
      notes: `ADMIN: forgave ${result.modifiedCount} active strike(s) alongside the lift.`
    });

    // strike_summary is a projection of the audit log — recompute it or the
    // user keeps a stale active_strikes count and the very next strike jumps
    // them back to the rung we just forgave.
    const summary = await recomputeStrikeSummary(params.userId);
    await user_model.updateOne(
      { _id: params.userId },
      { $set: { strike_summary: summary } }
    );
  }

  dispatchNotification({
    recipient_id: params.userId,
    type: 'moderation_lifted',
    target_type: 'system',
    channels: {
      in_app: true,
      socket: {
        event: 'moderation:restriction_lifted',
        data: { message: 'Your restriction has been lifted. Welcome back!' }
      },
      push: moderationLiftedPushNotification()
    }
  }).catch(err => console.error('Lift dispatch failed:', err));
}

export async function getStanding(userId: string) {
  const [user, recentActions] = await Promise.all([
    user_model
      .findById(userId)
      .select('restriction strike_summary')
      .lean() as any,
    moderation_action_model
      .find({ user_id: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean()
  ]);

  const level = user?.restriction?.level ?? 0;
  const config = getLevelConfig(level);

  // Dynamic injection happens safely here on read, keeping database layers decoupled and lean!
  const populatedRestriction = user?.restriction ? {
    ...user.restriction,
    blocked_capabilities: config.blocks
  } : null;

  return {
    level,
    name: config.name,
    description: config.description,
    restriction: populatedRestriction,
    summary: user?.strike_summary ?? { active_strikes: 0, total_strikes: 0 },
    history: recentActions.map((a: any) => ({
      action_type: a.action_type,
      level: a.level,
      reason: a.reason,
      created_at: a.createdAt,
      expires_at: a.expires_at
    }))
  };
}

export async function removeContent(type: string, id: string) {
  const oid = new Types.ObjectId(id);
  const now = new Date();

  switch (type) {
    case 'post':
      await post_model.updateOne({ _id: oid }, { $set: { status: 'removed', 'moderation.removed_at': now } });
      break;
    case 'balloon':
      await balloon_model.updateOne({ _id: oid }, {
        $set: {
          moderation_status: 'removed',
          'moderation.removed_at': now
        }
      });
      break;
    case 'inbox_drawing':
      await inbox_model.updateOne({ _id: oid }, { $set: { status: 'removed', 'moderation.removed_at': now } });
      break;
    case 'comment':
      await post_comment_model.updateOne({ _id: oid }, { $set: { status: 'removed' } });
      break;
    case 'competition_comment':
      await competition_comment_model.updateOne({ _id: oid }, { $set: { status: 'removed' } });
      break;
    case 'inbox_comment':
      await setInboxCommentStatus(oid, null, 'removed');
      break;
    case 'competition_entry':
      // Scoring only ever considers `active` entries, so removing one here also
      // takes it out of the running. If it had already won, announce() rescores
      // and promotes the runner-up.
      await competition_entry_model.updateOne(
        { _id: oid },
        { $set: { status: 'removed', 'moderation.removed_at': now } }
      );
      break;
    case 'dm_message':
      await message_model.updateOne({ _id: oid }, { $set: { moderation_status: 'removed' } });
      break;
  }

  const executeAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  await deletion_queue_model.updateOne(
    { target_id: oid, target_type: type },
    { $set: { execute_after: executeAt } },
    { upsert: true }
  );
}

/**
 * Put moderated content back.
 *
 * Restores from `removed` as well as `under_review`. It used to match only
 * `under_review`, which made removal one-way: once a moderator (or the dev
 * panel) had upheld a report, a later "dismiss & restore" silently did nothing —
 * the query matched no document, no error was raised, and the content stayed
 * gone while the UI reported success. Appeals had no path back.
 *
 * @return true if a document actually changed state, so callers can avoid
 * telling an author their content is "back" when it never left.
 */
export async function restoreContent(type: string, id: string): Promise<boolean> {
  const oid = new Types.ObjectId(id);
  const hidden = { $in: ['under_review', 'removed'] };
  let modified = 0;

  switch (type) {
    case 'post':
      modified = (await post_model.updateOne({ _id: oid, status: hidden }, { $set: { status: 'active' } })).modifiedCount;
      break;
    case 'balloon':
      modified = (await balloon_model.updateOne({
        _id: oid,
        moderation_status: hidden
      }, { $set: { moderation_status: 'active' } })).modifiedCount;
      break;
    case 'inbox_drawing':
      modified = (await inbox_model.updateOne({ _id: oid, status: hidden }, { $set: { status: 'active' } })).modifiedCount;
      break;
    case 'comment':
      modified = (await post_comment_model.updateOne({ _id: oid, status: hidden }, { $set: { status: 'active' } })).modifiedCount;
      break;
    case 'competition_comment':
      modified = (await competition_comment_model.updateOne({ _id: oid, status: hidden }, { $set: { status: 'active' } })).modifiedCount;
      break;
    case 'inbox_comment':
      // Purpose-built helper: writes the MIGRATED comment collection and keeps
      // the parent item's comment_count straight. The embedded-array update this
      // used to do wrote to the legacy shape and left the count stale.
      modified = (await setInboxCommentStatus(oid, null, 'active')) ? 1 : 0;
      break;
    case 'competition_entry':
      // Votes were never deleted, so a cleared entry comes back with its
      // standing intact rather than restarting from zero.
      modified = (await competition_entry_model.updateOne(
        { _id: oid, status: hidden },
        { $set: { status: 'active' } }
      )).modifiedCount;
      break;
    case 'dm_message':
      modified = (await message_model.updateOne({
        _id: oid,
        moderation_status: hidden
      }, { $set: { moderation_status: 'active' } })).modifiedCount;
      break;
  }

  // Unconditional: a queued deletion outlives the status field, so it has to go
  // even when the status was already 'active'.
  await deletion_queue_model.deleteOne({ target_id: oid, target_type: type });
  return modified > 0;
}

/**
 * How many distinct pieces of a user's content must be auto-actioned inside 24h
 * before the user themselves is raised to the human queue. Read from
 * config/moderation.thresholds.ts rather than written here, so the number this
 * deployment runs is not published — see that file for why.
 */
const systemFlagThreshold = () => moderationThresholds().auto_quarantine.system_flag_threshold;

export async function evaluateUserStanding(authorId: string, triggeringReporterId: string) {
  const recentCutoff = dayjs().subtract(24, 'hour').toDate();

  const recentQuarantinedContent = await report_model.distinct('target_id', {
    target_author_id: new Types.ObjectId(authorId),
    status: 'auto_actioned',
    createdAt: { $gte: recentCutoff }
  });

  if (recentQuarantinedContent.length >= systemFlagThreshold()) {
    const existingSystemFlag = await report_model.findOne({
      target_id: new Types.ObjectId(authorId),
      target_type: 'user',
      status: 'pending'
    }).lean();

    if (!existingSystemFlag) {
      await report_model.create({
        reporter_id: new Types.ObjectId(triggeringReporterId),
        target_id: new Types.ObjectId(authorId),
        target_type: 'user',
        target_author_id: new Types.ObjectId(authorId),
        reason: 'spam', // Defaulting to spam/abuse of system
        details: `SYSTEM AUTO-FLAG: This user has had ${recentQuarantinedContent.length} different pieces of content auto-quarantined in the last 24 hours. Please review their account standing.`
      });
    }
  }
}
