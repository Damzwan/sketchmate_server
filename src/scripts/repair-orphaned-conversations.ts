import 'dotenv/config';
import mongoose, { Types } from 'mongoose';

import { relationship_model } from '../models/relationship.model';
import { conversation_model } from '../models/conversation.model';
import { message_model } from '../models/message.model';

/**
 * Repairs chats that lost their conversation document.
 *
 *   DRY RUN (default — writes nothing, prints every planned change):
 *     pnpm ts-node src/scripts/repair-orphaned-conversations.ts
 *
 *   APPLY:
 *     pnpm ts-node src/scripts/repair-orphaned-conversations.ts --apply
 *
 *   One account only (the fastest way to unblock a specific report):
 *     pnpm ts-node src/scripts/repair-orphaned-conversations.ts --user <user_id>
 *
 * WHAT WENT WRONG
 *
 * `deleted_at` on relationships and conversations is not a soft-delete flag —
 * both schemas carry a TTL index on it, so it is a scheduled deletion. PUT
 * /unfriend stamped both documents with now+30d. Every path that revived the
 * pair afterwards (accepting an invite, accepting a mate request, sending a new
 * message) cleared the RELATIONSHIP's stamp and left the CONVERSATION's alone.
 *
 * So a pair who fell out and made up kept a working chat for the rest of the 30
 * day window, and then mongo deleted the conversation out from under them. The
 * relationship survived pointing at a dead _id, GET /chats/shell skipped it
 * (no conversation, no row), and because the overview is what the client uses to
 * decide whether a chat exists, tapping the partner opened a chat head keyed by
 * USER id — a history request for an id that is not a conversation, so an empty
 * thread. The next message upserted a fresh conversation, everything worked
 * again from that point on, and every message from before the fallout stayed
 * stranded under the old id. Two conversations, one pair.
 *
 * A second, older source of the same split: saveMessageLogic used to look the
 * conversation up with an exact array equality on `participants`, which is order
 * sensitive. Pairs stored the other way round were missed and duplicated.
 *
 * Both are fixed in the code now. This repairs the data they left behind.
 *
 * WHAT IT DOES
 *
 *   1. Defuses live tombstones: a conversation still carrying `deleted_at` whose
 *      relationship is alive. These are the chats that have not broken YET.
 *   2. Merges duplicate conversations for the same pair into one thread.
 *   3. Writes back the relationship -> conversation link where it was never set:
 *      relationships created in bulk from the legacy `user.mates` array have no
 *      `conversation_id`, and /chats/shell walks relationship -> conversation_id
 *      -> conversation, so those chats are missing from the overview no matter
 *      how many messages the thread holds.
 *   4. Rebuilds conversations that were already reaped, reusing the SAME _id so
 *      the orphaned messages reattach themselves and any client cache, push
 *      payload or deep link holding that id keeps working.
 *   5. Reattaches leftover orphan messages whose conversation is gone and whose
 *      pair can be established from the senders.
 *
 * Idempotent: a second run finds nothing to do. Safe to run on a live server —
 * every write is per pair, there is no global lock, and nothing is deleted
 * except duplicate conversation documents whose messages have already been moved.
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
const INCLUDE_INACTIVE = argv.includes('--include-inactive');
const REATTACH_ORPHANS = argv.includes('--reattach-orphans');
const DB_NAME = arg('db') ?? 'prod';
const ONLY_USER = arg('user');

if (ONLY_USER && !Types.ObjectId.isValid(ONLY_USER)) {
  console.error(`--user ${ONLY_USER} is not a valid ObjectId`);
  process.exit(1);
}

const ONLY = ONLY_USER ? new Types.ObjectId(ONLY_USER) : null;

/** Mirrors ACTIVE_CHAT_STATUSES in api/router/chat.router.ts. */
const ACTIVE_CHAT_STATUSES = ['temporary', 'mate', 'pending_mate', 'pending_invite', 'expired', 'blocked'];

/**
 * Statuses whose chats a user is currently supposed to see.
 *
 * Linking a relationship back to its conversation makes that chat appear in the
 * overview again, and /chats/shell treats `expired` and `blocked` as visible.
 * Restoring a thread with a current mate is obviously right; silently
 * resurfacing hundreds of long-dead chats — including ones with people the user
 * BLOCKED — is not something a repair script should decide on its own. Those are
 * reported and skipped unless --include-inactive says otherwise.
 */
