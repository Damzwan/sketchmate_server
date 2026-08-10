import Router from 'koa-router';
import { Types } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../../middleware/auth';
import { requireCapability } from '../../middleware/moderation.middleware';
import { Capability } from '../../types/moderation.policy';
import { requireAdultAccount } from '../services/parental.service';
import { s3Creator } from '../../mongodb';
import { CONTAINER } from '../../s3';
import {
  competition_comment_model,
  competition_entry_model,
  competition_model,
  competition_theme_model,
  competition_theme_vote_model,
  competition_vote_model,
  CompetitionDocument,
  CompetitionEntryDocument,
} from '../../models/competition.model';
import { post_model } from '../../models/post.model';
import { user_model } from '../../models/user.model';
import { quota_usage_model } from '../../models/quota_usage.model';
import { startOfUtcDay } from '../../config/quota.config';
import { getPostQuota } from '../services/quota.service';
import {
  canSubmit,
  canVote,
  competitionLaunchAt,
  ENTRIES_PAGE_SIZE,
  EXPOSURE_BUCKET,
  isCompetitionEnabled,
  MAX_CAPTION_LENGTH,
  MAX_THEME_LENGTH,
  phaseFor,
  resolveAccent,
  VOTE_MIN_ACCOUNT_AGE_MS,
} from '../../config/competition.config';
import { getActiveCompetition } from '../services/competition.service';
import { censorText } from '../services/profanity.service';
import { dispatchNotification } from '../services/notification.service';
import { COMPLETE_PUBLIC_USER_FIELDS, PUBLIC_USER_FIELDS } from '../../types/projections';
import { mixpanelEvents, trackEvent } from '../../mixpanel';

export const competitionRouter = new Router();

// The competition is a public stranger surface, same as the feed: off under 13
// with no parental override. Gated here as well as in the client so a replayed
// request can't enter a child's drawing into a public contest.
const COMPETITION_AGE_MESSAGE = 'The weekly competition is available from age 13.';

// ─── SHAPING ─────────────────────────────────────────────────────────────────

const shapeCompetition = (comp: CompetitionDocument, now = new Date()) => ({
  _id: comp._id.toString(),
  week_key: comp.week_key,
  theme: comp.theme,
  theme_blurb: comp.theme_blurb ?? '',
  accent: comp.accent,
  accent_colors: resolveAccent(comp.accent),
  // Derived, not read from the document: the cron may be up to an hour behind
  // and the client must never show a stale "submissions open".
  phase: comp.phase === 'announced' ? 'announced' : phaseFor(comp, now),
  starts_at: comp.starts_at.toISOString(),
  submissions_close_at: comp.submissions_close_at.toISOString(),
  ends_at: comp.ends_at.toISOString(),
  categories: comp.categories.map((c) => ({
    id: c.id,
    label: c.label,
    emoji: c.emoji,
    votes_per_user: c.votes_per_user,
    reward_items: c.reward_items,
  })),
  entry_count: comp.entry_count,
  announced_at: comp.announced_at?.toISOString(),
});

type LeanEntry = Omit<CompetitionEntryDocument, 'vote_counts'> & {
  vote_counts?: Record<string, number> | Map<string, number>;
};

const shapeEntry = (
  entry: LeanEntry,
  author: { _id: string; name: string; img: string; customization?: unknown } | null,
  myVotes: string[],
  revealCounts: boolean
) => ({
  _id: entry._id.toString(),
  competition_id: entry.competition_id.toString(),
  author_id: entry.user_id.toString(),
  author,
  image_url: entry.image_url,
  thumbnail_url: entry.thumbnail_url,
  drawing_url: entry.drawing_url,
  aspect_ratio: entry.aspect_ratio,
  caption: entry.caption ?? '',
  caption_filtered: entry.caption_filtered ?? '',
  post_id: entry.post_id?.toString(),
  is_winner: !!entry.is_winner,
  won_category: entry.won_category,
  // Tallies stay hidden until reveal — this is what kills bandwagon voting.
  // Your OWN votes are always visible; other people's totals are not.
  vote_counts: revealCounts
    ? entry.vote_counts instanceof Map
      ? Object.fromEntries(entry.vote_counts)
      : entry.vote_counts ?? {}
    : undefined,
  total_votes: revealCounts ? entry.total_votes ?? 0 : undefined,
  my_votes: myVotes,
  submitted_at: new Date(entry.submitted_at).toISOString(),
  comment_count: entry.comment_count ?? 0,
});

/**
 * Deterministic per-viewer shuffle. Everyone sees a different order (no
 * first-mover advantage in a vote-driven grid) but each viewer's order is
 * stable across pagination and app restarts — which `$sample` is not, and why
 * it isn't used here.
 */
