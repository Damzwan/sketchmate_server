import 'dotenv/config';
import mongoose, { Types } from 'mongoose';

import { user_model } from '../models/user.model';
import { relationship_model } from '../models/relationship.model';
import { conversation_model } from '../models/conversation.model';
import { message_model } from '../models/message.model';
import { post_model, post_comment_model, post_reaction_model, post_view_model } from '../models/post.model';
import { inbox_model } from '../models/inbox.model';
import { inbox_comment_model } from '../models/inbox-comment.model';
import { balloon_model } from '../models/balloon.model';
import { notification_model } from '../models/notification.model';
import { report_model, moderation_action_model } from '../models/moderation.model';
import { saved_drawing_model } from '../models/saved-drawing.model';
import { quota_usage_model } from '../models/quota_usage.model';
import { deletion_queue_model } from '../models/deletion.model';

/**
 * Merges two user accounts into one.
 *
 *   DRY RUN (default — writes nothing, prints every planned change):
 *     pnpm ts-node src/scripts/merge-user-accounts.ts --keep <id> --merge <id>
 *
 *   APPLY:
 *     pnpm ts-node src/scripts/merge-user-accounts.ts --keep <id> --merge <id> --apply
 *
 * DIRECTION MATTERS. `--keep` is the document that SURVIVES: its `_id` stays,
 * and every reference in every other collection ends up pointing at it.
 * `--merge` is consumed and deleted.
 *
 * For the anonymous-account case the survivor should be the OLD, progress-rich
 * account, because `_id` is immutable in Mongo — "moving" the id would mean
 * re-inserting the document and rewriting every reference in the database
 * instead of only the handful the newer account created. Authentication is
 * resolved purely by `auth_id` (see middleware/auth.ts), so copying the new
 * Google `auth_id` onto the old document is what actually reunites the user
 * with their progress. `--auth-from-merged` (default true) does exactly that.
 *
 * Idempotent: re-running after a successful apply finds no `--merge` user and
 * exits cleanly.
 *
 * Runs inside a transaction when the deployment is a replica set (Atlas is).
 * Pass --no-transaction to run without one — then a mid-way failure leaves a
 * partial merge, so only do that on a standalone mongod.
 */

// ---------------------------------------------------------------------------
// ARGS
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const APPLY = argv.includes('--apply');
const USE_TX = !argv.includes('--no-transaction');
const AUTH_FROM_MERGED = !argv.includes('--keep-auth');
const DB_NAME = arg('db') ?? 'prod';

const KEEP_ARG = arg('keep');
const MERGE_ARG = arg('merge');

if (!KEEP_ARG || !MERGE_ARG) {
  console.error('usage: --keep <survivor_user_id> --merge <consumed_user_id> [--apply] [--db prod]');
  process.exit(1);
}
if (KEEP_ARG === MERGE_ARG) {
  console.error('--keep and --merge are the same id');
  process.exit(1);
}

const KEEP = new Types.ObjectId(KEEP_ARG);
const LOSE = new Types.ObjectId(MERGE_ARG);
const KEEP_S = KEEP.toString();
const LOSE_S = LOSE.toString();

/** Matches a field that may hold either the ObjectId or its string form. */
const loserAny = { $in: [LOSE as any, LOSE_S] };

let session: mongoose.ClientSession | null = null;
const opts = () => (session ? { session } : {});

const log: string[] = [];
const note = (line: string) => {
  log.push(line);
  console.log(line);
};

// ---------------------------------------------------------------------------
// GENERIC HELPERS
// ---------------------------------------------------------------------------

/** Rewrites a scalar reference field on every matching document. */
async function reassignScalar(model: any, field: string, label = model.modelName) {
  const filter = { [field]: loserAny };
  const n = await model.countDocuments(filter, opts());
  if (!n) return;
  note(`  ${label}.${field}: ${n} doc(s) → keeper`);
  if (APPLY) await model.updateMany(filter, { $set: { [field]: KEEP } }, opts());
}

/**
 * Rewrites a reference inside an array field, de-duplicating: pull the loser
 * (both id shapes) and $addToSet the keeper, so a document that already
 * contained the keeper does not end up listing the same person twice.
 */
