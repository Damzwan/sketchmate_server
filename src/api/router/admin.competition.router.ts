import Router from 'koa-router';
import { Types } from 'mongoose';
import { requireAdminAuth } from '../../middleware/adminAuth.middleware';
import {
  competition_entry_model,
  competition_model,
  competition_notification_model,
  competition_theme_model,
  competition_vote_model,
} from '../../models/competition.model';
import { user_model } from '../../models/user.model';
import { CATALOG, describeGrant } from '../../config/catalog.config';
import {
  ACCENT_KEYS,
  CHAMPION_TITLE_ITEM,
  COMPETITION_ACCENTS,
  CYCLE,
  DAY,
  DEFAULT_CATEGORIES,
  phaseFor,
  startOfIsoWeekUtc,
  weekKeyFor,
} from '../../config/competition.config';
import {
  announceCompetition,
  createCompetition,
  getActiveCompetition,
  scoreCompetition,
} from '../services/competition.service';
import { grantItems, missingItems } from '../services/inventory.service';
import { PUBLIC_USER_FIELDS } from '../../types/projections';

/**
 * Competition admin.
 *
 * Everything here is an OVERRIDE for a system that already runs itself: if this
 * page is never opened, the cron still opens, scores, grants and announces
 * every week using the fallback theme pool. The one genuinely recurring task is
 * approving theme suggestions (§2.6), and even that has an automatic fallback.
 */
export const adminCompetitionRouter = new Router();

adminCompetitionRouter.use(requireAdminAuth);

const findComp = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) return null;
  return competition_model.findById(id);
};

// ─── SCHEDULE ────────────────────────────────────────────────────────────────

// GET /admin/competition?limit=
adminCompetitionRouter.get('/', async (ctx) => {
  const limit = Math.min(parseInt(ctx.query.limit as string) || 12, 50);
  const now = new Date();
  const currentWeekStart = startOfIsoWeekUtc(now);
  const nextWeekStart = new Date(currentWeekStart.getTime() + 7 * DAY);
  const [recent, upcoming] = await Promise.all([
    competition_model
      .find({ starts_at: { $lt: nextWeekStart } })
      .sort({ starts_at: -1 })
      .limit(limit)
      .lean(),
    competition_model
      .find({ starts_at: { $gte: nextWeekStart } })
      .sort({ starts_at: 1 })
      .limit(104)
      .lean(),
  ]);
  const competitions = [...upcoming, ...recent];
  const byWeek = new Map(competitions.map((competition) => [competition.week_key, competition]));
  const scheduleSlots = Array.from({ length: 16 }, (_, index) => {
    const startsAt = new Date(nextWeekStart.getTime() + index * 7 * DAY);
    const weekKey = weekKeyFor(startsAt);
    const competition = byWeek.get(weekKey);
    return {
      week_key: weekKey,
      starts_at: startsAt,
      submissions_close_at: new Date(startsAt.getTime() + CYCLE.submissions_close_ms),
      ends_at: new Date(startsAt.getTime() + CYCLE.duration_ms),
      competition_id: competition?._id.toString() ?? null,
      theme: competition?.theme ?? null,
      available: !competition,
    };
  });

  ctx.body = {
    competitions: competitions.map((c) => ({
      ...c,
      _id: c._id.toString(),
      // Stored phase can lag the clock by up to an hour; show both so a
      // "why is this still open?" question answers itself.
      derived_phase: c.phase === 'announced' ? 'announced' : phaseFor(c as any, now),
    })),
    pending_themes: await competition_theme_model.countDocuments({ status: 'pending' }),
    upcoming_competitions: upcoming.map((c) => ({
      ...c,
      _id: c._id.toString(),
      derived_phase: c.phase === 'announced' ? 'announced' : phaseFor(c as any, now),
    })),
    schedule_slots: scheduleSlots,
    next_week_key: weekKeyFor(nextWeekStart),
    accents: ACCENT_KEYS,
    accent_options: Object.entries(COMPETITION_ACCENTS).map(([key, colors]) => ({
      key,
      ...colors,
    })),
    default_categories: DEFAULT_CATEGORIES,
  };
});

/**
 * The reward picker's source. Served from here so the platform never duplicates
 * catalog.config — a stale copy would let an admin promise an item that no
 * longer exists.
 */