const LIVE_CHAT_STATUSES = ['temporary', 'mate', 'pending_mate', 'pending_invite'];

const note = (line: string) => console.log(line);

const stats = {
  tombstones_defused: 0,
  duplicates_merged: 0,
  conversations_rebuilt: 0,
  relationships_linked: 0,
  links_skipped_inactive: 0,
  relationships_repointed: 0,
  messages_moved: 0,
  orphans_left_in_place: 0,
  unresolved: 0
};

/** The pair key every phase groups on, so participant order never matters. */
const pairKey = (participants: any[]) =>
  participants.map(String).sort().join(':');

const sortedPair = (participants: any[]): Types.ObjectId[] =>
  participants
    .map((p) => new Types.ObjectId(String(p)))
    .sort((a, b) => (a.toString() < b.toString() ? -1 : 1));

const relationshipForPair = (participants: any[]) =>
  relationship_model
    .findOne({ users: { $all: sortedPair(participants), $size: 2 } })
    .lean() as any;

const conversationForPair = (participants: any[]) =>
  conversation_model
    .findOne({ participants: { $all: sortedPair(participants), $size: 2 } })
    .lean() as any;

const relationshipIsAlive = (rel: any) =>
  !!rel && !rel.deleted_at && ACTIVE_CHAT_STATUSES.includes(rel.chat_status);

// ---------------------------------------------------------------------------
// 1. TOMBSTONES THAT HAVE NOT FIRED YET
// ---------------------------------------------------------------------------
async function defuseTombstones() {
  note('\n── 1. LIVE TOMBSTONES ──');

  const filter: any = { deleted_at: { $ne: null } };
  if (ONLY) filter.participants = ONLY;

  const stamped = await conversation_model.find(filter).lean() as any[];
  note(`  conversations carrying deleted_at: ${stamped.length}`);

  for (const conv of stamped) {
    const rel = await relationshipForPair(conv.participants);

    if (!relationshipIsAlive(rel)) {
      // A genuine pending deletion: the two of them have not made up. Leaving
      // it alone is the point — this script defuses accidents, not decisions.
      continue;
    }

    note(`  conv ${conv._id} (rel ${rel._id}, ${rel.chat_status}) → clear deleted_at (was ${conv.deleted_at.toISOString()})`);
    stats.tombstones_defused++;

    if (APPLY) {
      await conversation_model.updateOne({ _id: conv._id }, { $unset: { deleted_at: '' } });
    }
  }
}

