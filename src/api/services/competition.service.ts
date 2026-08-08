import { createHash } from 'crypto';
import { Types } from 'mongoose';
import {
  CHAMPION_TITLE_ITEM,
  CompetitionCategory,
  CYCLE,
  DEFAULT_CATEGORIES,
  FALLBACK_THEMES,
  MIN_ENTRIES_TO_ANNOUNCE,
  MIN_IMPRESSIONS_TO_WIN,
  MIN_TOTAL_IMPRESSIONS_FOR_RATE,
  phaseFor,
  startOfIsoWeekUtc,
  weekKeyFor,
  wilsonLowerBound,
} from '../../config/competition.config';
import {
  competition_entry_model,
  competition_model,
  competition_theme_model,
  competition_vote_model,
  CompetitionDocument,
  CompetitionResult,
} from '../../models/competition.model';
import { user_model } from '../../models/user.model';
import { post_model } from '../../models/post.model';
import { grantItems, missingItems } from './inventory.service';
import { notifyCompetitionResults } from './competitionNotifications.service';

/**
 * The weekly competition cycle.
 *
 * Everything here is idempotent and keyed on `week_key`, because the driver is
 * a cron that may fire twice, may miss a window entirely while the dyno is
 * down, and runs on every boot to catch up. Nothing may assume it is called
 * exactly once at exactly the right moment.
 *
 * Phase decisions come from `phaseFor()` — `now` vs the stored timestamps and
 * nothing else. That is what lets a dev compress a week into six minutes and
 * still exercise this exact code path. Do not add calendar maths below.
 */

// ─── CREATION ────────────────────────────────────────────────────────────────

interface CreateOptions {
  week_key?: string;
  starts_at?: Date;
  duration_ms?: number;
  submissions_close_ms?: number;
  theme?: string;
  theme_blurb?: string;
  accent?: string;
  categories?: CompetitionCategory[];
}

/**
 * Pick the theme for a new competition: highest-upvoted approved suggestion,
 * else the fallback pool. Marks the suggestion `used` so it can't repeat.
 *
 * The fallback exists so an unattended moderation queue can never stop a week
 * from starting — the whole feature is supposed to run without us.
 */
async function pickTheme(exclude: string[] = [], cycleCompetitionId?: Types.ObjectId) {
  const cycleFilter = cycleCompetitionId
    ? {
        $or: [
          { cycle_competition_id: cycleCompetitionId },
          // Curated and pre-cycle-migration suggestions remain eligible.
          { cycle_competition_id: { $exists: false } },
        ],
      }
    : { cycle_competition_id: { $exists: false } };
  const suggestion = await competition_theme_model
    .findOneAndUpdate(
      { status: 'approved', ...cycleFilter },
      { $set: { status: 'used' } },
      { sort: { upvotes: -1, createdAt: 1 }, new: true }
    )
    .lean();

  if (suggestion) {
    return {
      theme: suggestion.text_filtered || suggestion.text,
      theme_blurb: suggestion.blurb,
      accent: suggestion.accent,
      theme_source_id: suggestion._id,
    };
  }

  // Rotate the fallback pool rather than always taking the first one.
  const unused = FALLBACK_THEMES.filter((t) => !exclude.includes(t.text));
  const pool = unused.length ? unused : FALLBACK_THEMES;
  const seed = pool[Math.floor(Math.random() * pool.length)];

  return {
    theme: seed.text,
    theme_blurb: seed.blurb,
    accent: seed.accent,
    theme_source_id: undefined,
  };
}

