import dayjs from 'dayjs';
import { Types } from 'mongoose';
import { getLevelConfig, POLICY_CONSTANTS, ReportReason, STRIKE_LADDER } from '../../types/moderation.policy';
import { moderation_action_model } from '../../models/moderation.model';
import { user_model } from '../../models/user.model';
import { sendSocketNotificationToUser } from '../socket/socket';


/**
 * Apply a strike to a user. The single entry point — auto-quarantines call it,
 * manual mod resolutions call it, escalation cron (if any) calls it.
 *
 * Flow:
 *   1. Append a moderation_action (audit log)
 *   2. Recompute active strike count (counts non-decayed strikes)
 *   3. Project the new strike count → level → blocked capabilities
 *   4. Update user.restriction + user.strike_summary
 *   5. Push a socket event so the client can show the restriction modal
 */
export async function applyStrike(params: {
  userId: string;
  reason: ReportReason;
  sourceReportId?: string;
  adminId?: string;
}) {
  const { userId, reason, sourceReportId, adminId } = params;

  // 1. Audit entry
  await moderation_action_model.create({
    user_id: new Types.ObjectId(userId),
    action_type: 'strike_applied',
    reason,
    source_report_id: sourceReportId ? new Types.ObjectId(sourceReportId) : undefined,
    admin_id: adminId ? new Types.ObjectId(adminId) : undefined
  });

  // 2. Recompute from the audit log — this is the source of truth
  const summary = await recomputeStrikeSummary(userId);

  // 3. Determine new level + apply restriction projection
  const newLevel = Math.min(summary.active_strikes, STRIKE_LADDER.length - 1);
  const config = getLevelConfig(newLevel);
  const expiresAt = config.duration_days
    ? dayjs().add(config.duration_days, 'day').toDate()
    : null;

  const restriction = {
    level: newLevel,
    reason,
    applied_at: new Date(),
    expires_at: expiresAt,
    blocked_capabilities: [...config.blocks]
  };

  // 4. Persist denormalized projection
  await user_model.updateOne(
    { _id: userId },
    { $set: { restriction, strike_summary: summary } }
  );

  // Audit the restriction transition separately so the timeline is complete
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

  // 5. Tell the client — modal fires from this event
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

/**
 * Counts non-decayed upheld strikes from the audit log.
 * Decay is computed on read — there's no cron to "expire" old strikes.
 * This means level always reflects the true current state.
 */
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

/**
 * Lifts a restriction manually — used by appeals and admin overrides.
 */
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
          'restriction.blocked_capabilities': [],
          'restriction.expires_at': null
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

/**
 * Returns the user-facing "Your Standing" payload — used by the frontend
 * standing page so the user can see exactly where they are.
 */
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

  return {
    level,
    name: config.name,
    description: config.description,
    restriction: user?.restriction ?? null,
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