import Router from 'koa-router';
import { Types } from 'mongoose';
import { user_model } from '../../models/user.model';
import { REPORT_REASONS, ReportReason, STRIKE_LADDER } from '../../types/moderation.policy';
import { moderation_action_model, report_model } from '../../models/moderation.model';
import {
  applyManualBan,
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
import { buildUserEvidence } from '../services/moderationEvidence.service';
import { risk_flag_model } from '../../models/risk-flag.model';
import { runRiskSweep } from '../services/riskSweep.service';
import { requireAdminAuth } from '../../middleware/adminAuth.middleware';
import { post_model } from '../../models/post.model';

export const devModerationRouter = new Router();

devModerationRouter.use(requireAdminAuth);

// =============================================================================
// USER EXPLORER
// =============================================================================

devModerationRouter.get('/users/search', async (ctx) => {
  const query = String(ctx.query.q ?? '').trim();
  if (query.length < 2) {
    ctx.body = { users: [] };
    return;
  }

  const byId = Types.ObjectId.isValid(query) ? [{ _id: new Types.ObjectId(query) }] : [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const users = await user_model
    .find({ $or: [...byId, { name: { $regex: escaped, $options: 'i' } }] })
    .select('_id name img description stats restriction strike_summary subscription_tier feed_level createdAt')
    .sort({ 'strike_summary.active_strikes': -1, 'stats.posts': -1 })
    .limit(16)
    .lean();

  ctx.body = { users };
});

devModerationRouter.get('/user/:user_id/overview', async (ctx) => {
  const userId = ctx.params.user_id;
  if (!Types.ObjectId.isValid(userId)) return ctx.throw(400, 'Invalid user id');
  const objectId = new Types.ObjectId(userId);

  const [user, standing, posts, totalReports, openReports, upheldReports, recentReports] = await Promise.all([
    user_model
      .findById(objectId)
      .select('name img description stats customization restriction strike_summary parental competition date_of_birth last_seen_version timezone subscription_tier feed_level artist_highlights profanity_filter inventory is_admin createdAt updatedAt')
      .lean() as any,
    getStanding(userId),
    post_model
      .find({ author_id: objectId })
      .select('_id thumbnail_url image_url description status reports_count views total_reactions comment_count competition_win createdAt')
      .sort({ createdAt: -1 })
      .limit(12)
      .lean(),
    report_model.countDocuments({ target_author_id: objectId }),
    report_model.countDocuments({ target_author_id: objectId, status: { $in: ['pending', 'auto_actioned'] } }),
    report_model.countDocuments({ target_author_id: objectId, status: 'upheld' }),
    report_model
      .find({ target_author_id: objectId })
      .select('_id target_type reason details status createdAt resolved_at')
      .sort({ createdAt: -1 })
      .limit(12)
      .lean()
  ]);

  if (!user) return ctx.throw(404, 'User not found');

  let ageBand: string | null = null;
  if (user.date_of_birth) {
    const age = Math.floor((Date.now() - new Date(user.date_of_birth).getTime()) / 31_557_600_000);
    ageBand = age < 13 ? 'Under 13' : age < 16 ? '13–15' : age < 18 ? '16–17' : '18+';
  }

  ctx.body = {
    profile: {
      _id: user._id.toString(),
      name: user.name,
      img: user.img,
      description: user.description,
      stats: user.stats,
      customization: user.customization,
      restriction: user.restriction,
      strike_summary: user.strike_summary,
      parental: user.parental,
      competition: user.competition,
      last_seen_version: user.last_seen_version,
      timezone: user.timezone,
      subscription_tier: user.subscription_tier,
      feed_level: user.feed_level,
      artist_highlights: user.artist_highlights,
      profanity_filter: user.profanity_filter,
      inventory_count: user.inventory?.length ?? 0,
      is_admin: user.is_admin === true,
      age_band: ageBand,
      created_at: user.createdAt,
      updated_at: user.updatedAt
    },
    standing,
    posts,
    reports: {
      total: totalReports,
      open: openReports,
      upheld: upheldReports,
      recent: recentReports
    }
  };
});

// =============================================================================
// PRODUCTION-PARITY ENDPOINTS
// =============================================================================

// GET /user/:user_id/evidence — the investigation dossier.
//
// Separate from /overview because it is a heavier read and it reaches into
// private DMs. /overview is what you look at for every user; this is what you
// pull when you are deciding whether to ban one.
devModerationRouter.get('/user/:user_id/evidence', async (ctx) => {
  const userId = ctx.params.user_id;
  if (!Types.ObjectId.isValid(userId)) return ctx.throw(400, 'Invalid user id');

  const evidence = await buildUserEvidence(userId);
  if (!evidence) return ctx.throw(404, 'User not found');

  ctx.body = evidence;
});

// =============================================================================
// MANUAL MODERATION ACTIONS
//
// These are the production levers, distinct from /set-level and /clear below
// them. Those two exist to put a test account into a given state and they
// DELETE the user's moderation_actions history to do it — which is exactly
// what you must not do to a real person, because that collection is the audit
// trail an appeal is answered from.
//
// Everything here is additive: it writes history, never erases it, and every
// action records which admin took it.
// =============================================================================

const ALLOWED_REASONS = Object.keys(REPORT_REASONS) as ReportReason[];

// POST /user/:user_id/strike — one strike, ladder advances by one rung.
// The proportionate response: use this when the account has done something
// actionable but is not obviously beyond saving.
devModerationRouter.post('/user/:user_id/strike', async (ctx) => {
  const userId = ctx.params.user_id;
  if (!Types.ObjectId.isValid(userId)) return ctx.throw(400, 'Invalid user id');

  const { reason, notes } = ctx.request.body as { reason?: string; notes?: string };
  if (!reason || !ALLOWED_REASONS.includes(reason as ReportReason)) {
    return ctx.throw(400, `reason must be one of: ${ALLOWED_REASONS.join(', ')}`);
  }

  const target = await user_model.findById(userId).select('_id is_admin').lean() as any;
  if (!target) return ctx.throw(404, 'User not found');
  if (target.is_admin) return ctx.throw(403, 'Refusing to action an administrator account');

  const result = await applyStrike({
    userId,
    reason: reason as ReportReason,
    adminId: ctx.state.user._id.toString()
  });

  // applyStrike has no notes parameter — it is normally driven by a report that
  // carries its own context. A hand-applied strike has none, so the reasoning
  // is recorded as its own audit entry rather than being lost.
  if (notes?.trim()) {
    await moderation_action_model.create({
      user_id: new Types.ObjectId(userId),
      // 'admin_note', never 'strike_applied' — recomputeStrikeSummary counts
      // strike_applied rows, so a note logged under that type silently becomes
      // a second strike and pushes the user an extra rung up the ladder.
      action_type: 'admin_note',
      level: result.level,
      reason,
      admin_id: new Types.ObjectId(ctx.state.user._id.toString()),
      notes: `ADMIN NOTE: ${notes.trim().slice(0, 900)}`
    });
  }

  ctx.body = await getStanding(userId);
});

// POST /user/:user_id/ban — straight to the top rung, no ladder climb.
// Notes are REQUIRED: this is the action with no expiry, and six months from
// now the only record of why it happened will be what is typed here.
devModerationRouter.post('/user/:user_id/ban', async (ctx) => {
  const userId = ctx.params.user_id;
  if (!Types.ObjectId.isValid(userId)) return ctx.throw(400, 'Invalid user id');

  const { reason, notes } = ctx.request.body as { reason?: string; notes?: string };
  if (!reason || !ALLOWED_REASONS.includes(reason as ReportReason)) {
    return ctx.throw(400, `reason must be one of: ${ALLOWED_REASONS.join(', ')}`);
  }
  if (!notes?.trim()) return ctx.throw(400, 'notes are required when banning an account');

  const target = await user_model.findById(userId).select('_id is_admin').lean() as any;
  if (!target) return ctx.throw(404, 'User not found');
  if (target.is_admin) return ctx.throw(403, 'Refusing to ban an administrator account');

  await applyManualBan({
    userId,
    adminId: ctx.state.user._id.toString(),
    reason,
    notes: notes.trim().slice(0, 900)
  });

  ctx.body = await getStanding(userId);
});

// POST /user/:user_id/lift — undo a restriction WITHOUT erasing the history
// that produced it. This is the appeal path; /clear is the test-reset path.
devModerationRouter.post('/user/:user_id/lift', async (ctx) => {
  const userId = ctx.params.user_id;
  if (!Types.ObjectId.isValid(userId)) return ctx.throw(400, 'Invalid user id');

  const { notes, appeal, clear_strikes } = ctx.request.body as {
    notes?: string;
    appeal?: boolean;
    clear_strikes?: boolean;
  };

  await liftRestriction({
    userId,
    adminId: ctx.state.user._id.toString(),
    reason: appeal ? 'appeal_granted' : 'manual_override',
    notes: notes?.trim().slice(0, 900) || 'Lifted from the admin panel',
    clearStrikes: clear_strikes === true
  });

  ctx.body = await getStanding(userId);
});

// =============================================================================
// RISK FLAGS — nightly sweep output
// =============================================================================

// GET /risk — the flag queue, newest and most severe first.
devModerationRouter.get('/risk', async (ctx) => {
  const status = String(ctx.query.status ?? 'open');
  const rule = ctx.query.rule ? String(ctx.query.rule) : null;
  const limit = Math.min(Number(ctx.query.limit) || 50, 200);

  const query: Record<string, any> = { status };
  if (rule) query.rule = rule;

  const [flags, counts] = await Promise.all([
    risk_flag_model
      .find(query)
      .sort({ severity: 1, createdAt: -1 })
      .limit(limit)
      .lean(),
    risk_flag_model.aggregate([
      { $match: { status: 'open' } },
      { $group: { _id: '$rule', count: { $sum: 1 } } }
    ])
  ]);

  // Hydrate the subject inline: a queue of bare ObjectIds is unusable, and one
  // extra query beats N round-trips from the browser.
  const userIds = flags.map((f: any) => f.user_id);
  const users = userIds.length
    ? await user_model
        .find({ _id: { $in: userIds } })
        .select('name img restriction strike_summary createdAt')
        .lean()
    : [];
  const userById = new Map(users.map((u: any) => [String(u._id), u]));

  ctx.body = {
    flags: flags.map((flag: any) => ({
      ...flag,
      _id: String(flag._id),
      user: userById.get(String(flag.user_id)) ?? null
    })),
    open_by_rule: counts.reduce(
      (acc: Record<string, number>, row: any) => ({ ...acc, [row._id]: row.count }),
      {}
    )
  };
});

// POST /risk/:flag_id/resolve — 'reviewed' (looked, acted elsewhere) or
// 'dismissed' (false positive). Neither changes the user's standing: acting on
// an account is still a separate, deliberate strike/ban.
devModerationRouter.post('/risk/:flag_id/resolve', async (ctx) => {
  const flagId = ctx.params.flag_id;
  if (!Types.ObjectId.isValid(flagId)) return ctx.throw(400, 'Invalid flag id');

  const { status } = ctx.request.body as { status?: string };
  if (status !== 'reviewed' && status !== 'dismissed') {
    return ctx.throw(400, "status must be 'reviewed' or 'dismissed'");
  }

  const updated = await risk_flag_model.findByIdAndUpdate(
    flagId,
    {
      $set: {
        status,
        resolved_by: new Types.ObjectId(ctx.state.user._id.toString()),
        resolved_at: new Date()
      }
    },
    { new: true }
  ).lean();

  if (!updated) return ctx.throw(404, 'Flag not found');
  ctx.body = { success: true, flag: { ...updated, _id: String(updated._id) } };
});

// POST /risk/run — trigger the sweep by hand instead of waiting for 03:00.
devModerationRouter.post('/risk/run', async (ctx) => {
  ctx.body = await runRiskSweep();
});

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
