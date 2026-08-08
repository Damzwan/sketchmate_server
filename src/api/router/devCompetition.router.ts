import Router from 'koa-router';
import { Types } from 'mongoose';
import { requireAdminAuth } from '../../middleware/adminAuth.middleware';
import {
  competition_entry_model,
  competition_model,
  competition_notification_model,
  competition_vote_model,
} from '../../models/competition.model';
import { user_model } from '../../models/user.model';
import {
  DEFAULT_CATEGORIES,
  isTestWeekKey,
  MINUTE,
  testWeekKey,
  TEST_CYCLE,
} from '../../config/competition.config';
import { announceCompetition, createCompetition, scoreCompetition } from '../services/competition.service';
import { notifyWinners, runCompetitionNotifications } from '../services/competitionNotifications.service';
import { revokeItems } from '../services/inventory.service';

/**
 * Dev-only competition controls.
 *
 * A weekly feature is untestable if the only way to see a transition is to wait
 * a week. These routes exist so one person can walk the entire cycle — enter,
 * vote, close, score, grant, announce — in about a minute, against the real
 * service code rather than a mock.
 *
 * Same shape as devModeration.router: admin-only, and additionally refuses to
 * mount in production unless explicitly allowed.
 */
export const devCompetitionRouter = new Router();

devCompetitionRouter.use(requireAdminAuth);

devCompetitionRouter.use(async (ctx, next) => {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_COMPETITION !== '1') {
    return ctx.throw(403, 'Dev competition routes are disabled in production');
  }
  await next();
});

const findComp = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) return null;
  return competition_model.findById(id);
};

// ─── CREATE ──────────────────────────────────────────────────────────────────
// POST /dev/competition/create
// Body: { theme?, accent?, minutes?, submissions_minutes?, categories? }
// Defaults to the six-minute cycle: a whole week while you make coffee.
devCompetitionRouter.post('/create', async (ctx) => {
  const { theme, theme_blurb, accent, minutes, submissions_minutes, grace_minutes, categories, reward_items } =
    (ctx.request.body ?? {}) as Record<string, any>;

  const duration_ms = minutes ? minutes * MINUTE : TEST_CYCLE.duration_ms;
  const submissions_close_ms = submissions_minutes
    ? submissions_minutes * MINUTE
    : Math.min(TEST_CYCLE.submissions_close_ms, duration_ms - MINUTE);
  // The real cycle's six-hour results window would outlast the whole test, so
  // scale it: long enough to look at the winners, short enough to iterate.
  const results_grace_ms = grace_minutes ? grace_minutes * MINUTE : TEST_CYCLE.results_grace_ms;

  const cats = (categories as any[]) ?? DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  const dummyRewards = ['theme.midnight', 'effect.shimmer-rainbow', 'world.space'];
  cats.forEach((category, index) => {
    if (!category.reward_items?.length) {
      category.reward_items = [dummyRewards[index % dummyRewards.length]];
    }
  });
  if (reward_items?.length && cats.length) cats[0].reward_items = reward_items;

  const comp = await createCompetition({
    week_key: testWeekKey(),
    starts_at: new Date(),
    duration_ms,
    submissions_close_ms,
    results_grace_ms,
    theme: theme ?? 'TEST — draw anything',
    theme_blurb,
    accent,
    categories: cats,
  });

  // Created in the past-tense sense: starts_at is now, so it is already open.
  comp.phase = 'open';
  await comp.save();

  ctx.body = { competition: comp };
});

// ─── PHASE CONTROL ───────────────────────────────────────────────────────────
// POST /dev/competition/:id/phase  { phase }
// Shifts the timestamps so the forced phase is also what phaseFor() computes —
// otherwise the next cron tick would immediately undo it.
devCompetitionRouter.post('/:id/phase', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const { phase } = ctx.request.body as { phase: string };
  const now = Date.now();

  switch (phase) {
    case 'scheduled':
      comp.starts_at = new Date(now + 60 * MINUTE);
      comp.submissions_close_at = new Date(now + 120 * MINUTE);
      comp.ends_at = new Date(now + 180 * MINUTE);
      break;
    case 'open':
      comp.starts_at = new Date(now - MINUTE);
      comp.submissions_close_at = new Date(now + 60 * MINUTE);
      comp.ends_at = new Date(now + 120 * MINUTE);
      break;
    case 'voting':
      comp.starts_at = new Date(now - 120 * MINUTE);
      comp.submissions_close_at = new Date(now - MINUTE);
      comp.ends_at = new Date(now + 60 * MINUTE);
      break;
    case 'closed':
    case 'announced':
      comp.starts_at = new Date(now - 180 * MINUTE);
      comp.submissions_close_at = new Date(now - 120 * MINUTE);
      comp.ends_at = new Date(now - MINUTE);
      break;
    default:
      return ctx.throw(400, 'Unknown phase');
  }

  comp.phase = phase as any;
  await comp.save();

  ctx.body = { competition: comp };
});