// ---------------------------------------------------------------------------
// 2. DUPLICATE CONVERSATIONS FOR ONE PAIR
// ---------------------------------------------------------------------------
async function mergeDuplicates() {
  note('\n── 2. DUPLICATE CONVERSATIONS ──');

  const filter: any = { participants: { $size: 2 } };
  if (ONLY) filter.participants = { $all: [ONLY], $size: 2 };

  const byPair = new Map<string, any[]>();
  const cursor = conversation_model.find(filter).lean().cursor();

  for await (const conv of cursor as any) {
    const key = pairKey(conv.participants);
    const list = byPair.get(key);
    if (list) list.push(conv);
    else byPair.set(key, [conv]);
  }

  const duplicated = [...byPair.values()].filter((list) => list.length > 1);
  note(`  pairs with more than one conversation: ${duplicated.length}`);

  for (const group of duplicated) {
    // Survivor = whichever thread was used most recently. Ties go to the oldest
    // document, so the id that has been around longest is the one that stays.
    const withActivity = await Promise.all(
      group.map(async (conv) => {
        const newest = await message_model
          .findOne({ conversation_id: conv._id })
          .sort({ createdAt: -1 })
          .select('createdAt')
          .lean() as any;
        const count = await message_model.countDocuments({ conversation_id: conv._id });
        return { conv, count, lastAt: newest?.createdAt ?? conv.updatedAt ?? conv.createdAt };
      })
    );

    withActivity.sort((a, b) => {
      const diff = new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime();
      return diff !== 0 ? diff : (a.conv._id.toString() < b.conv._id.toString() ? -1 : 1);
    });

    const survivor = withActivity[0];
    const losers = withActivity.slice(1);

    note(
      `  pair ${pairKey(survivor.conv.participants)}: keep ${survivor.conv._id} ` +
      `(${survivor.count} msg) + merge ${losers.map((l) => `${l.conv._id} (${l.count} msg)`).join(', ')}`
    );
    stats.duplicates_merged += losers.length;

    const counts: Record<string, number> = { ...(survivor.conv.unread_counts ?? {}) };
    for (const loser of losers) {
      for (const [user, n] of Object.entries(loser.conv.unread_counts ?? {})) {
        counts[user] = (counts[user] ?? 0) + (n as number);
      }
      stats.messages_moved += loser.count;
    }

    if (APPLY) {
      for (const loser of losers) {
        await message_model.updateMany(
          { conversation_id: loser.conv._id },
          { $set: { conversation_id: survivor.conv._id } }
        );
        // Deleted before the survivor is normalised below: the unique index on
        // (participants.0, participants.1) would reject a survivor re-sorted
        // into a key a loser still holds.
        await conversation_model.deleteOne({ _id: loser.conv._id });
      }

      const newest = await message_model
        .findOne({ conversation_id: survivor.conv._id })
        .sort({ createdAt: -1 })
        .select('_id createdAt')
        .lean() as any;

      await conversation_model.collection.updateOne(
        { _id: survivor.conv._id },
        {
          $set: {
            participants: sortedPair(survivor.conv.participants),
            unread_counts: counts,
            ...(newest && { last_message: newest._id, updatedAt: newest.createdAt })
          },
          $unset: { deleted_at: '' }
        }
      );

      await relationship_model.updateMany(
        { users: { $all: sortedPair(survivor.conv.participants), $size: 2 } },
        { $set: { conversation_id: survivor.conv._id } }
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. RELATIONSHIPS THAT WERE NEVER LINKED TO THEIR CONVERSATION
// ---------------------------------------------------------------------------
async function linkUnlinkedRelationships() {
  note('\n── 3. UNLINKED RELATIONSHIPS ──');

  const filter: any = {
    conversation_id: null,
    chat_status: { $in: ACTIVE_CHAT_STATUSES }
  };
  if (ONLY) filter.users = ONLY;

  const relationships = await relationship_model.find(filter).lean() as any[];
  note(`  relationships with no conversation_id: ${relationships.length}`);
  note(`  linking statuses: ${(INCLUDE_INACTIVE ? ACTIVE_CHAT_STATUSES : LIVE_CHAT_STATUSES).join(', ')}`);

  let linkable = 0;
  const skippedByStatus: Record<string, number> = {};

  for (const rel of relationships) {
    const conv = await conversationForPair(rel.users);
    // Mates who have never messaged each other genuinely have no thread. Only a
    // relationship whose conversation EXISTS and is simply not referenced is a
    // broken link.
    if (!conv) continue;

    if (!INCLUDE_INACTIVE && !LIVE_CHAT_STATUSES.includes(rel.chat_status)) {
      skippedByStatus[rel.chat_status] = (skippedByStatus[rel.chat_status] ?? 0) + 1;
      stats.links_skipped_inactive++;
      continue;
    }

    const count = await message_model.countDocuments({ conversation_id: conv._id });
    note(`  rel ${rel._id} (${rel.chat_status}) → link to conv ${conv._id} (${count} message(s), hidden from the overview until now)`);
    linkable++;
    stats.relationships_linked++;

    if (APPLY) {
      await relationship_model.updateOne(
        { _id: rel._id, conversation_id: null },
        { $set: { conversation_id: conv._id } }
      );
    }
  }

  note(`  of those, with an existing conversation to link: ${linkable}`);
  if (Object.keys(skippedByStatus).length) {
    const breakdown = Object.entries(skippedByStatus).map(([k, v]) => `${k}=${v}`).join(', ');
    note(`  skipped as not-currently-visible chats (${breakdown}) — pass --include-inactive to link them too`);
  }
}

// ---------------------------------------------------------------------------
// 4. RELATIONSHIPS POINTING AT A CONVERSATION THAT IS GONE
// ---------------------------------------------------------------------------
async function repairDanglingRelationships() {
  note('\n── 4. DANGLING RELATIONSHIPS ──');

  const filter: any = {
    conversation_id: { $ne: null },
    chat_status: { $in: ACTIVE_CHAT_STATUSES },
    deleted_at: null
  };
  if (ONLY) filter.users = ONLY;

  const relationships = await relationship_model.find(filter).lean() as any[];
  let dangling = 0;

  for (const rel of relationships) {
    const exists = await conversation_model.exists({ _id: rel.conversation_id });
    if (exists) continue;
    dangling++;

    const twin = await conversationForPair(rel.users);

    if (twin) {
      // A replacement thread was created by the first message sent after the
      // reap. Fold the stranded history into it and point the relationship there.
      const orphans = await message_model.countDocuments({ conversation_id: rel.conversation_id });
      note(`  rel ${rel._id}: ${rel.conversation_id} is gone → repoint to ${twin._id}, move ${orphans} orphan message(s)`);
      stats.relationships_repointed++;
      stats.messages_moved += orphans;

      if (APPLY) {
        await message_model.updateMany(
          { conversation_id: rel.conversation_id },
          { $set: { conversation_id: twin._id } }
        );
        await relationship_model.updateOne({ _id: rel._id }, { $set: { conversation_id: twin._id } });

        const newest = await message_model
          .findOne({ conversation_id: twin._id })
          .sort({ createdAt: -1 })
          .select('_id createdAt')
          .lean() as any;
        if (newest) {
          await conversation_model.collection.updateOne(
            { _id: twin._id },
            { $set: { last_message: newest._id, updatedAt: newest.createdAt }, $unset: { deleted_at: '' } }
          );
        }
      }
      continue;
    }

    // Nothing replaced it. Rebuild in place, on the same _id, so the messages
    // that still carry it are a thread again.
    await rebuildConversation(rel.conversation_id, rel.users, rel.createdAt);
  }

  note(`  relationships checked: ${relationships.length}, dangling: ${dangling}`);
}

/** Recreates a reaped conversation under its original _id. */
async function rebuildConversation(conversationId: Types.ObjectId, users: any[], fallbackDate?: Date) {
  const participants = sortedPair(users);
  const newest = await message_model
    .findOne({ conversation_id: conversationId })
    .sort({ createdAt: -1 })
    .select('_id createdAt')
    .lean() as any;
  const oldest = await message_model
    .findOne({ conversation_id: conversationId })
    .sort({ createdAt: 1 })
    .select('createdAt')
    .lean() as any;
  const count = await message_model.countDocuments({ conversation_id: conversationId });

  note(`  rebuild conv ${conversationId} for ${participants.map(String).join(' + ')} (${count} message(s) reattached)`);
  stats.conversations_rebuilt++;

  if (!APPLY) return;

  // Raw insert rather than the model: createdAt and updatedAt are the real
  // thread's timestamps, and mongoose's timestamps would stamp them as now,
  // which would shove a years-old thread to the top of every overview.
  await conversation_model.collection.insertOne({
    _id: conversationId as any,
    participants: participants as any,
    unread_counts: {},
    ...(newest && { last_message: newest._id }),
    createdAt: oldest?.createdAt ?? fallbackDate ?? new Date(),
    updatedAt: newest?.createdAt ?? oldest?.createdAt ?? fallbackDate ?? new Date(),
    __v: 0
  } as any);
}

// ---------------------------------------------------------------------------
// 5. ORPHAN MESSAGES NOBODY POINTS AT
// ---------------------------------------------------------------------------
async function reattachOrphanMessages() {
  note('\n── 5. ORPHAN MESSAGES ──');

  // Scoping by sender would hide the other half of every thread and make every
  // group look one-sided, so --user resolves to the conversation ids that user
  // wrote into and then groups ALL messages in them, both directions.
  const match: any = {};
  if (ONLY) {
    const ids = await message_model.distinct('conversation_id', { sender_id: ONLY });
    match.conversation_id = { $in: ids };
  }

  const groups = await message_model.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    {
      $group: {
        _id: '$conversation_id',
        senders: { $addToSet: '$sender_id' },
        count: { $sum: 1 }
      }
    }
  ]);

  let orphanGroups = 0;

  // Report-only unless --reattach-orphans.
  //
  // Orphaned messages are NOT automatically damage. Declining an invite deletes
  // the conversation on purpose (see the decline branch in
  // api/router/relationship.router.ts) and leaves the messages where they are,
  // so a thread with no conversation is the normal end state of a rejected
  // invitation. Rebuilding it resurrects something a person chose to refuse, and
  // where the pair later became mates with a NEW conversation, moving the old
  // messages into it would drop rejected messages into their live chat. That is
  // a worse bug than the one this script exists to fix.
  //
  // Orphaned messages are also invisible: with no conversation, nothing can
  // fetch them. Leaving them costs nothing, so the default is to leave them.
  if (!REATTACH_ORPHANS) {
    note('  report-only (pass --reattach-orphans to act on these)');
  }

  for (const group of groups) {
    if (!group._id) continue;
    const exists = await conversation_model.exists({ _id: group._id });
    if (exists) continue;
    orphanGroups++;

    // Both sides of a thread are recoverable only when both have spoken. A
    // one-sided thread names its sender and nobody else, and guessing the
    // recipient from anything else here would be inventing data.
    const senders = (group.senders ?? []).filter(Boolean);
    if (senders.length !== 2) {
      note(`  conv ${group._id}: ${group.count} message(s), ${senders.length} distinct sender(s) → UNRESOLVED, left in place`);
      stats.unresolved++;
      continue;
    }

    const twin = await conversationForPair(senders);

    if (twin) {
      note(
        `  conv ${group._id}: ${group.count} message(s) → ` +
        (REATTACH_ORPHANS ? `move into ${twin._id}` : `would move into ${twin._id} — SKIPPED`)
      );
      if (!REATTACH_ORPHANS) {
        stats.orphans_left_in_place++;
        continue;
      }
      stats.messages_moved += group.count;
      if (APPLY) {
        await message_model.updateMany(
          { conversation_id: group._id },
          { $set: { conversation_id: twin._id } }
        );
      }
      continue;
    }

    if (!REATTACH_ORPHANS) {
      note(`  conv ${group._id}: ${group.count} message(s), no conversation for the pair → SKIPPED (declined invite, most likely)`);
      stats.orphans_left_in_place++;
      continue;
    }

    await rebuildConversation(group._id, senders);

    if (APPLY) {
      await relationship_model.updateOne(
        { users: { $all: sortedPair(senders), $size: 2 }, conversation_id: null },
        { $set: { conversation_id: group._id } }
      );
    }
  }

  note(`  conversation ids referenced by messages but missing: ${orphanGroups}`);
}

// ---------------------------------------------------------------------------
async function main() {
  const url = process.env.mongo;
  if (!url) throw new Error('No mongo url in env');

  await mongoose.connect(url, {
    dbName: DB_NAME,
    serverSelectionTimeoutMS: 30_000,
    socketTimeoutMS: 120_000,
    retryWrites: true,
    retryReads: true
  });

  console.log(
    `connected (db=${DB_NAME}) — mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no writes)'}` +
    (ONLY ? ` — scoped to user ${ONLY.toString()}` : '')
  );

  // Order matters. Defusing first stops a tombstone firing mid-run; deduping
  // before the dangling sweep means a repointed relationship lands on the
  // merged survivor rather than on a document about to be merged away.
  await defuseTombstones();
  await mergeDuplicates();
  await linkUnlinkedRelationships();
  await repairDanglingRelationships();
  await reattachOrphanMessages();

  console.log('\n── SUMMARY ──');
  for (const [key, value] of Object.entries(stats)) {
    console.log(`  ${key.replace(/_/g, ' ')}: ${value}`);
  }
  console.log(APPLY ? '\nWRITTEN.' : '\nDRY RUN — nothing written. Re-run with --apply.');

  try {
    await mongoose.disconnect();
  } catch (e) {
    console.warn('warning: disconnect failed:', (e as Error).message);
  }
}

main().catch(async (e) => {
  console.error('\nFAILED:', e);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
