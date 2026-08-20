import 'dotenv/config';
import mongoose, { Types } from 'mongoose';

/**
 * Read-only dump of one user's chat state. Writes nothing, ever.
 *
 *   pnpm ts-node src/scripts/inspect-chat-state.ts --user <id> [--id <suspect_id>]
 *
 * Everything here goes through the RAW driver, deliberately. The whole class of
 * bug it is looking for is a type mismatch between what a document stores and
 * what a query asks for: mongoose casts a query against the schema, so a
 * `participants` array holding strings is invisible to `find({ participants:
 * <ObjectId> })` while `findById` on the same document still works. Query it
 * through mongoose and the mismatch reads back as "no such document", which is
 * exactly the answer that sent the last investigation the wrong way.
 */

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const USER = arg('user');
const SUSPECT = arg('id');
const DB_NAME = arg('db') ?? 'prod';

if (!USER || !Types.ObjectId.isValid(USER)) {
  console.error('usage: --user <user_id> [--id <suspect_id>] [--db prod]');
  process.exit(1);
}

const OID = new Types.ObjectId(USER);
const STR = OID.toString();

const ACTIVE_CHAT_STATUSES = ['temporary', 'mate', 'pending_mate', 'pending_invite', 'expired', 'blocked'];

const typeOf = (v: any) =>
  v instanceof mongoose.Types.ObjectId ? 'ObjectId' : v === null ? 'null' : typeof v;

const short = (d?: Date | null) => (d ? new Date(d).toISOString().slice(0, 16) : '—');