function shuffleKey(entryId: string, viewerId: string, weekKey: string): number {
  const s = `${entryId}:${viewerId}:${weekKey}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The first version allowed one vote per category on the same drawing. The UI
 * now treats a drawing as one decision, so lazily collapse legacy receipts to
 * the newest category when that voter next opens the competition. Keeping the
 * cleanup here also repairs the denormalised counters used by result previews.
 */
async function normalizeVotesForVoter(competitionId: Types.ObjectId, voterId: Types.ObjectId) {
  const votes = await competition_vote_model
    .find({ competition_id: competitionId, voter_id: voterId })
    .sort({ createdAt: -1 })
    .lean();
  const kept = new Map<string, (typeof votes)[number]>();
  const duplicates: (typeof votes)[number][] = [];
  for (const vote of votes) {
    const key = vote.entry_id.toString();
    if (kept.has(key)) duplicates.push(vote);
    else kept.set(key, vote);
  }
  if (duplicates.length) {
    await Promise.all(
      duplicates.map(async (vote) => {
        const removed = await competition_vote_model.deleteOne({ _id: vote._id });
        if (removed.deletedCount) {
          await competition_entry_model.updateOne(
            { _id: vote.entry_id },
            { $inc: { [`vote_counts.${vote.category_id}`]: -1, total_votes: -1 } }
          );
        }
      })
    );
  }
  if (kept.size) {
    await competition_vote_model.updateMany(
      { _id: { $in: Array.from(kept.values()).map((vote) => vote._id) } },
      { $set: { slot: 'entry' } }
    );
  }
  return Array.from(kept.values());
}

async function voteBudget(comp: CompetitionDocument, voterId: Types.ObjectId) {
  const used = await competition_vote_model.aggregate<{ _id: string; count: number }>([
    { $match: { competition_id: comp._id, voter_id: voterId } },
    { $group: { _id: '$category_id', count: { $sum: 1 } } },
  ]);
  const byCategory = new Map(used.map((row) => [row._id, row.count]));
  return Object.fromEntries(
    comp.categories.map((category) => [
      category.id,
      Math.max(0, category.votes_per_user - (byCategory.get(category.id) ?? 0)),
    ])
  );
}

/**
 * `full` widens the projection to COMPLETE_PUBLIC_USER_FIELDS — the winners
 * moment renders the real ProfileCard, which needs the background sketch too.
 * The grid does not, and paying for it on every card would be wasteful.
 */
async function hydrateAuthors(userIds: Types.ObjectId[], full = false) {
  const unique = Array.from(new Set(userIds.map((id) => id.toString())));
  const users = await user_model
    .find({ _id: { $in: unique } })
    .select(full ? COMPLETE_PUBLIC_USER_FIELDS : PUBLIC_USER_FIELDS)
    .lean();

  return new Map(
    users.map((u: any) => [
      u._id.toString(),
      {
        _id: u._id.toString(),
        name: u.name,
        img: u.img,
        description: u.description,
        customization: u.customization,
        stats: u.stats,
        competition_wins: u.competition?.wins ?? 0,
      },
    ])
  );
}

// ─── CURRENT ─────────────────────────────────────────────────────────────────

/**
 * The home card polls this. Keep it to two queries: the competition plus the
 * viewer's own state (entry + vote budget).
 */
competitionRouter.get('/current', requireAuth, async (ctx) => {
  if (!isCompetitionEnabled()) {
    ctx.body = { competition: null };
    return;
  }

  const comp = await getActiveCompetition();
  if (!comp) {
    ctx.body = { competition: null };
    return;
  }

  const userId = new Types.ObjectId(ctx.state.user._id);

  const [myEntry, myVotes] = await Promise.all([
    competition_entry_model
      .findOne({ competition_id: comp._id, user_id: userId })
      .select(
        '_id drawing_url image_url thumbnail_url aspect_ratio caption caption_filtered status is_winner won_category vote_counts total_votes comment_count submitted_at'
      )
      .lean(),
    normalizeVotesForVoter(comp._id, userId),
  ]);

  const used: Record<string, number> = {};
  for (const v of myVotes) used[v.category_id] = (used[v.category_id] ?? 0) + 1;

  const votes_left: Record<string, number> = {};
  for (const c of comp.categories) {
    votes_left[c.id] = Math.max(0, c.votes_per_user - (used[c.id] ?? 0));
  }

  ctx.body = {
    competition: shapeCompetition(comp),
    my_entry: myEntry
      ? {
          _id: myEntry._id.toString(),
          competition_id: comp._id.toString(),
          author_id: userId.toString(),
          drawing_url: myEntry.drawing_url,
          image_url: myEntry.image_url,
          thumbnail_url: myEntry.thumbnail_url,
          aspect_ratio: myEntry.aspect_ratio,
          caption: myEntry.caption ?? '',
          caption_filtered: myEntry.caption_filtered ?? '',
          comment_count: myEntry.comment_count ?? 0,
          my_votes: [],
          submitted_at: myEntry.submitted_at.toISOString(),
          status: myEntry.status,
          is_winner: !!myEntry.is_winner,
          won_category: myEntry.won_category,
          vote_counts:
            comp.phase === 'announced'
              ? myEntry.vote_counts instanceof Map
                ? Object.fromEntries(myEntry.vote_counts)
                : myEntry.vote_counts ?? {}
              : undefined,
          total_votes: comp.phase === 'announced' ? myEntry.total_votes ?? 0 : undefined,
        }
      : null,
    votes_left,
    can_vote: canVote(comp),
    can_submit: canSubmit(comp),
  };
});

// ─── UPLOAD ──────────────────────────────────────────────────────────────────

competitionRouter.post(
  '/upload-urls',
  requireAuth,
  requireCapability(Capability.CREATE_POST),
  requireAdultAccount(COMPETITION_AGE_MESSAGE),
  async (ctx) => {
    const userId = ctx.state.user._id.toString();
    const uniqueId = uuidv4();

    const [drawing, image, thumbnail] = await Promise.all([
      s3Creator.getPresignedUploadUrl('application/gzip', CONTAINER.drawings, `competition/${userId}/${uniqueId}.gz`),
      s3Creator.getPresignedUploadUrl('image/webp', CONTAINER.drawings, `competition/${userId}/${uniqueId}.webp`),
      s3Creator.getPresignedUploadUrl('image/webp', CONTAINER.drawings, `competition/${userId}/${uniqueId}-thumb.webp`),
    ]);

    ctx.body = { drawing, image, thumbnail };
  }
);

// ─── ENTER ───────────────────────────────────────────────────────────────────

/**
 * Create or replace this user's entry.
 *
 * `share_to_feed` additionally publishes a normal post (consuming post quota).
 * If the quota is gone the entry still lands and the response says the post was
 * skipped — losing a competition entry over a post quota would be absurd.
 */
competitionRouter.post(
  '/:id/enter',
  requireAuth,
  requireCapability(Capability.CREATE_POST),
  requireAdultAccount(COMPETITION_AGE_MESSAGE),
  async (ctx) => {
    const comp = await competition_model.findById(ctx.params.id);
    if (!comp) return ctx.throw(404, 'Competition not found');
    if (!canSubmit(comp)) return ctx.throw(409, 'Submissions are closed');

    const { drawing_url, image_url, thumbnail_url, aspect_ratio, caption, share_to_feed } = ctx.request.body as Record<
      string,
      any
    >;

    if (!drawing_url || !image_url || !thumbnail_url) {
      return ctx.throw(400, 'drawing_url, image_url and thumbnail_url are required');
    }

    const userId = new Types.ObjectId(ctx.state.user._id);
    const trimmed = (caption ?? '').toString().slice(0, MAX_CAPTION_LENGTH);

    const existing = await competition_entry_model
      .findOne({ competition_id: comp._id, user_id: userId })
      .select('_id')
      .lean();

    const entry = await competition_entry_model.findOneAndUpdate(
      { competition_id: comp._id, user_id: userId },
      {
        $set: {
          drawing_url,
          image_url,
          thumbnail_url,
          aspect_ratio: Number(aspect_ratio) || 1,
          caption: trimmed,
          caption_filtered: censorText(trimmed),
          status: 'active',
          submitted_at: new Date(),
          vote_counts: {},
          total_votes: 0,
          impressions: 0,
          comment_count: 0,
          is_winner: false,
          reports_count: 0,
          moderation: {},
        },
        // A replacement is a new competition drawing even though it keeps the
        // unique (competition,user) record. Do not keep links or winner state
        // that describe the previous artwork.
        $unset: { post_id: 1, won_category: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (!existing) {
      await competition_model.updateOne({ _id: comp._id }, { $inc: { entry_count: 1 } });
    } else {
      // Votes and comments belong to the artwork, not the stable entry id. If
      // they survived a redraw, a brand-new image could inherit a winning
      // score and conversations about a picture that no longer exists.
      await Promise.all([
        competition_vote_model.deleteMany({ entry_id: entry._id }),
        competition_comment_model.deleteMany({ entry_id: entry._id }),
      ]);
    }

    // ── Optional cross-post to the public feed ────────────────────────────
    let post_id: string | undefined;
    let post_skipped: string | undefined;

    if (share_to_feed) {
      try {
        const quota = await getPostQuota(ctx.state.user._id.toString());
        if (quota.remaining <= 0) {
          post_skipped = 'quota';
        } else {
          const post = await post_model.create({
            author_id: userId,
            drawing_url,
            image_url,
            thumbnail_url,
            aspect_ratio: Number(aspect_ratio) || 1,
            description: trimmed,
            enable_comments: true,
            enable_remix: true,
          });
          post_id = post._id.toString();

          await Promise.all([
            competition_entry_model.updateOne({ _id: entry._id }, { $set: { post_id: post._id } }),
            user_model.updateOne({ _id: userId }, { $inc: { 'stats.posts': 1 } }),
            quota_usage_model.updateOne(
              { user_id: userId, date: startOfUtcDay() },
              { $inc: { posts_created: 1 } },
              { upsert: true }
            ),
          ]);
        }
      } catch (error) {
        // The entry is the thing the user asked for. A failed cross-post is
        // reported, not fatal.
        console.error('[competition] cross-post failed:', error);
        post_skipped = 'error';
      }
    }

    trackEvent(ctx.state.user._id.toString(), mixpanelEvents.competition_entry_submit, {
      week_key: comp.week_key,
      replaced: !!existing,
      shared_to_feed: !!post_id,
    });

    ctx.status = existing ? 200 : 201;
    ctx.body = {
      entry: shapeEntry(entry.toObject() as any, null, [], false),
      replaced: !!existing,
      post_id,
      post_skipped,
    };
  }
);

competitionRouter.delete('/:id/entry', requireAuth, async (ctx) => {
  const comp = await competition_model.findById(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const userId = new Types.ObjectId(ctx.state.user._id);
  const entry = await competition_entry_model.findOneAndDelete({
    competition_id: comp._id,
    user_id: userId,
  });

  if (entry) {
    await Promise.all([
      competition_model.updateOne({ _id: comp._id }, { $inc: { entry_count: -1 } }),
      // Withdrawing pulls the artwork out of the contest; votes cast on it have
      // nowhere left to point and go with it. Voters get their budget back —
      // they should not be penalised for someone else's withdrawal.
      competition_vote_model.deleteMany({ entry_id: entry._id }),
      competition_comment_model.deleteMany({ entry_id: entry._id }),
    ]);
  }

  ctx.body = { success: true, deleted: !!entry };
});

// ─── ENTRIES ─────────────────────────────────────────────────────────────────

competitionRouter.get('/:id/entries', requireAuth, async (ctx) => {
  const comp = await competition_model.findById(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const viewerId = ctx.state.user._id.toString();
  const limit = Math.min(parseInt(ctx.query.limit as string) || ENTRIES_PAGE_SIZE, 60);
  const cursor = parseInt(ctx.query.cursor as string) || 0;

  const entries = await competition_entry_model
    .find({ competition_id: comp._id, status: 'active' })
    // The grid never needs moderation state, timestamps or report metadata.
    // Project only the card/scoring fields before the in-memory fair shuffle.
    .select(
      '_id competition_id user_id drawing_url image_url thumbnail_url aspect_ratio caption caption_filtered post_id vote_counts total_votes impressions comment_count is_winner won_category submitted_at'
    )
    .lean();

  // Exposure-balanced shuffle (§2.7). Bucket first, so under-seen entries go to
  // the front of everyone's grid and a Friday submission catches up on
  // impressions instead of losing the week to Monday's. Hash within the bucket,
  // so no two viewers get the same order and there is no single top slot.
  //
  // Sorting in memory is fine at this scale (one week's entries) and is what
  // makes the per-viewer shuffle possible at all — it isn't expressible as a
  // Mongo sort. Revisit with a stored per-viewer seed if a week ever breaks 5k.
  const bucket = (e: { impressions?: number }) => Math.floor((e.impressions ?? 0) / EXPOSURE_BUCKET);

  entries.sort((a, b) => {
    const delta = bucket(a) - bucket(b);
    if (delta !== 0) return delta;
    return (
      shuffleKey(a._id.toString(), viewerId, comp.week_key) - shuffleKey(b._id.toString(), viewerId, comp.week_key)
    );
  });

  const page = entries.slice(cursor, cursor + limit);

  const [authors, myVotes] = await Promise.all([
    hydrateAuthors(page.map((e) => e.user_id)),
    competition_vote_model
      .find({ competition_id: comp._id, voter_id: new Types.ObjectId(viewerId) })
      .select('entry_id category_id')
      .lean(),
  ]);

  const votesByEntry = new Map<string, string[]>();
  for (const v of myVotes) {
    const key = v.entry_id.toString();
    votesByEntry.set(key, [...(votesByEntry.get(key) ?? []), v.category_id]);
  }

  const reveal = comp.phase === 'announced';

  ctx.body = {
    entries: page.map((e) =>
      shapeEntry(e as any, authors.get(e.user_id.toString()) ?? null, votesByEntry.get(e._id.toString()) ?? [], reveal)
    ),
    next_cursor: cursor + page.length < entries.length ? cursor + page.length : null,
    total: entries.length,
  };
});

/**
 * BATCHED IMPRESSION TRACKING
 *
 * Entry ids that were on screen for more than 1.5s, same contract as
 * `POST /post/views`. This is not analytics: `votes / impressions` is what the
 * winner is decided on, and the ordering uses the counter to balance exposure.
 * If this stops being called, scoring degrades to raw vote counts.
 */
competitionRouter.post('/:id/impressions', requireAuth, async (ctx) => {
  const { entry_ids } = ctx.request.body as { entry_ids?: string[] };
  if (!Array.isArray(entry_ids) || entry_ids.length === 0) {
    return ctx.throw(400, 'Invalid entry_ids array');
  }

  const oids = entry_ids
    .slice(0, 60)
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));

  if (!oids.length) return ctx.throw(400, 'Invalid entry_ids array');

  // An author scrolling past their own entry must not inflate its denominator —
  // that would penalise them, since their own view can never become a vote.
  await competition_entry_model.updateMany(
    {
      _id: { $in: oids },
      competition_id: new Types.ObjectId(ctx.params.id),
      status: 'active',
      user_id: { $ne: new Types.ObjectId(ctx.state.user._id) },
    },
    { $inc: { impressions: 1 } }
  );

  ctx.status = 200;
  ctx.body = { success: true };
});

// ─── COMMENTS ────────────────────────────────────────────────────────────────

const shapeComment = (comment: any, author: any) => ({
  ...comment,
  _id: comment._id.toString(),
  entry_id: comment.entry_id.toString(),
  author_id: comment.author_id.toString(),
  createdAt: comment.createdAt instanceof Date ? comment.createdAt.toISOString() : comment.createdAt,
  author: author ?? {
    _id: comment.author_id.toString(),
    name: 'Unknown',
    img: '',
  },
});

/**
 * One entry, standalone.
 *
 * Exists for deep links that arrive without the grid — tapping "someone
 * commented on your entry" in the bell has to be able to open that drawing even
 * when the competition page has never been visited this session.
 */
competitionRouter.get('/entry/:entry_id', requireAuth, async (ctx) => {
  const { entry_id } = ctx.params;
  if (!Types.ObjectId.isValid(entry_id)) return ctx.throw(400, 'Valid entry_id required');

  const entry = await competition_entry_model
    .findOne({ _id: new Types.ObjectId(entry_id), status: 'active' })
    .select(
      '_id competition_id user_id drawing_url image_url thumbnail_url aspect_ratio caption caption_filtered post_id vote_counts total_votes comment_count is_winner won_category submitted_at'
    )
    .lean();
  if (!entry) return ctx.throw(404, 'Entry not available');

  const viewerId = new Types.ObjectId(ctx.state.user._id);
  const [comp, authors, myVotes] = await Promise.all([
    competition_model.findById(entry.competition_id).select('phase').lean(),
    hydrateAuthors([entry.user_id]),
    competition_vote_model
      .find({ entry_id: entry._id, voter_id: viewerId })
      .select('category_id')
      .lean(),
  ]);

  ctx.body = {
    entry: shapeEntry(
      entry as any,
      authors.get(entry.user_id.toString()) ?? null,
      myVotes.map((vote) => vote.category_id),
      comp?.phase === 'announced'
    ),
  };
});

competitionRouter.get('/entry/:entry_id/comments', requireAuth, async (ctx) => {
  const { entry_id } = ctx.params;
  if (!Types.ObjectId.isValid(entry_id)) return ctx.throw(400, 'Valid entry_id required');

  const limit = Math.min(parseInt(ctx.query.limit as string) || 20, 50);
  const beforeDate = ctx.query.beforeDate ? new Date(ctx.query.beforeDate as string) : undefined;

  const query: Record<string, any> = {
    entry_id: new Types.ObjectId(entry_id),
    status: 'active',
  };
  if (beforeDate && !Number.isNaN(beforeDate.getTime())) {
    query.createdAt = { $lte: beforeDate };
  }

  const comments = await competition_comment_model
    .find(query)
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = comments.length > limit;
  const page = comments.slice(0, limit).reverse();
  const authors = page.length ? await hydrateAuthors(page.map((comment) => comment.author_id)) : new Map();

  ctx.body = {
    comments: page.map((comment) => shapeComment(comment, authors.get(comment.author_id.toString()))),
    hasMore,
  };
});

competitionRouter.post(
  '/entry/:entry_id/comment',
  requireAuth,
  requireCapability(Capability.COMMENT_ON_POST),
  requireAdultAccount(COMPETITION_AGE_MESSAGE),
  async (ctx) => {
    const { entry_id } = ctx.params;
    if (!Types.ObjectId.isValid(entry_id)) return ctx.throw(400, 'Valid entry_id required');

    const message = String((ctx.request.body as any)?.message ?? '').trim();
    if (!message) return ctx.throw(400, 'Comment message cannot be empty');

    const entry = await competition_entry_model
      .findOne({ _id: new Types.ObjectId(entry_id), status: 'active' })
      .select('_id competition_id user_id thumbnail_url')
      .lean();
    if (!entry) return ctx.throw(404, 'Entry not available');

    const cleanMessage = message.slice(0, 500);
    const comment = await competition_comment_model.create({
      entry_id: entry._id,
      author_id: new Types.ObjectId(ctx.state.user._id),
      message: cleanMessage,
      message_filtered: censorText(cleanMessage),
    });

    await competition_entry_model.updateOne({ _id: entry._id }, { $inc: { comment_count: 1 } });

    // Same contract as a comment on a feed post: the artist hears about it in
    // the bell, merged per entry so a busy thread is one row rather than ten.
    // No push — a competition entry is already noisier than a post, and §8 caps
    // this feature at three interruptions a week.
    if (entry.user_id.toString() !== ctx.state.user._id.toString()) {
      dispatchNotification({
        recipient_id: entry.user_id.toString(),
        type: 'competition',
        aggregation_mode: 'merge_count',
        aggregation_key: `competition_comment:${entry._id.toString()}`,
        actor: {
          _id: ctx.state.user._id.toString(),
          name: ctx.state.user.name,
          img: ctx.state.user.img,
        },
        target_type: 'system',
        target_preview: {
          thumbnail: entry.thumbnail_url,
          text: cleanMessage.slice(0, 100),
        },
        payload: {
          kind: 'entry_comment',
          competition_id: entry.competition_id.toString(),
          entry_id: entry._id.toString(),
        },
        channels: { in_app: true, socket: true },
      }).catch((error) => console.error('[competition] comment notify failed:', error));
    }

    ctx.status = 201;
    ctx.body = {
      comment: shapeComment(comment.toObject(), {
        _id: ctx.state.user._id.toString(),
        name: ctx.state.user.name,
        img: ctx.state.user.img,
        customization: ctx.state.user.customization,
      }),
    };
  }
);

competitionRouter.delete('/entry/:entry_id/comment/:comment_id', requireAuth, async (ctx) => {
  const { entry_id, comment_id } = ctx.params;
  if (!Types.ObjectId.isValid(entry_id) || !Types.ObjectId.isValid(comment_id)) {
    return ctx.throw(400, 'Valid entry and comment ids required');
  }

  const [entry, comment] = await Promise.all([
    competition_entry_model.findById(entry_id).select('user_id').lean(),
    competition_comment_model.findById(comment_id).lean(),
  ]);
  if (!entry || !comment || comment.entry_id.toString() !== entry_id) {
    return ctx.throw(404, 'Comment not found');
  }

  const userId = ctx.state.user._id.toString();
  if (comment.author_id.toString() !== userId && entry.user_id.toString() !== userId) {
    return ctx.throw(403, 'You are not authorized to delete this comment');
  }

  const deleted = await competition_comment_model.deleteOne({ _id: comment._id });
  if (deleted.deletedCount) {
    await competition_entry_model.updateOne(
      { _id: entry._id, comment_count: { $gt: 0 } },
      { $inc: { comment_count: -1 } }
    );
  }

  ctx.body = { success: true };
});

// ─── VOTING ──────────────────────────────────────────────────────────────────

competitionRouter.post(
  '/:id/vote',
  requireAuth,
  requireCapability(Capability.REACT_TO_POST),
  requireAdultAccount(COMPETITION_AGE_MESSAGE),
  async (ctx) => {
    const comp = await competition_model.findById(ctx.params.id);
    if (!comp) return ctx.throw(404, 'Competition not found');
    if (!canVote(comp)) return ctx.throw(409, 'Voting is closed');

    const { entry_id, category_id } = ctx.request.body as Record<string, string>;
    if (!entry_id || !Types.ObjectId.isValid(entry_id)) return ctx.throw(400, 'Valid entry_id required');

    const category = comp.categories.find((c) => c.id === category_id);
    if (!category) return ctx.throw(400, 'Unknown category');

    const voterId = new Types.ObjectId(ctx.state.user._id);

    // Cheapest brigade is a handful of throwaway accounts made this morning.
    const voter = await user_model.findById(voterId).select('createdAt').lean();
    const accountAge = Date.now() - new Date((voter as any)?.createdAt ?? 0).getTime();
    if (accountAge < VOTE_MIN_ACCOUNT_AGE_MS) {
      return ctx.throw(403, 'New accounts can vote after 48 hours');
    }

    const entry = await competition_entry_model
      .findOne({ _id: new Types.ObjectId(entry_id), competition_id: comp._id })
      .select('user_id status')
      .lean();
    if (!entry || entry.status !== 'active') return ctx.throw(404, 'Entry not available');
    if (entry.user_id.toString() === voterId.toString()) {
      return ctx.throw(400, 'You cannot vote for your own entry');
    }

    const existingVotes = await competition_vote_model
      .find({ competition_id: comp._id, voter_id: voterId, entry_id: new Types.ObjectId(entry_id) })
      .sort({ createdAt: -1 })
      .lean();
    const alreadySelected = existingVotes.find((vote) => vote.category_id === category_id);
    const voterHadAnyVote = await competition_vote_model.exists({
      competition_id: comp._id,
      voter_id: voterId,
    });

    const used = await competition_vote_model.countDocuments({
      competition_id: comp._id,
      voter_id: voterId,
      category_id,
    });
    if (!alreadySelected && used >= category.votes_per_user) {
      return ctx.throw(409, `No votes left in ${category.label}`);
    }

    // Selecting a new category moves the drawing's existing vote. This also
    // collapses any legacy multi-category votes on the same entry.
    const obsolete = existingVotes.filter((vote) => vote.category_id !== category_id);
    if (obsolete.length) {
      await Promise.all(
        obsolete.map(async (vote) => {
          const removed = await competition_vote_model.deleteOne({ _id: vote._id });
          if (removed.deletedCount) {
            await competition_entry_model.updateOne(
              { _id: entry_id },
              { $inc: { [`vote_counts.${vote.category_id}`]: -1, total_votes: -1 } }
            );
          }
        })
      );
    }

    if (alreadySelected && !alreadySelected.slot) {
      await competition_vote_model.updateOne({ _id: alreadySelected._id }, { $set: { slot: 'entry' } });
    }

    let created = false;
    if (!alreadySelected) {
      try {
        await competition_vote_model.create({
          competition_id: comp._id,
          entry_id: new Types.ObjectId(entry_id),
          voter_id: voterId,
          category_id,
          slot: 'entry',
        });
        created = true;
      } catch (error: any) {
        if (error?.code !== 11000) throw error;
      }

      // Counters are a display convenience; scoring recounts from the votes
      // collection, so a failure here costs nothing but a stale number.
      if (created) {
        await competition_entry_model.updateOne(
          { _id: entry_id },
          { $inc: { [`vote_counts.${category_id}`]: 1, total_votes: 1 } }
        );
      }
    }

    if (!voterHadAnyVote && created) {
      await competition_model.updateOne({ _id: comp._id }, { $inc: { voter_count: 1 } });
    }

    trackEvent(ctx.state.user._id.toString(), mixpanelEvents.competition_vote_cast, {
      week_key: comp.week_key,
      category_id,
    });

    const votes_left_by_category = await voteBudget(comp, voterId);
    ctx.body = {
      success: true,
      votes_left: votes_left_by_category[category_id],
      votes_left_by_category,
    };
  }
);

competitionRouter.delete('/:id/vote', requireAuth, async (ctx) => {
  const comp = await competition_model.findById(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');
  if (!canVote(comp)) return ctx.throw(409, 'Voting is closed');

  // Some clients/proxies do not forward DELETE request bodies. Accept the
  // query contract used by the app while retaining body compatibility.
  const body = (ctx.request.body ?? {}) as Record<string, string>;
  const entry_id = body.entry_id ?? (ctx.query.entry_id as string);
  const category_id = body.category_id ?? (ctx.query.category_id as string);
  if (!entry_id || !Types.ObjectId.isValid(entry_id)) return ctx.throw(400, 'Valid entry_id required');

  const category = comp.categories.find((c) => c.id === category_id);
  if (!category) return ctx.throw(400, 'Unknown category');

  const voterId = new Types.ObjectId(ctx.state.user._id);
  const existingVotes = await competition_vote_model
    .find({
      competition_id: comp._id,
      voter_id: voterId,
      entry_id: new Types.ObjectId(entry_id),
    })
    .lean();
  await Promise.all(
    existingVotes.map(async (vote) => {
      const removed = await competition_vote_model.deleteOne({ _id: vote._id });
      if (removed.deletedCount) {
        await competition_entry_model.updateOne(
          { _id: entry_id },
          { $inc: { [`vote_counts.${vote.category_id}`]: -1, total_votes: -1 } }
        );
      }
    })
  );

  const votes_left_by_category = await voteBudget(comp, voterId);
  ctx.body = {
    success: true,
    votes_left: votes_left_by_category[category_id],
    votes_left_by_category,
  };
});

// ─── RESULTS / ARCHIVE ───────────────────────────────────────────────────────

/**
 * Every active entry this viewer voted for. This cannot be reconstructed from
 * the paginated gallery: a voted entry may sit on a page that has not loaded
 * yet, and "your votes" must be a trustworthy receipt rather than a partial
 * view of whichever cards happen to be mounted.
 */
competitionRouter.get('/:id/my-votes', requireAuth, async (ctx) => {
  if (!Types.ObjectId.isValid(ctx.params.id)) {
    return ctx.throw(404, 'Competition not found');
  }

  const comp = await competition_model.findById(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const votes = await competition_vote_model
    .find({
      competition_id: comp._id,
      voter_id: new Types.ObjectId(ctx.state.user._id),
    })
    .select('entry_id category_id createdAt')
    .sort({ createdAt: -1 })
    .lean();

  if (!votes.length) {
    ctx.body = { entries: [] };
    return;
  }

  const votesByEntry = new Map<string, string[]>();
  const orderedEntryIds: Types.ObjectId[] = [];
  for (const vote of votes) {
    const key = vote.entry_id.toString();
    if (!votesByEntry.has(key)) orderedEntryIds.push(vote.entry_id);
    votesByEntry.set(key, [...(votesByEntry.get(key) ?? []), vote.category_id]);
  }

  const entries = await competition_entry_model
    .find({
      _id: { $in: orderedEntryIds },
      competition_id: comp._id,
      status: 'active',
    })
    .lean();
  const entryById = new Map(entries.map((entry) => [entry._id.toString(), entry]));
  const authors = await hydrateAuthors(entries.map((entry) => entry.user_id));
  const reveal = comp.phase === 'announced';

  ctx.body = {
    entries: orderedEntryIds.flatMap((entryId) => {
      const entry = entryById.get(entryId.toString());
      if (!entry) return [];
      return [
        shapeEntry(
          entry as any,
          authors.get(entry.user_id.toString()) ?? null,
          votesByEntry.get(entry._id.toString()) ?? [],
          reveal
        ),
      ];
    }),
  };
});

competitionRouter.get('/:id/results', requireAuth, async (ctx) => {
  const comp = await competition_model.findById(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');
  if (comp.phase !== 'announced') return ctx.throw(409, 'Results are not out yet');

  const entryIds = comp.results.map((r) => r.entry_id);
  const [entries, authors] = await Promise.all([
    competition_entry_model.find({ _id: { $in: entryIds } }).lean(),
    hydrateAuthors(
      comp.results.map((r) => r.user_id),
      true
    ),
  ]);

  const entryById = new Map(entries.map((e) => [e._id.toString(), e]));

  ctx.body = {
    competition: shapeCompetition(comp),
    skipped_reason: comp.skipped_reason,
    results: comp.results.map((r) => {
      const entry = entryById.get(r.entry_id.toString());
      const category = comp.categories.find((c) => c.id === r.category_id);
      return {
        category_id: r.category_id,
        category_label: category?.label ?? r.category_id,
        category_emoji: category?.emoji ?? '🏆',
        votes: r.votes,
        granted_items: r.granted_items,
        winner: authors.get(r.user_id.toString()) ?? null,
        entry: entry ? shapeEntry(entry as any, null, [], true) : null,
      };
    }),
  };
});

competitionRouter.get('/archive', requireAuth, async (ctx) => {
  const limit = Math.min(parseInt(ctx.query.limit as string) || 10, 30);
  const launchAt = competitionLaunchAt();

  // The archive is a calendar, so order it by the competition week rather
  // than announcement time (a delayed announcement must not reshuffle weeks).
  const past = await competition_model
    .find({
      phase: 'announced',
      ...(launchAt
        ? { $or: [{ week_key: /^test-/ }, { starts_at: { $gte: launchAt } }] }
        : {}),
    })
    .sort({ starts_at: -1, _id: -1 })
    .limit(limit)
    .lean();

  // Hydrate the podium inline: the archive strip is thumbnails and names, and
  // one round-trip per past week would be absurd for a decorative row.
  const entryIds = past.flatMap((c) => (c.results ?? []).map((r) => r.entry_id));
  const winnerIds = past.flatMap((c) => (c.results ?? []).map((r) => r.user_id));

  const [entries, authors] = await Promise.all([
    entryIds.length
      ? competition_entry_model
          .find({ _id: { $in: entryIds } })
          .select('_id thumbnail_url aspect_ratio')
          .lean()
      : [],
    winnerIds.length ? hydrateAuthors(winnerIds as Types.ObjectId[]) : new Map(),
  ]);

  const entryById = new Map(entries.map((e) => [e._id.toString(), e]));

  ctx.body = {
    competitions: past.map((c) => ({
      ...shapeCompetition(c as any),
      winner_count: c.results?.length ?? 0,
      winners: (c.results ?? []).map((r) => {
        const entry = entryById.get(r.entry_id.toString());
        const category = c.categories.find((cat) => cat.id === r.category_id);
        return {
          category_id: r.category_id,
          category_label: category?.label ?? r.category_id,
          category_emoji: category?.emoji ?? '🏆',
          thumbnail_url: entry?.thumbnail_url ?? '',
          aspect_ratio: entry?.aspect_ratio ?? 1,
          name: authors.get(r.user_id.toString())?.name ?? 'Artist',
        };
      }),
    })),
  };
});

/**
 * A user's competition history — the Competitions strip on the profile.
 *
 * Only entries from competitions that have been announced, plus the viewer's
 * own current entry. Someone else's in-flight entry stays where it belongs (the
 * grid), so the profile can't be used to scout the field before voting closes.
 */
competitionRouter.get('/user/:user_id/entries', requireAuth, async (ctx) => {
  const { user_id } = ctx.params;
  if (!Types.ObjectId.isValid(user_id)) return ctx.throw(400, 'Valid user_id required');

  const isSelf = user_id === ctx.state.user._id.toString();
  const limit = Math.min(parseInt(ctx.query.limit as string) || 12, 30);

  const entries = await competition_entry_model
    .find({ user_id: new Types.ObjectId(user_id), status: 'active' })
    .sort({ submitted_at: -1 })
    .limit(limit)
    .lean();

  if (!entries.length) {
    ctx.body = { entries: [] };
    return;
  }

  const comps = await competition_model
    .find({ _id: { $in: entries.map((e) => e.competition_id) } })
    .select('_id week_key theme accent phase')
    .lean();

  const compById = new Map(comps.map((c) => [c._id.toString(), c]));

  ctx.body = {
    entries: entries
      .filter((e) => {
        const comp = compById.get(e.competition_id.toString());
        return comp && (comp.phase === 'announced' || isSelf);
      })
      .map((e) => {
        const comp = compById.get(e.competition_id.toString())!;
        return {
          _id: e._id.toString(),
          thumbnail_url: e.thumbnail_url,
          image_url: e.image_url,
          aspect_ratio: e.aspect_ratio,
          is_winner: !!e.is_winner,
          won_category: e.won_category,
          week_key: comp.week_key,
          theme: comp.theme,
          accent: comp.accent,
          pending: comp.phase !== 'announced',
          vote_counts:
            comp.phase === 'announced'
              ? e.vote_counts instanceof Map
                ? Object.fromEntries(e.vote_counts)
                : e.vote_counts ?? {}
              : undefined,
          total_votes: comp.phase === 'announced' ? e.total_votes ?? 0 : undefined,
          // The owner controls their artwork even after results are announced.
          // Deleting an old entry removes it from the archive; only deleting an
          // open competition entry can naturally free this week's entry slot.
          can_delete: isSelf,
          competition_id: comp._id.toString(),
          drawing_url: e.drawing_url,
          caption: e.caption ?? '',
          caption_filtered: e.caption_filtered ?? '',
          comment_count: e.comment_count ?? 0,
          author_id: e.user_id.toString(),
        };
      }),
  };
});

/** Marks the winners moment as seen for this user — once per user, not per device. */
competitionRouter.post('/:id/seen', requireAuth, async (ctx) => {
  const comp = await competition_model.findById(ctx.params.id).select('week_key').lean();
  if (!comp) return ctx.throw(404, 'Competition not found');

  await user_model.updateOne(
    { _id: ctx.state.user._id },
    { $set: { 'competition.last_seen_results_week': comp.week_key } }
  );

  ctx.body = { success: true };
});

// ─── PREFERENCES ─────────────────────────────────────────────────────────────

/**
 * Dedicated route rather than the generic user `/update`: that one $sets whole
 * objects, so writing `{ competition: { notifications: false } }` through it
 * would silently wipe `last_seen_results_week` and `wins`.
 */
competitionRouter.put('/preferences', requireAuth, async (ctx) => {
  const { notifications } = ctx.request.body as { notifications?: boolean };
  if (typeof notifications !== 'boolean') {
    return ctx.throw(400, 'notifications must be a boolean');
  }

  await user_model.updateOne({ _id: ctx.state.user._id }, { $set: { 'competition.notifications': notifications } });

  ctx.body = { notifications };
});

// ─── THEMES ──────────────────────────────────────────────────────────────────

/**
 * Approved-but-unused suggestions, most upvoted first, plus the viewer's own
 * pending ones so a suggestion never looks like it vanished.
 *
 * `pending` suggestions from other users are deliberately NOT listed: they are
 * unmoderated free text on a surface minors can see (§2.6).
 */
competitionRouter.get('/themes', requireAuth, requireAdultAccount(COMPETITION_AGE_MESSAGE), async (ctx) => {
  const userId = new Types.ObjectId(ctx.state.user._id);
  const comp = await getActiveCompetition();
  if (!comp) {
    ctx.body = { themes: [], my_pending: [], can_suggest: false, can_suggest_at: null };
    return;
  }

  const cycleScope = {
    $or: [
      { cycle_competition_id: comp._id },
      // Curated themes and suggestions created before cycle scoping.
      { cycle_competition_id: { $exists: false } },
    ],
  };

  const [approved, mine, myVotes] = await Promise.all([
    competition_theme_model
      .find({ status: 'approved', ...cycleScope })
      .sort({ upvotes: -1, createdAt: 1 })
      .limit(100)
      .lean(),
    competition_theme_model
      .find({
        suggested_by: userId,
        cycle_competition_id: comp._id,
        status: { $in: ['pending', 'rejected'] },
      })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
    competition_theme_vote_model.find({ user_id: userId }).select('theme_id').lean(),
  ]);

  const voted = new Set(myVotes.map((v) => v.theme_id.toString()));
  const profanityFilter = ctx.state.user.profanity_filter !== false;

  const shape = (t: any) => ({
    _id: t._id.toString(),
    text: profanityFilter && t.text_filtered ? t.text_filtered : t.text,
    status: t.status,
    upvotes: t.upvotes ?? 0,
    mine: t.suggested_by?.toString() === userId.toString(),
    voted: voted.has(t._id.toString()),
    rejected_reason: t.rejected_reason,
  });

  const alreadySuggested = await competition_theme_model.exists({
    suggested_by: userId,
    cycle_competition_id: comp._id,
  });

  ctx.body = {
    themes: approved.map(shape),
    my_pending: mine.map(shape),
    can_suggest: !alreadySuggested,
    // Kept for older clients. The boundary is now the actual competition
    // rollover rather than an arbitrary seven-day timer.
    can_suggest_at: alreadySuggested ? comp.ends_at.toISOString() : null,
    cycle_competition_id: comp._id.toString(),
  };
});

competitionRouter.post(
  '/themes',
  requireAuth,
  requireCapability(Capability.CREATE_POST),
  requireAdultAccount(COMPETITION_AGE_MESSAGE),
  async (ctx) => {
    const { text } = ctx.request.body as { text?: string };
    const trimmed = (text ?? '').trim();

    if (trimmed.length < 4) return ctx.throw(400, 'That is a bit short');
    if (trimmed.length > MAX_THEME_LENGTH) {
      return ctx.throw(400, `Keep it under ${MAX_THEME_LENGTH} characters`);
    }

    const userId = new Types.ObjectId(ctx.state.user._id);
    const comp = await getActiveCompetition();
    if (!comp) return ctx.throw(409, 'No competition cycle is active');

    // One suggestion for each competition's next-theme vote. A new active
    // competition starts a fresh cycle immediately; calendar time is irrelevant.
    const recent = await competition_theme_model
      .findOne({
        suggested_by: userId,
        cycle_competition_id: comp._id,
      })
      .select('_id')
      .lean();
    if (recent) return ctx.throw(429, 'You can suggest one theme per competition');

    let theme;
    try {
      theme = await competition_theme_model.create({
        text: trimmed,
        text_filtered: censorText(trimmed),
        suggested_by: userId,
        cycle_competition_id: comp._id,
        status: 'pending',
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        return ctx.throw(429, 'You can suggest one theme per competition');
      }
      throw error;
    }

    ctx.status = 201;
    ctx.body = {
      theme: {
        _id: theme._id.toString(),
        text: theme.text_filtered || theme.text,
        status: theme.status,
        upvotes: 0,
        mine: true,
        voted: false,
      },
    };
  }
);

/** A suggestion still awaiting moderation belongs to its author and can be
 * withdrawn. Approved/used ideas are already public history and cannot vanish
 * through this self-service route. */
competitionRouter.delete('/themes/:theme_id', requireAuth, async (ctx) => {
  const { theme_id } = ctx.params;
  if (!Types.ObjectId.isValid(theme_id)) return ctx.throw(400, 'Valid theme_id required');

  const removed = await competition_theme_model.findOneAndDelete({
    _id: new Types.ObjectId(theme_id),
    suggested_by: new Types.ObjectId(ctx.state.user._id),
    status: 'pending',
  });
  if (!removed) return ctx.throw(409, 'Only a suggestion in review can be cancelled');

  await competition_theme_vote_model.deleteMany({ theme_id: removed._id });
  ctx.body = { success: true };
});

/** Toggle. Only approved themes are votable — a pending one may never run. */
competitionRouter.post(
  '/themes/:theme_id/upvote',
  requireAuth,
  requireAdultAccount(COMPETITION_AGE_MESSAGE),
  async (ctx) => {
    const { theme_id } = ctx.params;
    if (!Types.ObjectId.isValid(theme_id)) return ctx.throw(400, 'Valid theme_id required');

    const theme = await competition_theme_model.findById(theme_id).select('status cycle_competition_id').lean();
    if (!theme || theme.status !== 'approved') return ctx.throw(404, 'Theme not available');

    const comp = await getActiveCompetition();
    if (theme.cycle_competition_id && (!comp || theme.cycle_competition_id.toString() !== comp._id.toString())) {
      return ctx.throw(409, 'This theme vote belongs to a previous competition');
    }

    const userId = new Types.ObjectId(ctx.state.user._id);
    const themeId = new Types.ObjectId(theme_id);

    const existing = await competition_theme_vote_model.findOneAndDelete({
      theme_id: themeId,
      user_id: userId,
    });

    if (existing) {
      await competition_theme_model.updateOne({ _id: themeId }, { $inc: { upvotes: -1 } });
      ctx.body = { voted: false };
      return;
    }

    try {
      await competition_theme_vote_model.create({ theme_id: themeId, user_id: userId });
      await competition_theme_model.updateOne({ _id: themeId }, { $inc: { upvotes: 1 } });
      ctx.body = { voted: true };
    } catch (error: any) {
      // Unique index — a double tap raced itself. Idempotent: report the truth.
      if (error?.code === 11000) {
        ctx.body = { voted: true };
        return;
      }
      throw error;
    }
  }
);

/**
 * A single competition for archive/detail screens. Kept last because `/archive`
 * and `/themes` are also one-segment routes and must win first.
 */
competitionRouter.get('/:id', requireAuth, async (ctx) => {
  if (!Types.ObjectId.isValid(ctx.params.id)) return ctx.throw(404, 'Competition not found');

  const comp = await competition_model.findById(ctx.params.id);
  if (!comp) return ctx.throw(404, 'Competition not found');

  const voterId = new Types.ObjectId(ctx.state.user._id);
  const votes = await competition_vote_model
    .find({ competition_id: comp._id, voter_id: voterId })
    .select('category_id')
    .lean();

  const used: Record<string, number> = {};
  for (const vote of votes) {
    used[vote.category_id] = (used[vote.category_id] ?? 0) + 1;
  }

  ctx.body = {
    competition: shapeCompetition(comp),
    votes_left: Object.fromEntries(
      comp.categories.map((category) => [category.id, Math.max(0, category.votes_per_user - (used[category.id] ?? 0))])
    ),
    can_vote: canVote(comp),
    can_submit: canSubmit(comp),
  };
});

export default competitionRouter;
