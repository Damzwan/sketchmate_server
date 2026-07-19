import 'dotenv/config';
import mongoose from 'mongoose';
import { relationship_model } from '../models/relationship.model';
import { user_model } from '../models/user.model';

/**
 * READ-ONLY audit. Writes nothing, ever — run it against prod freely.
 *
 *   pnpm ts-node src/scripts/audit-relationship-integrity.ts
 *
 * Reports three things:
 *
 *   1. Duplicate relationships — more than one document for the same pair of
 *      users. Caused by the old chat.service write path, which read the pair
 *      with an order-insensitive `$all` but upserted with an order-SENSITIVE
 *      exact array match, so an unsorted `users` array was found by the read
 *      and missed by the write. Each duplicate can carry its own
 *      'pending_invite', which is what surfaced as repeat invitations.
 *
 *   2. Unsorted `users` arrays — the precondition for (1). Present-tense risk
 *      even after the write path is fixed, because several call sites still
 *      query the pair with an exact match.
 *
 *   3. stats.mates drift — users whose stored counter disagrees with the number
 *      of relationships actually in 'mate'. Negative values are called out
 *      separately: those come from the old /unfriend path, which decremented
 *      without a floor and without serialising the read-then-write, so two
 *      overlapping unfriends both fired -1 against a single +1.
 *
 * Nothing here mutates. Fixing is a separate, deliberate step — see the
 * suggested remedies printed at the end.
 */

const SAMPLE = 20;

async function main() {
  const url = process.env.mongo;
  if (!url) throw new Error('No mongo url in env');

  await mongoose.connect(url, { dbName: 'prod' });
  console.log('connected\n');

  // ── 1. Duplicate pairs ────────────────────────────────────────────────────
  // Group on the SORTED pair so an unsorted document still collides with its
  // sorted twin — grouping on the raw array would file them as two clean pairs
  // and report zero duplicates, which is exactly the blind spot that let this
  // through.
  const dupes = await relationship_model.aggregate([
    {
      $group: {
        _id: {
          $sortArray: { input: '$users', sortBy: 1 }
        },
        count: { $sum: 1 },
        ids: { $push: '$_id' },
        statuses: { $push: '$chat_status' },
        conversation_ids: { $push: '$conversation_id' }
      }
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
  ]).allowDiskUse(true);

  console.log('── 1. DUPLICATE RELATIONSHIP PAIRS ──');
  console.log(`pairs with more than one document: ${dupes.length}`);
  if (dupes.length) {
    const extra = dupes.reduce((n, d) => n + d.count - 1, 0);
    console.log(`redundant documents in total:     ${extra}`);
    console.log(`\nfirst ${Math.min(SAMPLE, dupes.length)}:`);
    for (const d of dupes.slice(0, SAMPLE)) {
      console.log(
        `  users=[${d._id.join(', ')}] count=${d.count} ` +
        `statuses=[${d.statuses.join(', ')}] ids=[${d.ids.join(', ')}]`
      );
    }
  }

  // ── 2. Unsorted users arrays ──────────────────────────────────────────────
  const unsorted = await relationship_model.aggregate([
    {
      $match: {
        $expr: {
          $ne: ['$users', { $sortArray: { input: '$users', sortBy: 1 } }]
        }
      }
    },
    { $project: { users: 1, chat_status: 1 } }
  ]).allowDiskUse(true);

  console.log('\n── 2. UNSORTED `users` ARRAYS ──');
  console.log(`documents stored out of sort order: ${unsorted.length}`);
  for (const u of unsorted.slice(0, SAMPLE)) {
    console.log(`  _id=${u._id} users=[${u.users.join(', ')}] status=${u.chat_status}`);
  }

  // ── 3. stats.mates drift ──────────────────────────────────────────────────
  // The counter is meant to track relationships in 'mate' only. /network/mates
  // additionally shows pending_mate and unexpired temporary, but those are a
  // display concern and were never counted here.
  const actualMates = await relationship_model.aggregate([
    { $match: { chat_status: 'mate' } },
    { $unwind: '$users' },
    { $group: { _id: '$users', mates: { $sum: 1 } } }
  ]).allowDiskUse(true);

  const actualById = new Map<string, number>(
    actualMates.map((m) => [m._id.toString(), m.mates])
  );

  const users = await user_model
    .find({}, { name: 1, 'stats.mates': 1 })
    .lean();

  const negative: any[] = [];
  const drifted: any[] = [];

  for (const u of users) {
    const stored = (u as any).stats?.mates ?? 0;
    const actual = actualById.get(u._id.toString()) ?? 0;
    if (stored < 0) negative.push({ _id: u._id, name: (u as any).name, stored, actual });
    else if (stored !== actual) drifted.push({ _id: u._id, name: (u as any).name, stored, actual });
  }

  console.log('\n── 3. stats.mates INTEGRITY ──');
  console.log(`users scanned:            ${users.length}`);
  console.log(`NEGATIVE stats.mates:     ${negative.length}`);
  console.log(`non-negative but drifted: ${drifted.length}`);

  if (negative.length) {
    console.log(`\nnegative, first ${Math.min(SAMPLE, negative.length)}:`);
    for (const n of negative.slice(0, SAMPLE)) {
      console.log(`  _id=${n._id} name=${n.name} stored=${n.stored} actual=${n.actual}`);
    }
  }
  if (drifted.length) {
    console.log(`\ndrifted, first ${Math.min(SAMPLE, drifted.length)}:`);
    for (const d of drifted.slice(0, SAMPLE)) {
      console.log(`  _id=${d._id} name=${d.name} stored=${d.stored} actual=${d.actual}`);
    }
  }

  console.log('\n── SUGGESTED REMEDIES (not applied by this script) ──');
  console.log('  1/2. For each duplicate pair keep the document with the most');
  console.log('       meaningful chat_status (mate > pending_mate > temporary >');
  console.log('       pending_invite > expired > none) and the one whose');
  console.log('       conversation_id has messages; merge `follows` from the');
  console.log('       losers; delete the rest; re-sort any unsorted `users`.');
  console.log('  3.   stats.mates is fully derivable — recompute it from the');
  console.log('       `actual` column above rather than nudging by a delta.');

  await mongoose.disconnect();
  console.log('\ndone');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