async function main() {
  const url = process.env.mongo;
  if (!url) throw new Error('No mongo url in env');
  await mongoose.connect(url, { dbName: DB_NAME, serverSelectionTimeoutMS: 30_000 });
  const db = mongoose.connection.db!;

  const users = db.collection('users');
  const conversations = db.collection('conversations');
  const relationships = db.collection('relationships');
  const messages = db.collection('messages');

  const me = await users.findOne({ _id: OID as any }, { projection: { name: 1 } });
  console.log(`\nuser ${STR} — ${me ? (me as any).name : 'NOT FOUND'}  (db=${DB_NAME})`);

  // -------------------------------------------------------------------------
  // A. What is the suspect id, if one was passed
  // -------------------------------------------------------------------------
  if (SUSPECT) {
    console.log(`\n── SUSPECT ID ${SUSPECT} ──`);
    for (const [label, coll] of [
      ['users', users],
      ['conversations', conversations],
      ['relationships', relationships],
      ['messages', messages]
    ] as const) {
      const byOid = Types.ObjectId.isValid(SUSPECT)
        ? await coll.findOne({ _id: new Types.ObjectId(SUSPECT) as any })
        : null;
      const byStr = await coll.findOne({ _id: SUSPECT as any });
      if (byOid || byStr) {
        console.log(`  found in ${label} (${byOid ? '_id is ObjectId' : '_id is STRING'})`);
        console.log(`    ${JSON.stringify(byOid ?? byStr).slice(0, 400)}`);
      }
    }
    const msgCount = Types.ObjectId.isValid(SUSPECT)
      ? await messages.countDocuments({ conversation_id: new Types.ObjectId(SUSPECT) as any })
      : 0;
    const msgCountStr = await messages.countDocuments({ conversation_id: SUSPECT as any });
    console.log(`  messages with this conversation_id: ${msgCount} as ObjectId, ${msgCountStr} as string`);
  }

  // -------------------------------------------------------------------------
  // B. Conversations, matched both ways
  // -------------------------------------------------------------------------
  console.log('\n── CONVERSATIONS CONTAINING ME ──');
  const asOid = await conversations.find({ participants: OID as any }).toArray();
  const asStr = await conversations.find({ participants: STR as any }).toArray();
  console.log(`  matched by ObjectId: ${asOid.length}`);
  console.log(`  matched by STRING:   ${asStr.length}   <-- anything here is invisible to the API`);

  for (const conv of [...asOid, ...asStr]) {
    const count = await messages.countDocuments({ conversation_id: conv._id as any });
    const types = (conv as any).participants.map(typeOf).join(',');
    const rel = await relationships.findOne({ conversation_id: conv._id as any });
    console.log(
      `  conv ${conv._id}  participants[${types}]  size=${(conv as any).participants.length}  ` +
      `msgs=${count}  deleted_at=${short((conv as any).deleted_at)}  ` +
      `updatedAt=${short((conv as any).updatedAt)}  rel=${rel ? rel._id : 'NONE POINTS HERE'}`
    );
  }

  // -------------------------------------------------------------------------
  // C. Relationships, and what /chats/shell does with each
  // -------------------------------------------------------------------------
  console.log('\n── RELATIONSHIPS (as /chats/shell sees them) ──');
  const relsOid = await relationships.find({ users: OID as any }).toArray();
  const relsStr = await relationships.find({ users: STR as any }).toArray();
  console.log(`  matched by ObjectId: ${relsOid.length}, by STRING: ${relsStr.length}`);

  for (const rel of [...relsOid, ...relsStr] as any[]) {
    const partner = rel.users.map(String).find((u: string) => u !== STR);
    const inShellQuery = ACTIVE_CHAT_STATUSES.includes(rel.chat_status);
    const conv = rel.conversation_id
      ? await conversations.findOne({ _id: rel.conversation_id })
      : null;

    // The exact second half of the /shell query: _id in the list AND
    // participants contains me. A conversation can pass the first and fail the
    // second, which is the case that produces a silently missing chat.
    const passesParticipantFilter = conv
      ? await conversations.findOne({ _id: conv._id, participants: OID as any })
      : null;

    let verdict: string;
    if (!inShellQuery) verdict = `DROPPED: status '${rel.chat_status}' not in ACTIVE_CHAT_STATUSES`;
    else if (!rel.conversation_id) verdict = 'DROPPED: relationship has no conversation_id';
    else if (!conv) verdict = 'DROPPED: conversation_id points at a missing document';
    else if (!passesParticipantFilter) verdict = 'DROPPED: conversation exists but `participants` does not match my ObjectId';
    else verdict = 'shown';

    if (verdict === 'shown' && !SUSPECT) continue; // only noise unless we are dumping everything

    console.log(
      `  rel ${rel._id}  partner=${partner}  status=${rel.chat_status}  ` +
      `users[${rel.users.map(typeOf).join(',')}]  deleted_at=${short(rel.deleted_at)}  ` +
      `conv=${rel.conversation_id ?? '—'}\n      → ${verdict}`
    );
  }

  // -------------------------------------------------------------------------
  // D. Every conversation_id my messages actually carry
  // -------------------------------------------------------------------------
  console.log('\n── CONVERSATION IDS IN MY MESSAGES ──');
  const ids = await messages.distinct('conversation_id', { sender_id: OID as any });
  const idsStr = await messages.distinct('conversation_id', { sender_id: STR as any });
  console.log(`  distinct ids (sender as ObjectId): ${ids.length}, (sender as string): ${idsStr.length}`);

  for (const id of [...ids, ...idsStr]) {
    const conv = await conversations.findOne({ _id: id as any });
    const count = await messages.countDocuments({ conversation_id: id as any });
    const newest = await messages
      .find({ conversation_id: id as any })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    const rel = await relationships.findOne({ conversation_id: id as any });
    console.log(
      `  ${id}  msgs=${count}  last=${short(newest[0]?.createdAt)}  ` +
      `conv=${conv ? `exists participants[${(conv as any).participants.map(typeOf).join(',')}]` : 'MISSING'}  ` +
      `rel=${rel ? rel._id : 'none'}`
    );
  }

  console.log('\nread-only — nothing was written.\n');
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('\nFAILED:', e);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