async function reassignArray(model: any, field: string, label = model.modelName) {
  const filter = { [field]: loserAny };
  const docs = await model.find(filter, { _id: 1 }, opts()).lean();
  if (!docs.length) return;
  note(`  ${label}.${field}[]: ${docs.length} doc(s) → keeper (deduped)`);
  if (!APPLY) return;
  const ids = docs.map((d: any) => d._id);
  await model.updateMany({ _id: { $in: ids } }, { $pull: { [field]: loserAny } }, opts());
  await model.updateMany({ _id: { $in: ids } }, { $addToSet: { [field]: KEEP } }, opts());
}

const CHAT_STATUS_RANK: Record<string, number> = {
  none: 0,
  expired: 1,
  pending_invite: 2,
  temporary: 3,
  pending_mate: 4,
  mate: 5,
  blocked: 6 // blocked always wins — never silently un-block a merge
};

const rankOf = (s?: string) => CHAT_STATUS_RANK[s ?? 'none'] ?? 0;
const maxDate = (a?: Date | null, b?: Date | null) =>
  !a ? b ?? undefined : !b ? a : a > b ? a : b;

const mapId = (v: any) => (v && String(v) === LOSE_S ? KEEP : v);

// ---------------------------------------------------------------------------
// 1. CONVERSATIONS  (must run before relationships — they carry conversation_id)
// ---------------------------------------------------------------------------
const convRemap = new Map<string, Types.ObjectId>(); // loser conv _id → surviving conv _id
const convDeleted: Types.ObjectId[] = [];

async function mergeConversations() {
  note('\n── CONVERSATIONS ──');
  const losing = await conversation_model.find({ participants: loserAny }, null, opts()).lean();
  note(`  conversations involving merged account: ${losing.length}`);

  for (const conv of losing as any[]) {
    const other = conv.participants.find((p: any) => String(p) !== LOSE_S);

    // Self-conversation between the two accounts — the two "people" are one
    // person, so this thread has no counterpart. Drop it with its messages.
    if (!other || String(other) === KEEP_S) {
      const msgs = await message_model.countDocuments({ conversation_id: conv._id }, opts());
      note(`  [self] conv ${conv._id} + ${msgs} message(s) → DELETE`);
      if (APPLY) {
        await message_model.deleteMany({ conversation_id: conv._id }, opts());
        await conversation_model.deleteOne({ _id: conv._id }, opts());
      }
      convDeleted.push(conv._id);
      continue;
    }

    const twin = await conversation_model
      .findOne({ participants: { $all: [KEEP, other] } }, null, opts())
      .lean() as any;

    if (!twin) {
      // No conflict: rewrite in place. `participants` is stored sorted and read
      // back with an exact array match in places, so re-sort after the swap.
      const participants = [KEEP, other].sort((a, b) => (String(a) < String(b) ? -1 : 1));
      const counts: Record<string, number> = { ...(conv.unread_counts ?? {}) };
      counts[KEEP_S] = (counts[KEEP_S] ?? 0) + (counts[LOSE_S] ?? 0);
      delete counts[LOSE_S];

      note(`  conv ${conv._id} with ${other}: repoint participants, unread=${counts[KEEP_S]}`);
      if (APPLY) {
        await conversation_model.updateOne(
          { _id: conv._id },
          { $set: { participants, unread_counts: counts } },
          opts()
        );
      }
      continue;
    }

    // Conflict: he talked to the same person from both accounts. Fold the
    // messages into the keeper's thread; the unique index on
    // (participants.0, participants.1) would reject two surviving documents.
    const moved = await message_model.countDocuments({ conversation_id: conv._id }, opts());
    const counts: Record<string, number> = { ...(twin.unread_counts ?? {}) };
    counts[KEEP_S] = (counts[KEEP_S] ?? 0) + (conv.unread_counts?.[KEEP_S] ?? 0) + (conv.unread_counts?.[LOSE_S] ?? 0);
    const otherS = String(other);
    counts[otherS] = (counts[otherS] ?? 0) + (conv.unread_counts?.[otherS] ?? 0);
    delete counts[LOSE_S];

    note(`  conv ${conv._id} with ${other}: MERGE into ${twin._id} (${moved} message(s))`);
    convRemap.set(String(conv._id), twin._id);

    if (APPLY) {
      await message_model.updateMany(
        { conversation_id: conv._id },
        { $set: { conversation_id: twin._id } },
        opts()
      );
      await conversation_model.updateOne(
        { _id: twin._id },
        { $set: { unread_counts: counts } },
        opts()
      );
      await conversation_model.deleteOne({ _id: conv._id }, opts());

      // last_message must be the newest across both threads now.
      const newest = await message_model
        .findOne({ conversation_id: twin._id }, { _id: 1 }, opts())
        .sort({ createdAt: -1 })
        .lean() as any;
      if (newest) {
        await conversation_model.updateOne(
          { _id: twin._id },
          { $set: { last_message: newest._id, updatedAt: new Date() } },
          opts()
        );
      }
    }
  }

  // Every message he sent, wherever it now lives.
  await reassignScalar(message_model, 'sender_id');
}

