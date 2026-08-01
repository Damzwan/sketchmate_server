import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
// Deliberately mongoose's bundled driver, not the top-level `mongodb` dep:
// the two are different major versions here, and an ObjectId minted by bson 5
// is rejected by mongoose's bson 6 serializer ("Unsupported BSON version").
const { ObjectId, EJSON } = mongoose.mongo.BSON;

/**
 * Targeted backup / restore for merge-user-accounts.ts.
 *
 *   DUMP (read-only on the DB, writes JSON to disk):
 *     pnpm ts-node src/scripts/backup-user-merge.ts --keep <id> --merge <id>
 *
 *   RESTORE (undo a merge):
 *     pnpm ts-node src/scripts/backup-user-merge.ts --restore backups/<dir> --apply
 *
 * Dumps every document in every collection that references either account, in
 * EJSON so ObjectIds, Dates and Maps survive the round trip. That is a superset
 * of what the merge touches, which is what makes it a usable undo: the merge
 * only ever updates or deletes, never inserts, so replaying the snapshot with
 * upserts puts every affected document back exactly as it was.
 *
 * RESTORE CAVEAT: it is a point-in-time rollback of the snapshotted documents.
 * Anything that happened to those same documents AFTER the dump — new messages
 * in a merged conversation, a fresh reaction — is rolled back with them. Take
 * the dump immediately before applying the merge, and restore promptly if you
 * are going to restore at all.
 */

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};

const APPLY = argv.includes('--apply');
const DB_NAME = arg('db') ?? 'prod';
const RESTORE_DIR = arg('restore');
const OUT_ROOT = arg('out') ?? path.join(process.cwd(), 'backups');

