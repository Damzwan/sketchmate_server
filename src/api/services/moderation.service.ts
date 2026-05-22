import dayjs from 'dayjs';
import { Types } from 'mongoose';
import { getLevelConfig, POLICY_CONSTANTS, ReportReason, STRIKE_LADDER } from '../../types/moderation.policy';
import { moderation_action_model, report_model } from '../../models/moderation.model';
import { user_model } from '../../models/user.model';
import { sendSocketNotificationToUser } from '../socket/socket';

import { post_model, post_comment_model } from '../../models/post.model';
import { balloon_model } from '../../models/balloon.model';
import { inbox_model } from '../../models/inbox.model';
import { message_model } from '../../models/message.model';
import { deletion_queue_model } from '../../models/deletion.model';

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

  const restriction = {
    level: newLevel,
    reason,
    applied_at: new Date(),
    expires_at: expiresAt
  };

  // Completely clean update layout - zero structural conflicts or $unset runtime casting crashes
  await user_model.updateOne(
    { _id: userId },
    {
      $set: { restriction, strike_summary: summary }
    }
  );

  if (newLevel > 0) {
    // Audit logs preserve historic capability snapshots for legal/audit validation
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

  // Socket triggers dynamic capability hydration maps straight down to the client view layers
  sendSocketNotificationToUser(userId, 'moderation:strike', {
    level: newLevel,
    name: config.name,
    description: config.description,
    reason,
    expires_at: expiresAt,
    blocked_capabilities: [...config.blocks]
  });

  return { level: newLevel, restriction };
}

export async function recomputeStrikeSummary(userId: string) {
  const decayCutoff = dayjs()
    .subtract(POLICY_CONSTANTS.STRIKE_DECAY_DAYS, 'day')
    .toDate();

  const [activeCount, totalCount, lastStrike] = await Promise.all([
    moderation_action_model.countDocuments({
      user_id: new Types.ObjectId(userId),
      action_type: 'strike_applied',
      createdAt: { $gte: decayCutoff }
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

export async function liftRestriction(params: {
  userId: string;
  adminId: string;
  notes?: string;
  reason: 'appeal_granted' | 'manual_override';
}) {
  await Promise.all([
    user_model.updateOne(
      { _id: params.userId },
      {
        $set: {
          'restriction.level': 0,
          'restriction.expires_at': null,
          'restriction.reason': 'clear'
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

  sendSocketNotificationToUser(params.userId, 'moderation:restriction_lifted', {
    message: 'Your restriction has been lifted. Welcome back!'
  });
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
    case 'inbox_comment':
      await inbox_model.updateOne({ 'comments._id': oid }, { $set: { 'comments.$.status': 'removed' } });
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

export async function restoreContent(type: string, id: string) {
  const oid = new Types.ObjectId(id);

  switch (type) {
    case 'post':
      await post_model.updateOne({ _id: oid, status: 'under_review' }, { $set: { status: 'active' } });
      break;
    case 'balloon':
      await balloon_model.updateOne({
        _id: oid,
        moderation_status: 'under_review'
      }, { $set: { moderation_status: 'active' } });
      break;
    case 'inbox_drawing':
      await inbox_model.updateOne({ _id: oid, status: 'under_review' }, { $set: { status: 'active' } });
      break;
    case 'comment':
      await post_comment_model.updateOne({ _id: oid, status: 'under_review' }, { $set: { status: 'active' } });
      break;
    case 'inbox_comment':
      await inbox_model.updateOne({
        'comments._id': oid,
        'comments.status': 'removed'
      }, { $set: { 'comments.$.status': 'active' } });
      break;
    case 'dm_message':
      await message_model.updateOne({
        _id: oid,
        moderation_status: 'removed'
      }, { $set: { moderation_status: 'active' } });
      break;
  }
  await deletion_queue_model.deleteOne({ target_id: oid, target_type: type });
}

const SYSTEM_FLAG_THRESHOLD = 3;

export async function evaluateUserStanding(authorId: string, triggeringReporterId: string) {
  const recentCutoff = dayjs().subtract(24, 'hour').toDate();

  const recentQuarantinedContent = await report_model.distinct('target_id', {
    target_author_id: new Types.ObjectId(authorId),
    status: 'auto_actioned',
    createdAt: { $gte: recentCutoff }
  });

  if (recentQuarantinedContent.length >= SYSTEM_FLAG_THRESHOLD) {
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