adminCompetitionRouter.get('/catalog', async (ctx) => {
  const items = new Map<string, { id: string; label: string; emoji: string; category: string }>();

  for (const sku of CATALOG) {
    for (const itemId of sku.grants) {
      if (items.has(itemId)) continue;
      const grant = describeGrant(itemId);
      items.set(itemId, {
        id: itemId,
        label: grant.label,
        emoji: grant.emoji,
        category: grant.category,
      });
    }
  }

  ctx.body = { items: Array.from(items.values()) };
});

// POST /admin/competition — schedule a future week by hand.
adminCompetitionRouter.post('/', async (ctx) => {
  const { theme, theme_blurb, accent, starts_at, categories, theme_source_id } = (ctx.request.body ?? {}) as Record<
    string,
    any
  >;

  let selectedTheme: any = null;
  if (theme_source_id) {
    if (!Types.ObjectId.isValid(theme_source_id)) {
      return ctx.throw(400, 'Valid theme_source_id required');
    }
    selectedTheme = await competition_theme_model.findOne({
      _id: new Types.ObjectId(theme_source_id),
      status: 'approved',
    });
    if (!selectedTheme) return ctx.throw(404, 'Approved theme not found');
  }

  const resolvedTheme = selectedTheme?.text_filtered || selectedTheme?.text || theme?.trim();
  if (!resolvedTheme) return ctx.throw(400, 'theme is required');

  if (!starts_at) return ctx.throw(400, 'Choose an upcoming weekly slot');
  const start = new Date(starts_at);
  if (Number.isNaN(start.getTime())) return ctx.throw(400, 'starts_at is invalid');
  const canonicalStart = startOfIsoWeekUtc(start);
  if (canonicalStart.getTime() !== start.getTime()) {
    return ctx.throw(400, 'Competitions must start in a Monday 00:00 UTC weekly slot');
  }
  const nextWeekStart = new Date(startOfIsoWeekUtc().getTime() + 7 * DAY);
  if (start.getTime() < nextWeekStart.getTime()) {
    return ctx.throw(400, 'Only future competition weeks can be scheduled');
  }
  if (start.getTime() >= nextWeekStart.getTime() + 52 * 7 * DAY) {
    return ctx.throw(400, 'Choose a competition slot within the next year');
  }

  const weekKey = weekKeyFor(start);
  if (await competition_model.exists({ week_key: weekKey })) {
    return ctx.throw(409, `A competition already exists for ${weekKey}`);
  }

  const comp = await createCompetition({
    week_key: weekKey,
    starts_at: start,
    theme: resolvedTheme,
    theme_blurb: theme_blurb || selectedTheme?.blurb,
    accent: accent || selectedTheme?.accent,
    categories,
  });

  if (selectedTheme) {
    comp.theme_source_id = selectedTheme._id;
    await Promise.all([
      comp.save(),
      competition_theme_model.updateOne({ _id: selectedTheme._id }, { $set: { status: 'used', used_in: comp._id } }),
    ]);
  }

  ctx.status = 201;
  ctx.body = { competition: comp };
});

/**
 * PATCH /admin/competition/:id
 *
 * A competition that is already open only accepts cosmetic edits. Moving dates
 * or rewards mid-week changes the deal people already entered under, and the
 * rewards on the document are the snapshot the grant reads from.
 */
adminCompetitionRouter.patch('/:id', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const body = (ctx.request.body ?? {}) as Record<string, any>;
  const effectivePhase = comp.phase === 'announced' ? 'announced' : phaseFor(comp, new Date());
  const live = effectivePhase !== 'scheduled';

  if (body.starts_at !== undefined || body.ends_at !== undefined || body.submissions_close_at !== undefined) {
    return ctx.throw(400, 'Competition dates use fixed weekly slots and cannot be edited');
  }

  if (typeof body.theme_blurb === 'string') comp.theme_blurb = body.theme_blurb;
  if (typeof body.accent === 'string') comp.accent = body.accent;

  if (!live) {
    if (typeof body.theme === 'string' && body.theme.trim()) comp.theme = body.theme.trim();
  }

  // Rewards stay editable until the competition CLOSES — picking the prize a
  // few days in is normal, and nothing has been granted yet.
  if (Array.isArray(body.categories) && !['closed', 'announced'].includes(effectivePhase)) {
    comp.categories = body.categories;
  }

  await comp.save();

  ctx.body = { competition: comp, cosmetic_only: live };
});

