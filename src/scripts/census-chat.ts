import 'dotenv/config';
import mongoose from 'mongoose';

/**
 * Read-only census of the chat collections. Writes nothing.
 *
 *   pnpm ts-node src/scripts/census-chat.ts [--db prod]
 *
 * Exists to answer "did we lose conversations?" with counts instead of memory.
 * The load-bearing number is `referenced by a relationship but MISSING`: live
 * relationships pointing at conversations that are gone is what a mass deletion
 * looks like from the inside. Empty conversations disappearing is not the same
 * event — a conversation with no messages carries no history to lose.
 */

const argv = process.argv.slice(2);
const DB_NAME = (() => {
  const i = argv.indexOf('--db');
  return i === -1 ? 'prod' : argv[i + 1];
})();

async function main() {
  const url = process.env.mongo;
  if (!url) throw new Error('No mongo url in env');
  await mongoose.connect(url, { dbName: DB_NAME, serverSelectionTimeoutMS: 30_000 });
  const db = mongoose.connection.db!;

  const conversations = db.collection('conversations');
  const relationships = db.collection('relationships');
  const messages = db.collection('messages');
  const users = db.collection('users');

  console.log(`\ndb=${DB_NAME}\n`);
  console.log('── COUNTS ──');
  for (const [label, coll] of [
    ['users', users],
    ['relationships', relationships],
    ['conversations', conversations],
    ['messages', messages]
  ] as const) {
    console.log(`  ${label.padEnd(16)}${String(await coll.countDocuments({})).padStart(10)}`);
  }

  const now = new Date();
  console.log('\n── CONVERSATIONS ──');
  console.log(`  with deleted_at set:        ${await conversations.countDocuments({ deleted_at: { $ne: null } })}`);
  console.log(`    of those, already due:    ${await conversations.countDocuments({ deleted_at: { $lt: now } })}   <-- TTL will remove these`);

  const withMessages = await messages.distinct('conversation_id');
  console.log(`  distinct ids used by messages: ${withMessages.length}`);

  let missing = 0;
  let missingWithMessages = 0;
  for (const id of withMessages) {
    if (!id) continue;
    if (await conversations.findOne({ _id: id as any }, { projection: { _id: 1 } })) continue;
    missing++;
    missingWithMessages += await messages.countDocuments({ conversation_id: id as any });
  }
  console.log(`  referenced by messages but MISSING: ${missing} (holding ${missingWithMessages} message(s))`);

  console.log('\n── RELATIONSHIPS ──');
  const byStatus = await relationships.aggregate([
    { $group: { _id: '$chat_status', n: { $sum: 1 }, linked: { $sum: { $cond: [{ $ifNull: ['$conversation_id', false] }, 1, 0] } } } },
    { $sort: { n: -1 } }
  ]).toArray();
  for (const row of byStatus) {
    console.log(`  ${String(row._id).padEnd(16)} total=${String(row.n).padStart(7)}  linked=${String(row.linked).padStart(7)}`);
  }

  // The alarm. A live relationship pointing at a conversation that no longer
  // exists is the shape a deletion leaves behind.
  const linked = await relationships
    .find({ conversation_id: { $ne: null } }, { projection: { conversation_id: 1, chat_status: 1 } })
    .toArray();
  let dangling = 0;
  for (const rel of linked) {
    if (await conversations.findOne({ _id: (rel as any).conversation_id }, { projection: { _id: 1 } })) continue;
    dangling++;
  }
  console.log(`\n  referenced by a relationship but MISSING: ${dangling}   <-- must be 0`);

  console.log('\nread-only — nothing was written.\n');
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('\nFAILED:', e);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