// ---------------------------------------------------------------------------
// 2. RELATIONSHIPS
// ---------------------------------------------------------------------------
function mergeMateRequests(a: any[] = [], b: any[] = []) {
  const out = new Map<string, any>();
  for (const r of [...a, ...b]) {
    const requester = mapId(r.requester);
    const k = String(requester);
    const prev = out.get(k);
    out.set(k, prev
      ? {
        requester,
        // Counters are anti-pestering ledgers: summing keeps the cooldown the
        // partner already earned instead of handing the merged account a fresh
        // clean slate to re-send from.
        declines: (prev.declines ?? 0) + (r.declines ?? 0),
        attempts: (prev.attempts ?? 0) + (r.attempts ?? 0),
        last_requested_at: maxDate(prev.last_requested_at, r.last_requested_at),
        cooldown_until: maxDate(prev.cooldown_until, r.cooldown_until)
      }
      : { ...r, requester });
  }
  return [...out.values()];
}

function mergeFollows(a: any[] = [], b: any[] = []) {
  const out = new Map<string, any>();
  for (const f of [...a, ...b]) {
    const follower = mapId(f.follower);
    const followed = mapId(f.followed);
    if (String(follower) === String(followed)) continue; // self-follow artefact
    out.set(`${follower}|${followed}`, { follower, followed });
  }
  return [...out.values()];
}