// POST /dev/competition/:id/fast-forward  { minutes }
devCompetitionRouter.post('/:id/fast-forward', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const minutes = Number((ctx.request.body as any)?.minutes ?? 60);
  const shift = minutes * MINUTE;

  comp.starts_at = new Date(comp.starts_at.getTime() - shift);
  comp.submissions_close_at = new Date(comp.submissions_close_at.getTime() - shift);
  comp.ends_at = new Date(comp.ends_at.getTime() - shift);
  await comp.save();

  ctx.body = { competition: comp };
});

// ─── SEEDING ─────────────────────────────────────────────────────────────────
// POST /dev/competition/:id/seed-entries  { count?, image_url? }
// A page with 40 entries behaves nothing like a page with 2. This is the single
// most useful route here.
devCompetitionRouter.post('/:id/seed-entries', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const { count = 20, image_url } = (ctx.request.body ?? {}) as Record<string, any>;

  // Reuse real users so avatars, customization and titles render like
  // production. Everything created here is flagged `seeded` — these are real
  // accounts, and scoring must never hand one of them a reward or a "you won"
  // push for a drawing they did not submit.
  const users = await user_model
    .find({ _id: { $ne: ctx.state.user._id } })
    .select('_id')
    .limit(Number(count))
    .lean();

  if (!users.length) return ctx.throw(400, 'No other users to seed entries from');

  // Fall back to real post images so the grid has actual artwork in it.
  const samples = await competition_entry_model.db
    .collection('posts')
    .find({ status: 'active' })
    .project({ image_url: 1, thumbnail_url: 1, aspect_ratio: 1 })
    .limit(Number(count))
    .toArray();

  const created: string[] = [];
  for (let i = 0; i < users.length; i++) {
    const sample = samples[i % Math.max(samples.length, 1)];
    const img = image_url ?? sample?.image_url;
    if (!img) break;

    try {
      const entry = await competition_entry_model.create({
        competition_id: comp._id,
        user_id: users[i]._id,
        drawing_url: img,
        image_url: img,
        thumbnail_url: sample?.thumbnail_url ?? img,
        aspect_ratio: sample?.aspect_ratio ?? 1,
        caption: `Seeded entry #${i + 1}`,
        seeded: true,
        submitted_at: new Date(Date.now() - i * 1000),
      });
      created.push(entry._id.toString());
    } catch {
      // Unique index — that user already has an entry. Skip.
    }
  }

  await competition_model.updateOne({ _id: comp._id }, { $inc: { entry_count: created.length } });

  ctx.body = { seeded: created.length, entry_ids: created };
});

// POST /dev/competition/:id/seed-votes  { votes? }
devCompetitionRouter.post('/:id/seed-votes', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const target = Number((ctx.request.body as any)?.votes ?? 60);

  const [entries, voters] = await Promise.all([
    competition_entry_model.find({ competition_id: comp._id, status: 'active' }).select('_id user_id').lean(),
    user_model.find({}).select('_id').limit(200).lean(),
  ]);

  if (!entries.length || !voters.length) return ctx.throw(400, 'Seed entries first');

  let cast = 0;
  for (let i = 0; i < target; i++) {
    const entry = entries[Math.floor(Math.random() * entries.length)];
    const voter = voters[Math.floor(Math.random() * voters.length)];
    const category = comp.categories[Math.floor(Math.random() * comp.categories.length)];
    if (entry.user_id.toString() === voter._id.toString()) continue;

    try {
      const alreadyVotedForEntry = await competition_vote_model.exists({
        competition_id: comp._id,
        entry_id: entry._id,
        voter_id: voter._id,
      });
      if (alreadyVotedForEntry) continue;
      await competition_vote_model.create({
        competition_id: comp._id,
        entry_id: entry._id,
        voter_id: voter._id,
        category_id: category.id,
        slot: 'entry',
        seeded: true,
      });
      cast++;
    } catch {
      // Duplicate — same voter/entry/category. Fine.
    }
  }

  // Scoring ranks on votes/impressions, so votes without impressions score as
  // nothing. Seed a plausible denominator too, or the test week is unwinnable.
  await Promise.all(
    entries.map((e) =>
      competition_entry_model.updateOne({ _id: e._id }, { $inc: { impressions: 40 + Math.floor(Math.random() * 60) } })
    )
  );

  ctx.body = { cast };
});

// ─── SCORE / ANNOUNCE ────────────────────────────────────────────────────────
devCompetitionRouter.post('/:id/score', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const results = await scoreCompetition(comp._id);
  const announced = await announceCompetition(comp._id);
  // Announcing only fires the winner push and the in-app rows. The results push
  // for everyone else lives in the hourly driver, so "Announce now" would
  // otherwise silently skip the notification most participants actually get.
  await runCompetitionNotifications();

  ctx.body = { results, competition: announced };
});