export async function createCompetition(options: CreateOptions = {}): Promise<CompetitionDocument> {
  const starts_at = options.starts_at ?? startOfIsoWeekUtc();
  const duration = options.duration_ms ?? CYCLE.duration_ms;
  const closeAfter = options.submissions_close_ms ?? CYCLE.submissions_close_ms;

  const recent = await competition_model
    .find({})
    .sort({ starts_at: -1 })
    .limit(FALLBACK_THEMES.length)
    .select('_id theme starts_at')
    .lean();

  const precedingCompetition = recent.find(
    (competition) => new Date(competition.starts_at).getTime() < starts_at.getTime()
  );

  const picked = options.theme
    ? { theme: options.theme, theme_blurb: options.theme_blurb, accent: options.accent, theme_source_id: undefined }
    : await pickTheme(
        recent.map((c) => c.theme),
        precedingCompetition?._id
      );

  const doc = {
    week_key: options.week_key ?? weekKeyFor(starts_at),
    theme: picked.theme,
    theme_blurb: options.theme_blurb ?? picked.theme_blurb,
    theme_source_id: picked.theme_source_id,
    accent: options.accent ?? picked.accent ?? 'sunset',
    starts_at,
    submissions_close_at: new Date(starts_at.getTime() + closeAfter),
    ends_at: new Date(starts_at.getTime() + duration),
    categories: options.categories ?? DEFAULT_CATEGORIES,
    phase: 'scheduled' as const,
  };

  try {
    const created = await competition_model.create(doc);
    if (picked.theme_source_id) {
      await competition_theme_model.updateOne({ _id: picked.theme_source_id }, { $set: { used_in: created._id } });
    }
    console.log(`[competition] created ${created.week_key}: "${created.theme}"`);
    return created;
  } catch (error: any) {
    // Duplicate week_key — another tick beat us to it. That is the happy path
    // for an idempotent creator, not an error.
    if (error?.code === 11000) {
      const existing = await competition_model.findOne({ week_key: doc.week_key });
      if (existing) return existing;
    }
    throw error;
  }
}

/** Guarantee a competition exists for the current real week. */
export async function ensureCurrentCompetition(now: Date = new Date()): Promise<CompetitionDocument> {
  const key = weekKeyFor(now);
  const existing = await competition_model.findOne({ week_key: key });
  if (existing) return existing;
  return createCompetition({ week_key: key, starts_at: startOfIsoWeekUtc(now) });
}

/**
 * The competition to show right now: the one whose window contains `now`,
 * else the most recently announced one (so the results stay reachable until
 * the next week opens).
 */
export async function getActiveCompetition(now: Date = new Date()): Promise<CompetitionDocument | null> {
  const live = await competition_model
    .findOne({ starts_at: { $lte: now }, ends_at: { $gt: now } })
    .sort({ starts_at: -1 });
  if (live) return live;

  return competition_model.findOne({ phase: 'announced' }).sort({ announced_at: -1 });
}

// ─── PHASE ADVANCE ───────────────────────────────────────────────────────────

/**
 * Recompute every unfinished competition's phase from the clock, score and
 * announce anything that has ended, and make sure the current week exists.
 *
 * Safe to call on every cron tick and on boot. A server that was down all
 * weekend catches up here.
 */
export async function advancePhases(now: Date = new Date()): Promise<void> {
  const pending = await competition_model.find({
    phase: { $in: ['scheduled', 'open', 'voting', 'closed'] },
  });

  for (const comp of pending) {
    try {
      const target = phaseFor(comp, now);

      if (target !== comp.phase) {
        comp.phase = target;
        await comp.save();
        console.log(`[competition] ${comp.week_key} → ${target}`);
      }

      if (target === 'closed') {
        await scoreCompetition(comp._id);
        await announceCompetition(comp._id);
      }
    } catch (error) {
      // One bad competition must not stop the others (or the week rollover).
      console.error(`[competition] advance failed for ${comp.week_key}:`, error);
    }
  }

  await ensureCurrentCompetition(now);
}

// ─── SCORING ─────────────────────────────────────────────────────────────────

/**
 * Recount votes from `competition_votes` and write `results[]`.
 *
 * Always recounts — the `vote_counts` on an entry are a display convenience and
 * may have drifted if a counter `$inc` failed after the vote insert succeeded.
 *
 * Ranking is the Wilson lower bound on `votes / impressions`, NOT raw votes:
 * raw counts measure exposure × quality and would hand every win to whoever
 * submitted on Monday. See §2.7 in docs/COMPETITION.md.
 *
 * Excludes anything not `active`, so a quarantined or removed entry can never
 * win. Exact ties use a deterministic week/category lottery; submission time
 * is deliberately absent so entering on Monday never beats entering Friday.
 */