async function mergeRelationships() {
  note('\n── RELATIONSHIPS ──');
  const losing = await relationship_model.find({ users: loserAny }, null, opts()).lean();
  note(`  relationships involving merged account: ${losing.length}`);

  for (const rel of losing as any[]) {
    const other = rel.users.find((u: any) => String(u) !== LOSE_S);

    // The old↔new relationship: he "befriended himself" across accounts, or a
    // pending invite exists between the two. Meaningless post-merge.
    if (!other || String(other) === KEEP_S) {
      note(`  [self] relationship ${rel._id} (${rel.chat_status}) → DELETE`);
      if (APPLY) await relationship_model.deleteOne({ _id: rel._id }, opts());
      continue;
    }

    const twin = await relationship_model
      .findOne({ users: { $all: [KEEP, other] } }, null, opts())
      .lean() as any;

    const conversation_id = rel.conversation_id
      ? convRemap.get(String(rel.conversation_id)) ??
        (convDeleted.some((d) => String(d) === String(rel.conversation_id)) ? undefined : rel.conversation_id)
      : undefined;

    if (!twin) {
      const users = [KEEP, other].sort((a, b) => (String(a) < String(b) ? -1 : 1));
      note(`  rel ${rel._id} with ${other} (${rel.chat_status}): repoint`);
      if (APPLY) {
        await relationship_model.updateOne(
          { _id: rel._id },
          {
            $set: {
              users,
              follows: mergeFollows(rel.follows),
              mate_requests: mergeMateRequests(rel.mate_requests),
              ...(rel.action_user_id ? { action_user_id: mapId(rel.action_user_id) } : {}),
              ...(rel.blocked_by ? { blocked_by: mapId(rel.blocked_by) } : {}),
              ...(conversation_id ? { conversation_id } : {})
            },
            ...(rel.conversation_id && !conversation_id ? { $unset: { conversation_id: '' } } : {})
          },
          opts()
        );
      }
      continue;
    }

    // Conflict: both accounts have a relationship with the same person.
    const winnerStatus = rankOf(rel.chat_status) > rankOf(twin.chat_status)
      ? rel.chat_status
      : twin.chat_status;
    const blocked_by = twin.blocked_by ?? (rel.blocked_by ? mapId(rel.blocked_by) : undefined);

    note(
      `  rel ${rel._id} with ${other}: MERGE into ${twin._id} ` +
      `(${twin.chat_status} + ${rel.chat_status} → ${winnerStatus})`
    );

    if (APPLY) {
      const set: any = {
        chat_status: winnerStatus,
        follows: mergeFollows(twin.follows, rel.follows),
        mate_requests: mergeMateRequests(twin.mate_requests, rel.mate_requests),
        expires_at: maxDate(twin.expires_at, rel.expires_at),
        cooldown_until: maxDate(twin.cooldown_until, rel.cooldown_until)
      };
      if (blocked_by) set.blocked_by = blocked_by;
      if (!twin.conversation_id && conversation_id) set.conversation_id = conversation_id;
      if (twin.action_user_id || rel.action_user_id) {
        set.action_user_id = twin.action_user_id ?? mapId(rel.action_user_id);
      }
      // A merged document must never stay soft-deleted while the survivor is live.
      const unset = twin.deleted_at && winnerStatus !== 'none' ? { deleted_at: '' } : undefined;

      await relationship_model.updateOne(
        { _id: twin._id },
        { $set: set, ...(unset ? { $unset: unset } : {}) },
        opts()
      );
      await relationship_model.deleteOne({ _id: rel._id }, opts());
    }
  }

  // Follow edges and action fields on relationships the merged account was not
  // a participant of (it followed someone via a relationship it doesn't own is
  // impossible today, but blocked_by/action_user_id leftovers are cheap to fix).
  await reassignScalar(relationship_model, 'action_user_id');
  await reassignScalar(relationship_model, 'blocked_by');

  const strayFollows = await relationship_model.find({
    $or: [{ 'follows.follower': loserAny }, { 'follows.followed': loserAny }]
  }, null, opts()).lean();
  if (strayFollows.length) {
    note(`  stray follow edges in ${strayFollows.length} relationship(s) → keeper`);
    if (APPLY) {
      for (const r of strayFollows as any[]) {
        await relationship_model.updateOne(
          { _id: r._id },
          { $set: { follows: mergeFollows(r.follows) } },
          opts()
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. POSTS, REACTIONS, COMMENTS, VIEWS
// ---------------------------------------------------------------------------
async function mergePostGraph() {
  note('\n── POSTS ──');
  await reassignScalar(post_model, 'author_id');
  await reassignScalar(post_comment_model, 'author_id');

  // post_reactions is unique on (post_id, user_id). If both identities reacted
  // to the same post, the two reactions collapse into one — so the post's
  // aggregate counters have to come down by one as well, or the post claims a
  // reaction that no longer exists.
  const loserReactions = await post_reaction_model.find({ user_id: loserAny }, null, opts()).lean();
  let dupReactions = 0;
  for (const r of loserReactions as any[]) {
    const twin = await post_reaction_model
      .findOne({ post_id: r.post_id, user_id: KEEP }, null, opts()).lean() as any;
    if (!twin) {
      if (APPLY) {
        await post_reaction_model.updateOne({ _id: r._id }, { $set: { user_id: KEEP } }, opts());
      }
      continue;
    }
    dupReactions++;
    if (APPLY) {
      await post_reaction_model.deleteOne({ _id: r._id }, opts());
      await post_model.updateOne(
        { _id: r.post_id },
        { $inc: { total_reactions: -1, [`reaction_counts.${r.reaction_type}`]: -1 } },
        opts()
      );
    }
  }
  note(`  post_reactions: ${loserReactions.length} (${dupReactions} duplicate → deleted + counters decremented)`);

  // post_views is unique on (user_id, post_id); seen_count is additive.
  const loserViews = await post_view_model.find({ user_id: loserAny }, null, opts()).lean();
  let dupViews = 0;
  for (const v of loserViews as any[]) {
    const twin = await post_view_model
      .findOne({ post_id: v.post_id, user_id: KEEP }, null, opts()).lean() as any;
    if (!twin) {
      if (APPLY) await post_view_model.updateOne({ _id: v._id }, { $set: { user_id: KEEP } }, opts());
      continue;
    }
    dupViews++;
    if (APPLY) {
      await post_view_model.updateOne(
        { _id: twin._id },
        {
          $inc: { seen_count: v.seen_count ?? 1 },
          $max: { last_seen_at: v.last_seen_at ?? new Date() }
        },
        opts()
      );
      await post_view_model.deleteOne({ _id: v._id }, opts());
    }
  }
  note(`  post_views: ${loserViews.length} (${dupViews} duplicate → folded)`);
}

// ---------------------------------------------------------------------------
// 4. INBOX / GALLERY
// ---------------------------------------------------------------------------
async function mergeInbox() {
  note('\n── INBOX ──');
  await reassignScalar(inbox_model, 'sender');
  await reassignArray(inbox_model, 'followers');
  await reassignArray(inbox_model, 'original_followers');
  await reassignArray(inbox_model, 'seen_by');
  await reassignArray(inbox_model, 'comments_seen_by');

  // Legacy nested comments store `sender` as a string.
  const nested = await inbox_model.countDocuments({ 'comments.sender': loserAny }, opts());
  if (nested) {
    note(`  inbox.comments[].sender: ${nested} doc(s) → keeper`);
    if (APPLY) {
      await inbox_model.updateMany(
        { 'comments.sender': loserAny },
        { $set: { 'comments.$[c].sender': KEEP_S } },
        { ...opts(), arrayFilters: [{ 'c.sender': loserAny }] } as any
      );
    }
  }

  await reassignScalar(inbox_comment_model, 'sender');
}

// ---------------------------------------------------------------------------
// 5. EVERYTHING ELSE KEYED BY USER
// ---------------------------------------------------------------------------
async function mergeMisc() {
  note('\n── BALLOONS / NOTIFICATIONS / MODERATION / MISC ──');

  await reassignScalar(balloon_model, 'sender');
  await reassignScalar(balloon_model, 'pairedUser');
  await reassignArray(balloon_model, 'rejected_by');

  await reassignScalar(notification_model, 'recipient_id');
  const actors = await notification_model.countDocuments({ 'actors._id': loserAny }, opts());
  if (actors) {
    note(`  notifications.actors[]._id: ${actors} doc(s) → keeper`);
    if (APPLY) {
      await notification_model.updateMany(
        { 'actors._id': loserAny },
        { $set: { 'actors.$[a]._id': KEEP } },
        { ...opts(), arrayFilters: [{ 'a._id': loserAny }] } as any
      );
    }
  }

  // reports is unique on (reporter_id, target_id, target_type): if he reported
  // the same thing twice, once per account, the second copy has to go.
  const loserReports = await report_model.find({ reporter_id: loserAny }, null, opts()).lean();
  let dupReports = 0;
  for (const r of loserReports as any[]) {
    const twin = await report_model.findOne(
      { reporter_id: KEEP, target_id: r.target_id, target_type: r.target_type }, null, opts()
    ).lean();
    if (twin) {
      dupReports++;
      if (APPLY) await report_model.deleteOne({ _id: r._id }, opts());
    } else if (APPLY) {
      await report_model.updateOne({ _id: r._id }, { $set: { reporter_id: KEEP } }, opts());
    }
  }
  note(`  reports.reporter_id: ${loserReports.length} (${dupReports} duplicate → deleted)`);
  await reassignScalar(report_model, 'target_author_id');
  await reassignScalar(report_model, 'resolved_by');

  await reassignScalar(moderation_action_model, 'user_id');
  await reassignScalar(moderation_action_model, 'admin_id');

  await reassignScalar(saved_drawing_model, 'user_id');
  await reassignScalar(deletion_queue_model, 'target_id');

  // quota usage is unique on (user_id, date) — same UTC day from both accounts
  // must be summed, not dropped, or he gets free quota back.
  const loserQuota = await quota_usage_model.find({ user_id: loserAny }, null, opts()).lean();
  let dupQuota = 0;
  for (const q of loserQuota as any[]) {
    const twin = await quota_usage_model
      .findOne({ user_id: KEEP, date: q.date }, null, opts()).lean() as any;
    if (!twin) {
      if (APPLY) await quota_usage_model.updateOne({ _id: q._id }, { $set: { user_id: KEEP } }, opts());
      continue;
    }
    dupQuota++;
    if (APPLY) {
      await quota_usage_model.updateOne(
        { _id: twin._id },
        {
          $inc: {
            balloons_sent: q.balloons_sent ?? 0,
            posts_created: q.posts_created ?? 0,
            mates_made: q.mates_made ?? 0
          }
        },
        opts()
      );
      await quota_usage_model.deleteOne({ _id: q._id }, opts());
    }
  }
  note(`  quota_usage: ${loserQuota.length} day(s) (${dupQuota} same-day → summed)`);
}

// ---------------------------------------------------------------------------
// 6. LEGACY USER-EMBEDDED REFERENCES ON *OTHER* USERS
// ---------------------------------------------------------------------------
async function mergeLegacyUserRefs() {
  note('\n── LEGACY EMBEDDED REFS (other users) ──');

  // `mates` is deprecated but still drives migrateMatesToRelationships for any
  // account that has not hit migration_version 1 yet, so it cannot be ignored.
  const withMate = await user_model.find(
    { 'mates._id': loserAny, _id: { $ne: LOSE } }, null, opts()
  ).lean();
  if (withMate.length) {
    note(`  users.mates[]: ${withMate.length} user(s) → keeper (deduped)`);
    if (APPLY) {
      const keeper = await user_model.findById(KEEP, { name: 1, img: 1 }, opts()).lean() as any;
      for (const u of withMate as any[]) {
        const hasKeeper = (u.mates ?? []).some((m: any) => String(m._id) === KEEP_S);
        await user_model.updateOne({ _id: u._id }, { $pull: { mates: { _id: loserAny } } }, opts());
        if (!hasKeeper) {
          await user_model.updateOne(
            { _id: u._id },
            { $push: { mates: { _id: KEEP, name: keeper.name, img: keeper.img } } },
            opts()
          );
        }
      }
    }
  }

  for (const field of ['mate_requests_sent', 'mate_requests_received']) {
    const n = await user_model.countDocuments(
      { [field]: loserAny, _id: { $ne: LOSE } }, opts()
    );
    if (!n) continue;
    // Pull only, no re-add. These arrays are deprecated and superseded by
    // relationship.mate_requests, which this script already merges; a stale
    // pending-request entry pointing at a live account is worse than a
    // missing one on a field nothing reads anymore.
    note(`  users.${field}[]: ${n} user(s) → loser entry removed`);
    if (APPLY) {
      await user_model.updateMany(
        { [field]: loserAny, _id: { $ne: LOSE } },
        { $pull: { [field]: loserAny } },
        opts()
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 7. THE USER DOCUMENT ITSELF
// ---------------------------------------------------------------------------
async function mergeUserDocuments(keeper: any, loser: any) {
  note('\n── USER DOCUMENT ──');

  // Profile identity comes from the account he is actually using now.
  const set: any = {
    name: loser.name && loser.name !== 'Anonymous' ? loser.name : keeper.name,
    img: loser.img ?? keeper.img,
    description: loser.description ?? keeper.description,
    customization: { ...(keeper.customization ?? {}), ...(loser.customization ?? {}) },
    chat_customization: {
      ...(keeper.chat_customization ?? {}),
      ...(loser.chat_customization ?? {})
    },
    date_of_birth: keeper.date_of_birth ?? loser.date_of_birth,
    last_seen_version: loser.last_seen_version ?? keeper.last_seen_version,
    feed_level: loser.feed_level ?? keeper.feed_level,
    migration_version: Math.max(keeper.migration_version ?? 0, loser.migration_version ?? 0),

    // Entitlements are additive — losing a purchase in a merge is unacceptable.
    subscription_tier:
      [keeper.subscription_tier, loser.subscription_tier].includes('lifetime')
        ? 'lifetime'
        : keeper.subscription_tier === 'free' ? loser.subscription_tier : keeper.subscription_tier,

    // Moderation history is additive too — a merge must not launder strikes.
    strike_summary: {
      active_strikes: (keeper.strike_summary?.active_strikes ?? 0) + (loser.strike_summary?.active_strikes ?? 0),
      total_strikes: (keeper.strike_summary?.total_strikes ?? 0) + (loser.strike_summary?.total_strikes ?? 0),
      last_strike_at: maxDate(keeper.strike_summary?.last_strike_at, loser.strike_summary?.last_strike_at)
    },
    restriction:
      (loser.restriction?.level ?? 0) > (keeper.restriction?.level ?? 0)
        ? loser.restriction
        : keeper.restriction,

    balloon: {
      sent: loser.balloon?.sent ?? keeper.balloon?.sent ?? null,
      received: loser.balloon?.received ?? keeper.balloon?.received ?? null,
      disabled: Boolean(keeper.balloon?.disabled || loser.balloon?.disabled),
      last_received_at: maxDate(keeper.balloon?.last_received_at, loser.balloon?.last_received_at) ?? null
    },

    // One subscription entry per device fingerprint, newest wins.
    subscriptions: dedupeSubscriptions([...(keeper.subscriptions ?? []), ...(loser.subscriptions ?? [])])
  };

  if (AUTH_FROM_MERGED) set.auth_id = loser.auth_id;

  const addToSet: any = {
    inventory: { $each: [...new Set([...(keeper.inventory ?? []), ...(loser.inventory ?? [])])] },
    stickers: { $each: [...new Set([...(keeper.stickers ?? []), ...(loser.stickers ?? [])])] },
    emblems: { $each: [...new Set([...(keeper.emblems ?? []), ...(loser.emblems ?? [])])] },
    inbox: { $each: [...new Set([...(keeper.inbox ?? []), ...(loser.inbox ?? [])].map(String))] },
    saved: { $each: loser.saved ?? [] }
  };

  note(`  auth_id: ${keeper.auth_id} → ${AUTH_FROM_MERGED ? loser.auth_id : keeper.auth_id}`);
  note(`  name: "${keeper.name}" → "${set.name}"`);
  note(`  subscription_tier: ${keeper.subscription_tier} + ${loser.subscription_tier} → ${set.subscription_tier}`);
  note(`  inventory: ${(keeper.inventory ?? []).length} + ${(loser.inventory ?? []).length} → ${addToSet.inventory.$each.length}`);
  note(`  inbox items: ${(keeper.inbox ?? []).length} + ${(loser.inbox ?? []).length} → ${addToSet.inbox.$each.length}`);
  note(`  subscriptions: ${set.subscriptions.length} device(s) after dedupe`);

  if (APPLY) {
    await user_model.updateOne({ _id: KEEP }, { $set: set, $addToSet: addToSet }, opts());
  }
}

function dedupeSubscriptions(subs: any[]) {
  const byFingerprint = new Map<string, any>();
  for (const s of subs) {
    const prev = byFingerprint.get(s.fingerprint);
    if (!prev || (s.updated_at ?? 0) > (prev.updated_at ?? 0)) byFingerprint.set(s.fingerprint, s);
  }
  return [...byFingerprint.values()];
}

// ---------------------------------------------------------------------------
// 8. RECOMPUTE DERIVED COUNTERS
// ---------------------------------------------------------------------------
async function recomputeStats() {
  note('\n── STATS RECOMPUTE (survivor) ──');
  const [mates, followers, following, posts] = await Promise.all([
    relationship_model.countDocuments({ users: KEEP, chat_status: 'mate' }, opts()),
    relationship_model.countDocuments({ follows: { $elemMatch: { followed: KEEP } } }, opts()),
    relationship_model.countDocuments({ follows: { $elemMatch: { follower: KEEP } } }, opts()),
    post_model.countDocuments({ author_id: KEEP, status: 'active' }, opts())
  ]);
  note(`  mates=${mates} followers=${followers} following=${following} posts=${posts}`);
  if (APPLY) {
    await user_model.updateOne(
      { _id: KEEP },
      {
        $set: {
          'stats.mates': mates,
          'stats.followers': followers,
          'stats.following': following,
          'stats.posts': posts
        }
      },
      opts()
    );
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function run() {
  const keeper = await user_model.findById(KEEP, null, opts()).lean() as any;
  const loser = await user_model.findById(LOSE, null, opts()).lean() as any;

  if (!keeper) throw new Error(`--keep user ${KEEP_S} not found`);
  if (!loser) {
    note(`--merge user ${LOSE_S} not found — already merged? nothing to do.`);
    return;
  }

  note('── SUBJECTS ──');
  note(`  KEEP  ${KEEP_S}  auth_id=${keeper.auth_id}  name="${keeper.name}"  created=${keeper.createdAt}`);
  note(`  MERGE ${LOSE_S}  auth_id=${loser.auth_id}  name="${loser.name}"  created=${loser.createdAt}`);

  await mergeConversations();
  await mergeRelationships();
  await mergePostGraph();
  await mergeInbox();
  await mergeMisc();
  await mergeLegacyUserRefs();
  await mergeUserDocuments(keeper, loser);
  await recomputeStats();

  note('\n── DELETE MERGED USER ──');
  note(`  users/${LOSE_S} → DELETE`);
  if (APPLY) await user_model.deleteOne({ _id: LOSE }, opts());
}

/**
 * The cluster is an Atlas M0 (shared tier): individual nodes get restarted or
 * throttled out from under you, which surfaces as a PoolClearedError /
 * MongoNetworkError mid-run. In a transaction that is harmless — the whole
 * merge aborts and the database is untouched — so the only correct response is
 * to start over rather than to leave the merge unfinished.
 */
const TRANSIENT = /PoolCleared|MongoNetworkError|ECONNREFUSED|ETIMEDOUT|not primary|node is recovering|TransientTransactionError|UnknownReplWriteConcern/i;

function isTransient(e: any): boolean {
  const labels: string[] = e?.errorLabels ?? [...(e?.errorLabelSet ?? [])];
  if (labels.includes('TransientTransactionError') || labels.includes('RetryableWriteError')) return true;
  return TRANSIENT.test(`${e?.name} ${e?.message} ${e?.cause?.message ?? ''}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attempt(): Promise<void> {
  log.length = 0; // a retry re-derives every number from the current DB state
  if (APPLY && USE_TX) {
    session = await mongoose.startSession();
    try {
      await session.withTransaction(run);
    } finally {
      await session.endSession();
      session = null;
    }
  } else {
    await run();
  }
}

async function main() {
  const url = process.env.mongo;
  if (!url) throw new Error('No mongo url in env');

  await mongoose.connect(url, {
    dbName: DB_NAME,
    // Ride out a node flapping instead of failing the run on the first blip.
    serverSelectionTimeoutMS: 30_000,
    socketTimeoutMS: 120_000,
    retryWrites: true,
    retryReads: true
  });
  console.log(`connected (db=${DB_NAME}) — mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no writes)'}\n`);

  const MAX_ATTEMPTS = 5;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    try {
      await attempt();
      break;
    } catch (e) {
      // Retrying is only safe because the transaction guarantees the failed
      // attempt wrote nothing. Without one, a half-applied merge must not be
      // replayed on top of itself — stop and let a human look.
      if (APPLY && !USE_TX) throw e;
      if (i === MAX_ATTEMPTS || !isTransient(e)) throw e;
      const backoff = 2_000 * i;
      console.warn(
        `\ntransient cluster error on attempt ${i}/${MAX_ATTEMPTS} — ` +
        `${(e as Error).message.split('\n')[0]}`
      );
      console.warn(`transaction aborted, nothing written. retrying in ${backoff / 1000}s...\n`);
      await sleep(backoff);
    }
  }

  console.log(
    APPLY
      ? '\nWRITTEN.'
      : '\nDRY RUN — nothing written. Re-run with --apply.'
  );

  // The cluster has a member that refuses connections; tearing the pool down
  // surfaces that as an ECONNREFUSED after the transaction has committed.
  // Failing here would report a successful merge as a failure.
  try {
    await mongoose.disconnect();
  } catch (e) {
    console.warn('warning: disconnect failed (merge already committed):', (e as Error).message);
  }
}

main().catch(async (e) => {
  console.error('\nFAILED:', e);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
