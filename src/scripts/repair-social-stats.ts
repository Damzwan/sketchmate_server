import 'dotenv/config';
import mongoose from 'mongoose';
import { relationship_model } from '../models/relationship.model';
import { user_model } from '../models/user.model';

/**
 * Recomputes stats.mates / stats.followers / stats.following for every user
 * from the relationship collection, which is the only real source of truth.
 *
 *   DRY RUN (default — writes nothing, prints what it would change):
 *     pnpm ts-node src/scripts/repair-social-stats.ts
 *
 *   APPLY:
 *     pnpm ts-node src/scripts/repair-social-stats.ts --apply
 *
 * Why recompute rather than nudge by a delta: the counters drifted because they
 * were maintained incrementally by several call sites that didn't agree on when
 * to fire. Adding another delta on top preserves whatever error is already
 * there. A full recompute is idempotent — run it twice and the second run is a
 * no-op — and it's cheap because every number is a plain count.
 *
 * `stats.posts` is deliberately NOT touched. Nothing in the audit implicated
 * it, and it's derived from a different collection.
 *
 * Run AFTER deploying the syncAndFinalizeMigrationStats fix. Run it before and
 * un-migrated users will simply re-drift on their next GET /user.
 */

const APPLY = process.argv.includes('--apply');
const BATCH = 1000;
const SAMPLE = 25;

/** One aggregation per counter, over relationships. 3 passes, not 135k×3 queries. */
async function tally(
  match: Record<string, unknown>,
  unwindPath: string,
  idPath: string
): Promise<Map<string, number>> {
  const rows = await relationship_model.aggregate([
    { $match: match },
    ...(unwindPath ? [{ $unwind: unwindPath }] : []),
    { $group: { _id: idPath, n: { $sum: 1 } } }
  ]).allowDiskUse(true);

  return new Map(rows.map((r) => [String(r._id), r.n]));
}

async function main() {
  const url = process.env.mongo;
  if (!url) throw new Error('No mongo url in env');

  await mongoose.connect(url, { dbName: 'prod' });
  console.log(`connected — mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no writes)'}\n`);

  console.log('tallying from relationships...');

  // mates: a relationship currently in 'mate', counted for both participants.
  const mates = await tally({ chat_status: 'mate' }, '$users', '$users');

  // followers / following: one entry per follow edge. `follows` is maintained
  // with $addToSet, so an edge can't be double-counted.
  const followers = await tally({ 'follows.0': { $exists: true } }, '$follows', '$follows.followed');
  const following = await tally({ 'follows.0': { $exists: true } }, '$follows', '$follows.follower');

  console.log(
    `  users with >=1 mate: ${mates.size}, ` +
    `with >=1 follower: ${followers.size}, ` +
    `following >=1: ${following.size}\n`
  );

  const cursor = user_model
    .find({}, { 'stats.mates': 1, 'stats.followers': 1, 'stats.following': 1, name: 1 })
    .lean()
    .cursor();

  let scanned = 0;
  let changed = 0;
  let negativesFixed = 0;
  const samples: string[] = [];
  let ops: any[] = [];

  const flush = async () => {
    if (!ops.length) return;
    if (APPLY) await user_model.bulkWrite(ops, { ordered: false });
    ops = [];
  };

  for await (const u of cursor) {
    scanned++;
    const id = String(u._id);
    const s = (u as any).stats ?? {};

    const storedMates = s.mates ?? 0;
    const storedFollowers = s.followers ?? 0;
    const storedFollowing = s.following ?? 0;

    const nextMates = mates.get(id) ?? 0;
    const nextFollowers = followers.get(id) ?? 0;
    const nextFollowing = following.get(id) ?? 0;

    if (
      storedMates === nextMates &&
      storedFollowers === nextFollowers &&
      storedFollowing === nextFollowing
    ) continue;

    changed++;
    if (storedMates < 0 || storedFollowers < 0 || storedFollowing < 0) negativesFixed++;

    if (samples.length < SAMPLE) {
      samples.push(
        `  ${id} ${(u as any).name}  ` +
        `mates ${storedMates}→${nextMates}  ` +
        `followers ${storedFollowers}→${nextFollowers}  ` +
        `following ${storedFollowing}→${nextFollowing}`
      );
    }

    ops.push({
      updateOne: {
        filter: { _id: u._id },
        // Dotted paths so stats.posts (and anything later added to the schema)
        // survives untouched.
        update: {
          $set: {
            'stats.mates': nextMates,
            'stats.followers': nextFollowers,
            'stats.following': nextFollowing
          }
        }
      }
    });

    if (ops.length >= BATCH) await flush();
  }

  await flush();

  console.log(`first ${Math.min(SAMPLE, samples.length)} changes:`);
  samples.forEach((l) => console.log(l));

  console.log('\n── SUMMARY ──');
  console.log(`users scanned:           ${scanned}`);
  console.log(`users needing repair:    ${changed}`);
  console.log(`  of which had negatives: ${negativesFixed}`);
  console.log(APPLY ? '\nWRITTEN.' : '\nDRY RUN — nothing written. Re-run with --apply.');

  await mongoose.disconnect();
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