export async function scoreCompetition(competitionId: Types.ObjectId): Promise<CompetitionResult[]> {
  const comp = await competition_model.findById(competitionId);
  if (!comp) throw new Error(`Competition ${competitionId} not found`);

  const entries = await competition_entry_model
    .find({ competition_id: comp._id, status: 'active' })
    .select('_id user_id submitted_at impressions')
    .lean();

  comp.entry_count = entries.length;

  if (entries.length < MIN_ENTRIES_TO_ANNOUNCE) {
    comp.results = [];
    comp.skipped_reason = `Only ${entries.length} entries`;
    await comp.save();
    return [];
  }

  const eligible = new Map(entries.map((e) => [e._id.toString(), e]));

  const tallies = await competition_vote_model.aggregate<{
    _id: { entry_id: Types.ObjectId; category_id: string };
    votes: number;
  }>([
    { $match: { competition_id: comp._id } },
    {
      $group: {
        _id: { entry_id: '$entry_id', category_id: '$category_id' },
        votes: { $sum: 1 },
      },
    },
  ]);

  const byCategory = new Map<string, { entry_id: Types.ObjectId; votes: number }[]>();
  for (const row of tallies) {
    const key = row._id.entry_id.toString();
    if (!eligible.has(key)) continue; // removed / quarantined
    const list = byCategory.get(row._id.category_id) ?? [];
    list.push({ entry_id: row._id.entry_id, votes: row.votes });
    byCategory.set(row._id.category_id, list);
  }

  // Raw votes are exposure × quality. If exposure telemetry is broken, there
  // is no fair result to compute: falling back to counts would reward the
  // oldest entries. Close the week without a winner and alert through logs.
  const totalImpressions = entries.reduce((sum, e) => sum + (e.impressions ?? 0), 0);
  if (totalImpressions < MIN_TOTAL_IMPRESSIONS_FOR_RATE) {
    comp.results = [];
    comp.skipped_reason = `Insufficient verified exposure (${totalImpressions} impressions)`;
    await comp.save();
    console.error(
      `[competition] ${comp.week_key}: only ${totalImpressions} impressions — refusing unfair raw-vote scoring`
    );
    return [];
  }

  const results: CompetitionResult[] = [];
  for (const category of comp.categories) {
    const candidates = byCategory.get(category.id) ?? [];
    if (!candidates.length) continue;

    const scored = candidates
      .map((c) => {
        const entry = eligible.get(c.entry_id.toString())!;
        const impressions = entry.impressions ?? 0;
        return {
          ...c,
          entry,
          impressions,
          score: wilsonLowerBound(c.votes, impressions),
        };
      })
      .filter((c) => c.impressions >= MIN_IMPRESSIONS_TO_WIN);

    // Nobody in this category received enough verified exposure. Do not turn
    // that instrumentation failure into an early-entry advantage.
    if (!scored.length) continue;

    const tieKey = (entryId: Types.ObjectId) =>
      createHash('sha256').update(`${comp.week_key}:${category.id}:${entryId.toString()}`).digest('hex');

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return tieKey(a.entry_id).localeCompare(tieKey(b.entry_id));
    });

    const winner = scored[0];

    results.push({
      category_id: category.id,
      entry_id: winner.entry_id,
      user_id: winner.entry.user_id,
      votes: winner.votes,
      granted_items: [],
    });
  }

  comp.results = results;
  comp.skipped_reason = undefined;
  await comp.save();

  // Refresh the denormalised counters while we have the real numbers.
  await Promise.all(
    [...byCategory.entries()].flatMap(([categoryId, rows]) =>
      rows.map((row) =>
        competition_entry_model.updateOne({ _id: row.entry_id }, { $set: { [`vote_counts.${categoryId}`]: row.votes } })
      )
    )
  );
  await recomputeTotals(comp._id);

  return results;
}