// ---------------------------------------------------------------------------
// DUMP
// ---------------------------------------------------------------------------
async function dump(db: any, keepArg: string, mergeArg: string) {
  const KEEP = new ObjectId(keepArg);
  const LOSE = new ObjectId(mergeArg);
  // Fields are inconsistently typed across the schema history (inbox.followers
  // is declared [String] but written as ObjectIds), so every filter matches
  // both shapes.
  const ids = [KEEP, LOSE, keepArg, mergeArg];
  const any = { $in: ids };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(OUT_ROOT, `user-merge-${keepArg}-${mergeArg}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  // Conversations first — messages are pulled by conversation_id as well as by
  // sender, since the merge rewrites conversation_id on messages the user did
  // not send (the other person's half of a merged thread).
  const convIds = (await db.collection('conversations')
    .find({ participants: any }, { projection: { _id: 1 } }).toArray())
    .map((c: any) => c._id);

  const reactionPostIds = (await db.collection('post_reactions')
    .find({ user_id: any }, { projection: { post_id: 1 } }).toArray())
    .map((r: any) => r.post_id);

  const plan: Array<[string, Record<string, unknown>]> = [
    ['users', { $or: [
      { _id: any },
      { 'mates._id': any },
      { mate_requests_sent: any },
      { mate_requests_received: any }
    ] }],
    ['relationships', { $or: [
      { users: any },
      { action_user_id: any },
      { blocked_by: any },
      { 'follows.follower': any },
      { 'follows.followed': any },
      { 'mate_requests.requester': any }
    ] }],
    ['conversations', { participants: any }],
    ['messages', { $or: [{ sender_id: any }, { conversation_id: { $in: convIds } }] }],
    // Posts are included both as authored content and as reaction targets —
    // the merge decrements reaction_counts/total_reactions on collision.
    ['posts', { $or: [{ author_id: any }, { _id: { $in: reactionPostIds } }] }],
    ['post_comments', { author_id: any }],
    ['post_reactions', { user_id: any }],
    ['post_views', { user_id: any }],
    ['inbox', { $or: [
      { sender: any },
      { followers: any },
      { original_followers: any },
      { seen_by: any },
      { comments_seen_by: any },
      { 'comments.sender': any }
    ] }],
    ['inbox_comments', { sender: any }],
    ['balloon', { $or: [{ sender: any }, { pairedUser: any }, { rejected_by: any }] }],
    ['notifications', { $or: [{ recipient_id: any }, { 'actors._id': any }] }],
    ['reports', { $or: [{ reporter_id: any }, { target_author_id: any }, { resolved_by: any }] }],
    ['moderation_actions', { $or: [{ user_id: any }, { admin_id: any }] }],
    ['saved_drawings', { user_id: any }],
    ['quotausages', { user_id: any }],
    ['deletionqueues', { target_id: any }]
  ];

  const counts: Record<string, number> = {};
  let total = 0;

  for (const [name, filter] of plan) {
    const docs = await db.collection(name).find(filter).toArray();
    counts[name] = docs.length;
    total += docs.length;
    fs.writeFileSync(
      path.join(dir, `${name}.json`),
      EJSON.stringify(docs, undefined, 2, { relaxed: false })
    );
    console.log(`  ${name.padEnd(20)} ${docs.length}`);
  }

  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      created_at: new Date().toISOString(),
      db: DB_NAME,
      keep: keepArg,
      merge: mergeArg,
      collections: counts,
      total
    }, null, 2)
  );

  console.log(`\n${total} document(s) written to ${dir}`);
  console.log('restore with:');
  console.log(`  pnpm ts-node src/scripts/backup-user-merge.ts --restore ${path.relative(process.cwd(), dir)} --apply`);
}

// ---------------------------------------------------------------------------
// RESTORE
// ---------------------------------------------------------------------------
async function restore(db: any, dir: string) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`no manifest.json in ${dir}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  console.log(`snapshot from ${manifest.created_at} (db=${manifest.db})`);
  console.log(`keep=${manifest.keep} merge=${manifest.merge}`);
  if (manifest.db !== DB_NAME) {
    throw new Error(`snapshot db "${manifest.db}" != target db "${DB_NAME}" — refusing`);
  }
  console.log(APPLY ? '\nRESTORING (writes)\n' : '\nDRY RUN — pass --apply to write\n');

  let restored = 0;
  for (const name of Object.keys(manifest.collections)) {
    const file = path.join(dir, `${name}.json`);
    if (!fs.existsSync(file)) continue;
    const docs: any[] = EJSON.parse(fs.readFileSync(file, 'utf8')) as any;
    if (!docs.length) continue;

    // replaceOne+upsert, one document at a time: puts deleted documents back
    // and reverts modified ones in a single pass, and stays correct if the
    // merge only partially applied.
    if (APPLY) {
      await db.collection(name).bulkWrite(
        docs.map((d) => ({
          replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true }
        })),
        { ordered: false }
      );
    }
    restored += docs.length;
    console.log(`  ${name.padEnd(20)} ${docs.length}`);
  }

  console.log(`\n${restored} document(s) ${APPLY ? 'restored' : 'would be restored'}`);
  if (APPLY) {
    console.log('note: documents created after the snapshot are untouched; changes made');
    console.log('to snapshotted documents after the snapshot are rolled back.');
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const url = process.env.mongo;
  if (!url) throw new Error('No mongo url in env');

  await mongoose.connect(url, { dbName: DB_NAME });
  const db = mongoose.connection.db as any;
  console.log(`connected (db=${DB_NAME})\n`);

  if (RESTORE_DIR) {
    await restore(db, path.resolve(RESTORE_DIR));
  } else {
    const keep = arg('keep');
    const merge = arg('merge');
    if (!keep || !merge) {
      throw new Error('usage: --keep <id> --merge <id>   |   --restore <dir> --apply');
    }
    await dump(db, keep, merge);
  }

  // The cluster has a member that refuses connections; tearing the pool down
  // surfaces that as an ECONNREFUSED long after the work is committed. Failing
  // the process there would misreport a finished run as a failed one.
  try {
    await mongoose.disconnect();
  } catch (e) {
    console.warn('warning: disconnect failed (work already completed):', (e as Error).message);
  }
}

main().catch(async (e) => {
  console.error('\nFAILED:', e);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