/** Delete an upcoming empty week and release its selected community theme. */
adminCompetitionRouter.delete('/:id', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const effectivePhase = phaseFor(comp, new Date());
  if (effectivePhase !== 'scheduled' || comp.phase !== 'scheduled') {
    return ctx.throw(409, 'Only upcoming competitions can be deleted');
  }
  if (await competition_entry_model.exists({ competition_id: comp._id })) {
    return ctx.throw(409, 'A competition with entries cannot be deleted');
  }

  await Promise.all([
    competition_notification_model.deleteMany({ week_key: comp.week_key }),
    comp.theme_source_id
      ? competition_theme_model.updateOne(
          { _id: comp.theme_source_id, used_in: comp._id },
          { $set: { status: 'approved' }, $unset: { used_in: 1 } }
        )
      : Promise.resolve(),
    competition_model.deleteOne({ _id: comp._id }),
  ]);

  ctx.body = { success: true };
});

// ─── ENTRIES ─────────────────────────────────────────────────────────────────

adminCompetitionRouter.get('/:id/entries', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const entries = await competition_entry_model
    .find({ competition_id: comp._id })
    .sort({ total_votes: -1, submitted_at: 1 })
    .lean();

  const authors = await user_model
    .find({ _id: { $in: entries.map((e) => e.user_id) } })
    .select(PUBLIC_USER_FIELDS)
    .lean();

  const authorById = new Map(authors.map((a: any) => [a._id.toString(), a]));

  // Vote concentration: what share of an entry's votes came from accounts
  // created the same week. A brigade from a handful of throwaways lights up
  // here. Flagged for a human — v1 never auto-punishes on this signal.
  const flags = await Promise.all(
    entries.map(async (entry) => {
      const votes = await competition_vote_model.find({ entry_id: entry._id }).select('voter_id').lean();
      if (votes.length < 5) return 0;

      const voters = await user_model
        .find({ _id: { $in: votes.map((v) => v.voter_id) } })
        .select('createdAt')
        .lean();

      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const fresh = voters.filter((v: any) => new Date(v.createdAt).getTime() > weekAgo).length;

      return voters.length ? fresh / voters.length : 0;
    })
  );

  ctx.body = {
    entries: entries.map((e, i) => ({
      ...e,
      _id: e._id.toString(),
      author: authorById.get(e.user_id.toString()) ?? null,
      vote_counts: e.vote_counts ?? {},
      new_account_vote_ratio: flags[i],
    })),
  };
});

// POST /admin/competition/entry/:entry_id/remove  { reason? }
adminCompetitionRouter.post('/entry/:entry_id/remove', async (ctx) => {
  const { entry_id } = ctx.params;
  if (!Types.ObjectId.isValid(entry_id)) return ctx.throw(400, 'Valid entry_id required');

  const { reason } = (ctx.request.body ?? {}) as { reason?: string };

  const entry = await competition_entry_model.findByIdAndUpdate(
    entry_id,
    {
      $set: {
        status: 'removed',
        'moderation.removed_at': new Date(),
        'moderation.last_report_reason': reason ?? 'admin removal',
      },
    },
    { new: true }
  );
  if (!entry) return ctx.throw(404, 'Entry not found');

  console.log(`[admin competition] ${ctx.state.user._id} removed entry ${entry_id} (${reason ?? 'no reason'})`);

  ctx.body = { success: true };
});

adminCompetitionRouter.post('/entry/:entry_id/restore', async (ctx) => {
  const { entry_id } = ctx.params;
  if (!Types.ObjectId.isValid(entry_id)) return ctx.throw(400, 'Valid entry_id required');

  const entry = await competition_entry_model.findByIdAndUpdate(
    entry_id,
    { $set: { status: 'active' }, $unset: { 'moderation.removed_at': 1 } },
    { new: true }
  );
  if (!entry) return ctx.throw(404, 'Entry not found');

  ctx.body = { success: true };
});

// ─── RESULTS ─────────────────────────────────────────────────────────────────

adminCompetitionRouter.get('/:id/results', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const entries = await competition_entry_model
    .find({ _id: { $in: comp.results.map((r) => r.entry_id) } })
    .select('_id thumbnail_url impressions total_votes')
    .lean();

  const winners = await user_model
    .find({ _id: { $in: comp.results.map((r) => r.user_id) } })
    .select('_id name img inventory')
    .lean();

  const entryById = new Map(entries.map((e) => [e._id.toString(), e]));
  const userById = new Map(winners.map((u: any) => [u._id.toString(), u]));

  ctx.body = {
    competition: { ...comp.toObject(), _id: comp._id.toString() },
    results: comp.results.map((r) => {
      const winner = userById.get(r.user_id.toString());
      const owned = new Set(winner?.inventory ?? []);
      return {
        category_id: r.category_id,
        votes: r.votes,
        granted_items: r.granted_items,
        // The audit answer to "did the grant actually land?" — the admin page
        // needs this to decide whether Re-grant is worth pressing.
        grant_confirmed: r.granted_items.every((id: string) => owned.has(id)),
        winner: winner ? { _id: winner._id.toString(), name: winner.name, img: winner.img } : null,
        entry: entryById.get(r.entry_id.toString()) ?? null,
      };
    }),
  };
});