/**
 * POST /dev/competition/:id/force-win  { category_id?, user_id? }
 *
 * Stuffs enough votes into your own entry to win, then scores. The only sane
 * way to test the "you won" push, badge, title grant and personal modal.
 */
devCompetitionRouter.post('/:id/force-win', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const { category_id, user_id } = (ctx.request.body ?? {}) as Record<string, string>;
  const targetUser = user_id ?? ctx.state.user._id.toString();
  const category = category_id ?? comp.categories[0]?.id;

  const entry = await competition_entry_model.findOne({ competition_id: comp._id, user_id: targetUser }).lean();
  if (!entry) return ctx.throw(404, 'That user has no entry in this competition');

  const voters = await user_model
    .find({ _id: { $ne: targetUser } })
    .select('_id')
    .limit(50)
    .lean();

  let cast = 0;
  for (const voter of voters) {
    try {
      await competition_vote_model.create({
        competition_id: comp._id,
        entry_id: entry._id,
        voter_id: voter._id,
        category_id: category,
        slot: 'entry',
        seeded: true,
      });
      cast++;
    } catch {
      // Already voted.
    }
  }

  // Enough impressions to clear MIN_IMPRESSIONS_TO_WIN — a forced win must not
  // be blocked by the fairness floor.
  await competition_entry_model.updateOne({ _id: entry._id }, { $inc: { impressions: Math.max(0, cast * 2, 30) } });

  const results = await scoreCompetition(comp._id);
  const announced = await announceCompetition(comp._id);
  await runCompetitionNotifications();

  ctx.body = { votes_added: cast, results, competition: announced };
});

// ─── SEEN RESET ──────────────────────────────────────────────────────────────
// POST /dev/competition/:id/reset-seen  { all?: boolean }
devCompetitionRouter.post('/:id/reset-seen', async (ctx) => {
  const all = !!(ctx.request.body as any)?.all;
  const filter = all ? {} : { _id: ctx.state.user._id };

  const result = await user_model.updateMany(filter, {
    $set: { 'competition.last_seen_results_week': null },
  });

  ctx.body = { modified: result.modifiedCount };
});

// ─── NOTIFICATIONS ───────────────────────────────────────────────────────────
// POST /dev/competition/:id/notify  { clear?: boolean }
// Runs the hourly notification pass immediately. `clear` wipes the at-most-once
// ledger first, so the same slot can be re-tested without waiting a week.
devCompetitionRouter.post('/:id/notify', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  if ((ctx.request.body as any)?.clear) {
    await competition_notification_model.deleteMany({ week_key: comp.week_key });
  }

  await runCompetitionNotifications();

  // The hourly pass only sends to users whose LOCAL hour matches a slot, so it
  // is usually a no-op on demand. Winner pushes have no such gate.
  if (comp.phase === 'announced') await notifyWinners(comp);

  ctx.body = { ok: true, phase: comp.phase };
});

// ─── TEARDOWN ────────────────────────────────────────────────────────────────
// DELETE /dev/competition/:id?force=1
// Refuses on a real week unless forced — deleting a live competition would take
// its entries and votes with it.
devCompetitionRouter.delete('/:id', async (ctx) => {
  const comp = await findComp(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  if (!isTestWeekKey(comp.week_key) && ctx.query.force !== '1') {
    return ctx.throw(400, `${comp.week_key} is a real week. Pass ?force=1 if you mean it.`);
  }

  // Wind back whatever this test handed out BEFORE deleting it: `results[]` is
  // the only record of what was granted, so a delete-first order would strand
  // the items on real accounts with nothing left to trace them by.
  const revoked: Record<string, string[]> = {};
  if (isTestWeekKey(comp.week_key)) {
    for (const result of comp.results) {
      const items = result.granted_items ?? [];
      if (items.length) {
        await revokeItems(result.user_id, items, `deleted test competition ${comp.week_key}`);
        revoked[result.user_id.toString()] = items;
      }
      await user_model.updateOne(
        { _id: result.user_id, 'competition.wins': { $gt: 0 } },
        { $inc: { 'competition.wins': -1 } }
      );
    }
  }

  const [entries, votes] = await Promise.all([
    competition_entry_model.deleteMany({ competition_id: comp._id }),
    competition_vote_model.deleteMany({ competition_id: comp._id }),
    competition_notification_model.deleteMany({ week_key: comp.week_key }),
  ]);
  await competition_model.deleteOne({ _id: comp._id });

  ctx.body = {
    deleted: comp.week_key,
    entries: entries.deletedCount,
    votes: votes.deletedCount,
    revoked,
  };
});

// GET /dev/competition — everything, newest first. Handy for grabbing an id.
devCompetitionRouter.get('/', async (ctx) => {
  const comps = await competition_model.find({}).sort({ starts_at: -1 }).limit(20).lean();
  ctx.body = { competitions: comps };
});

export default devCompetitionRouter;