async function recomputeTotals(competitionId: Types.ObjectId): Promise<void> {
  const totals = await competition_vote_model.aggregate<{ _id: Types.ObjectId; votes: number }>([
    { $match: { competition_id: competitionId } },
    { $group: { _id: '$entry_id', votes: { $sum: 1 } } },
  ]);

  await Promise.all(
    totals.map((t) => competition_entry_model.updateOne({ _id: t._id }, { $set: { total_votes: t.votes } }))
  );
}

// ─── ANNOUNCE ────────────────────────────────────────────────────────────────

/**
 * Grant rewards, mark winners, flip to `announced`.
 *
 * Idempotent: a competition already in `announced` returns immediately, and the
 * per-winner grant is `$addToSet`, so a partial run followed by a retry cannot
 * double-grant.
 *
 * Rewards come from the snapshot on the competition document, never from the
 * live catalog — changing the catalog later must not rewrite history.
 */
export async function announceCompetition(competitionId: Types.ObjectId): Promise<CompetitionDocument | null> {
  const comp = await competition_model.findById(competitionId);
  if (!comp) return null;
  if (comp.phase === 'announced') return comp;

  // Nothing to crown — close the week quietly rather than show a 1-person
  // podium. The theme is not reused; next week picks a fresh one.
  if (!comp.results.length) {
    comp.phase = 'announced';
    comp.announced_at = new Date();
    await comp.save();
    console.log(`[competition] ${comp.week_key} announced with no winners (${comp.skipped_reason ?? 'no votes'})`);
    return comp;
  }

  const rewardByCategory = new Map(comp.categories.map((c) => [c.id, c.reward_items]));

  for (const result of comp.results) {
    try {
      // Re-check status at the last possible moment: an entry quarantined
      // between scoring and here must not be granted or announced.
      const entry = await competition_entry_model.findById(result.entry_id).lean();
      if (!entry || entry.status !== 'active') {
        console.warn(`[competition] winner ${result.entry_id} no longer active — rescoring`);
        await scoreCompetition(comp._id);
        return announceCompetition(comp._id);
      }

      const items = rewardByCategory.get(result.category_id) ?? [];

      // The champion title is earned once, ever. Later wins only bump `wins`.
      const titleGrant = await missingItems(result.user_id, [CHAMPION_TITLE_ITEM]);
      const toGrant = [...items, ...titleGrant];
      // Record the intended grant before the external write. If granting fails,
      // the admin audit shows it as missing and Re-grant has the exact payload
      // needed to repair it instead of an empty array.
      result.granted_items = toGrant;

      if (toGrant.length) {
        await grantItems(result.user_id, toGrant, `competition ${comp.week_key} / ${result.category_id}`);
      }

      const categoryLabel = comp.categories.find((c) => c.id === result.category_id)?.label ?? 'Winner';

      await Promise.all([
        competition_entry_model.updateOne(
          { _id: result.entry_id },
          { $set: { is_winner: true, won_category: result.category_id } }
        ),
        user_model.updateOne({ _id: result.user_id }, { $inc: { 'competition.wins': 1 } }),
        // If the artist also shared this drawing to the feed, the badge follows
        // it there. Denormalised onto the post so a feed card costs no join.
        entry.post_id
          ? post_model.updateOne(
              { _id: entry.post_id },
              {
                $set: {
                  competition_win: {
                    week_key: comp.week_key,
                    category_label: categoryLabel,
                    theme: comp.theme,
                  },
                },
              }
            )
          : Promise.resolve(),
      ]);
    } catch (error) {
      // A failed grant must not block the announcement — the admin page has a
      // re-grant button, and `granted_items` records what actually landed.
      console.error(`[competition] grant failed for ${result.category_id}:`, error);
    }
  }

  comp.markModified('results');
  comp.phase = 'announced';
  comp.announced_at = new Date();
  await comp.save();

  // After the save: the winners must already be `announced` when the push lands,
  // or tapping it opens a results screen that 409s.
  await notifyCompetitionResults(comp);

  console.log(
    `[competition] ${comp.week_key} announced: ` + comp.results.map((r) => `${r.category_id}=${r.user_id}`).join(', ')
  );

  return comp;
}