/** Recompute from `competition_votes`. Does not announce. */
adminCompetitionRouter.post('/:id/recompute', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const results = await scoreCompetition(comp._id);
  ctx.body = { results };
});

/** Score + announce out of band, for a cron that did not run. Idempotent. */
adminCompetitionRouter.post('/:id/announce', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  if (!comp.results.length) await scoreCompetition(comp._id);
  const announced = await announceCompetition(comp._id);

  ctx.body = { competition: announced };
});

/** Re-run a grant that failed at announce time. `$addToSet`, so it cannot double. */
adminCompetitionRouter.post('/:id/regrant', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const granted: Record<string, string[]> = {};
  for (const result of comp.results) {
    const categoryRewards = comp.categories.find((category) => category.id === result.category_id)?.reward_items ?? [];
    const titleGrant = await missingItems(result.user_id, [CHAMPION_TITLE_ITEM]);
    const intended = Array.from(new Set([...result.granted_items, ...categoryRewards, ...titleGrant]));
    if (!intended.length) continue;
    await grantItems(result.user_id, intended, `admin re-grant ${comp.week_key} / ${result.category_id}`);
    result.granted_items = intended;
    granted[result.category_id] = intended;
  }

  comp.markModified('results');
  await comp.save();

  ctx.body = { granted };
});

// ─── THEME QUEUE ─────────────────────────────────────────────────────────────

// GET /admin/competition/themes?status=pending
adminCompetitionRouter.get('/themes/queue', async (ctx) => {
  const status = (ctx.query.status as string) || 'pending';

  const themes = await competition_theme_model.find({ status }).sort({ upvotes: -1, createdAt: 1 }).limit(100).lean();

  const authors = await user_model
    .find({ _id: { $in: themes.map((t) => t.suggested_by).filter(Boolean) } })
    .select('_id name img')
    .lean();

  const authorById = new Map(authors.map((a: any) => [a._id.toString(), a]));

  ctx.body = {
    themes: themes.map((t) => ({
      ...t,
      _id: t._id.toString(),
      author: t.suggested_by ? authorById.get(t.suggested_by.toString()) ?? null : null,
    })),
    counts: {
      pending: await competition_theme_model.countDocuments({ status: 'pending' }),
      approved: await competition_theme_model.countDocuments({ status: 'approved' }),
    },
  };
});

// POST /admin/competition/themes/:theme_id/decision  { decision, reason?, blurb?, accent? }
adminCompetitionRouter.post('/themes/:theme_id/decision', async (ctx) => {
  const { theme_id } = ctx.params;
  if (!Types.ObjectId.isValid(theme_id)) return ctx.throw(400, 'Valid theme_id required');

  const { decision, reason, blurb, accent } = (ctx.request.body ?? {}) as Record<string, any>;
  if (!['approved', 'rejected'].includes(decision)) {
    return ctx.throw(400, 'decision must be approved or rejected');
  }

  const update: Record<string, any> = { status: decision };
  if (decision === 'rejected') update.rejected_reason = reason ?? '';
  if (blurb) update.blurb = blurb;
  if (accent) update.accent = accent;

  const theme = await competition_theme_model.findByIdAndUpdate(theme_id, { $set: update }, { new: true });
  if (!theme) return ctx.throw(404, 'Theme not found');

  console.log(`[admin competition] ${ctx.state.user._id} ${decision} theme "${theme.text}"`);

  ctx.body = { theme };
});

/** Curated theme — ours, no author, straight into the approved pool. */
adminCompetitionRouter.post('/themes', async (ctx) => {
  const { text, blurb, accent } = (ctx.request.body ?? {}) as Record<string, any>;
  if (!text?.trim()) return ctx.throw(400, 'text is required');

  const cycle = await getActiveCompetition();
  const theme = await competition_theme_model.create({
    text: text.trim(),
    blurb,
    accent,
    cycle_competition_id: cycle?._id,
    status: 'approved',
  });

  ctx.status = 201;
  ctx.body = { theme };
});

export default adminCompetitionRouter;
