import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import * as admin from 'firebase-admin';
import { loadServiceAccount } from '../firebase-credential';
import { user_model } from '../models/user.model';
import { compareVersions } from '../helper';

/**
 * One-off broadcast: tells users on a given client version that sign-in is
 * temporarily broken and that it's being worked on.
 *
 *   DRY RUN (default — sends nothing, prints the version histogram + audience):
 *     pnpm ts-node src/scripts/announce-outage.ts
 *
 *   CANARY (send to 20 users only, then check your own device):
 *     pnpm ts-node src/scripts/announce-outage.ts --apply --limit=20
 *
 *   FULL SEND:
 *     pnpm ts-node src/scripts/announce-outage.ts --apply
 *
 * Flags:
 *   --version=0.4.3,0.4.2   target these last_seen_versions (comma-separated)
 *   --and-older             also include anything older than the lowest listed version
 *   --all-versions          ignore version entirely (includes users with none recorded)
 *   --only-user=<id>        send to exactly one user id, ignoring the version filter.
 *                           Use this to test against an account you control.
 *   --limit=N               stop after N users
 *   --logged-in-only        skip device tokens flagged logged_out
 *   --reset-ledger          forget who was already notified (allows re-sending)
 *
 * Two things that matter here:
 *
 * 1. It sends a real `notification` block, not the data-only payload the app's
 *    normal pushes use. Data-only messages are rendered by client code; a build
 *    already in users' hands has no branch for an announcement and would drop
 *    it. A `notification` block is drawn by the OS, so it lands on 0.4.3 with
 *    no client change. No `data.type` is attached for the same reason — an
 *    unknown type would just fall through the client's switch.
 *
 * 2. It targets logged-OUT tokens too, by default. `subscriptions[].logged_in`
 *    is set by the client on login. The audience for this message is precisely
 *    the people who could not log in, so filtering on that flag would skip the
 *    ones who most need it. `--logged-in-only` restores the normal behaviour.
 *
 * Every delivered user id is appended to a ledger file, so a re-run after a
 * crash or a partial send resumes instead of double-notifying people.
 */

const APPLY = process.argv.includes('--apply');
const AND_OLDER = process.argv.includes('--and-older');
const ALL_VERSIONS = process.argv.includes('--all-versions');
const LOGGED_IN_ONLY = process.argv.includes('--logged-in-only');
const RESET_LEDGER = process.argv.includes('--reset-ledger');

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const TARGET_VERSIONS = (arg('version') ?? '0.4.3,0.4.2')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const ONLY_USER = arg('only-user');
const LIMIT = Number(arg('limit') ?? Infinity);

// Lowest listed version, so --and-older has an unambiguous floor when several
// versions are targeted.
const OLDEST_TARGET = [...TARGET_VERSIONS].sort((a, b) => compareVersions(a, b))[0];

const LEDGER = path.resolve(__dirname, '../../announce-outage-sent.jsonl');
const FCM_BATCH = 500;      // hard cap on messages per sendEach call
const PAUSE_MS = 250;       // breather between batches

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument'
]);

// Plain language on purpose: no "API key", no "suspension", no "Google".
// Users need to know it isn't their fault, it isn't their phone, and roughly
// when it's over.
const TITLE = 'Sign-in is temporarily down';
const BODY =
  "Sorry! A problem on our end is stopping people from signing in. " +
  "We're on it and expect everything back to normal within a day or two. " +
  'Nothing you made is lost. Thanks for your patience 💛';

const buildMessage = (token: string): admin.messaging.Message => ({
  token,
  notification: { title: TITLE, body: BODY },
  android: {
    priority: 'high',
    notification: {
      priority: 'max',
      // Channel '1' already exists on shipped builds. A new channel id would
      // be dropped by Android on clients that never registered it.
      channelId: '1'
    }
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadLedger(): Set<string> {
  if (RESET_LEDGER || !fs.existsSync(LEDGER)) return new Set();
  const ids = fs
    .readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).user_id as string);
  return new Set(ids);
}

function matchesVersion(v?: string): boolean {
  if (ALL_VERSIONS) return true;
  if (!v) return false;
  if (TARGET_VERSIONS.includes(v)) return true;
  if (!AND_OLDER) return false;
  try {
    return compareVersions(v, OLDEST_TARGET) < 0;
  } catch {
    return false;
  }
}

async function main() {
  const url = process.env.mongo;
  if (!url) throw new Error('No mongo url in env');

  await mongoose.connect(url, { dbName: 'prod' });
  admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount() as any) });

  console.log(`connected — mode: ${APPLY ? 'APPLY (will send)' : 'DRY RUN (sends nothing)'}`);
  const audience = ONLY_USER
    ? `single user ${ONLY_USER} (version filter ignored)`
    : ALL_VERSIONS
      ? 'ALL versions'
      : TARGET_VERSIONS.join(', ') + (AND_OLDER ? ` and anything older than ${OLDEST_TARGET}` : ' exactly');
  console.log(
    `audience: ${audience}, tokens: ${LOGGED_IN_ONLY ? 'logged-in only' : 'logged-in AND logged-out'}\n`
  );

  // Histogram first. last_seen_version is written by the client, so it can be
  // missing on plenty of accounts — worth seeing before sending anything.
  const histogram = await user_model.aggregate([
    { $group: { _id: '$last_seen_version', users: { $sum: 1 } } },
    { $sort: { users: -1 } }
  ]);
  console.log('last_seen_version across all users:');
  histogram.forEach((h) =>
    console.log(`  ${String(h._id ?? '(none recorded)').padEnd(20)} ${h.users}`)
  );
  console.log('');

  const ledger = loadLedger();
  if (ledger.size) console.log(`ledger: ${ledger.size} user(s) already notified — skipping them\n`);

  const cursor = user_model
    .find(ONLY_USER ? { _id: ONLY_USER } : {}, { name: 1, last_seen_version: 1, subscriptions: 1 })
    .lean()
    .cursor();

  let scanned = 0;
  let inAudience = 0;
  let skippedLedger = 0;
  let noTokens = 0;
  let usersQueued = 0;
  let sentOk = 0;
  let failed = 0;
  const deadByUser = new Map<string, string[]>();
  const samples: string[] = [];

  // { user_id, token } pairs, flushed to FCM in batches of FCM_BATCH.
  let queue: { user_id: string; token: string }[] = [];
  const pendingUsers = new Set<string>();

  const flush = async () => {
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    const users = new Set(batch.map((b) => b.user_id));

    if (!APPLY) {
      console.log(`  [dry run] would send ${batch.length} message(s) to ${users.size} user(s)`);
      users.forEach((u) => pendingUsers.delete(u));
      return;
    }

    const res = await admin.messaging().sendEach(batch.map((b) => buildMessage(b.token)));
    const reached = new Set<string>();
    res.responses.forEach((r, i) => {
      if (r.success) {
        sentOk++;
        reached.add(batch[i].user_id);
        return;
      }
      failed++;
      const code = r.error?.code;
      if (code && DEAD_TOKEN_CODES.has(code)) {
        const list = deadByUser.get(batch[i].user_id) ?? [];
        list.push(batch[i].token);
        deadByUser.set(batch[i].user_id, list);
      } else {
        console.error('  FCM send failed', code, r.error?.message);
      }
    });

    // Only users with at least one message FCM accepted go in the ledger.
    // Ledgering on attempt instead would mean a run that fails wholesale — bad
    // credential, suspended project — permanently marks the entire userbase as
    // notified, and the message never gets sent to anyone.
    if (reached.size) {
      const lines = [...reached].map((u) => JSON.stringify({ user_id: u, at: new Date().toISOString() }));
      fs.appendFileSync(LEDGER, lines.join('\n') + '\n');
    }
    reached.forEach((u) => pendingUsers.delete(u));

    console.log(
      `  sent batch: ${batch.length} message(s), ${users.size} user(s) — ` +
      `ok ${sentOk}, failed ${failed}, ledgered ${reached.size}`
    );

    // A batch where nothing at all landed is not a token problem — it's the
    // credential or the project. Stop rather than grind through 60 more.
    if (!reached.size) {
      throw new Error(
        'Entire batch failed — no message accepted by FCM. Check the error above ' +
        '(credential / project state) before re-running. Nothing was ledgered.'
      );
    }

    await sleep(PAUSE_MS);
  };

  for await (const u of cursor) {
    scanned++;
    const id = String(u._id);

    if (!ONLY_USER && !matchesVersion((u as any).last_seen_version)) continue;
    inAudience++;

    if (ledger.has(id)) {
      skippedLedger++;
      continue;
    }

    const subs = ((u as any).subscriptions ?? []) as { token?: string; logged_in?: boolean }[];
    const tokens = subs
      .filter((s) => s.token && (!LOGGED_IN_ONLY || s.logged_in))
      .map((s) => s.token as string);

    if (!tokens.length) {
      noTokens++;
      continue;
    }

    if (usersQueued >= LIMIT) break;
    usersQueued++;
    pendingUsers.add(id);

    if (samples.length < 10) {
      samples.push(`  ${id} ${(u as any).name} — v${(u as any).last_seen_version} — ${tokens.length} device(s)`);
    }

    tokens.forEach((token) => queue.push({ user_id: id, token }));
    if (queue.length >= FCM_BATCH) await flush();
  }

  await flush();

  console.log(`\nfirst ${samples.length} recipients:`);
  samples.forEach((l) => console.log(l));

  if (APPLY && deadByUser.size) {
    let pruned = 0;
    for (const [user_id, tokens] of deadByUser) {
      await user_model.updateOne(
        { _id: user_id },
        { $pull: { subscriptions: { token: { $in: tokens } } } }
      );
      pruned += tokens.length;
    }
    console.log(`\npruned ${pruned} dead token(s) across ${deadByUser.size} user(s)`);
  }

  console.log('\n── SUMMARY ──');
  console.log(`users scanned:            ${scanned}`);
  console.log(`in audience:              ${inAudience}`);
  console.log(`  already notified:       ${skippedLedger}`);
  console.log(`  no usable device token: ${noTokens}`);
  console.log(`  queued for send:        ${usersQueued}${usersQueued >= LIMIT ? ' (hit --limit)' : ''}`);
  if (APPLY) {
    console.log(`messages delivered:       ${sentOk}`);
    console.log(`messages failed:          ${failed}`);
    console.log(`ledger:                   ${LEDGER}`);
    if (pendingUsers.size) console.log(`NOT ledgered (unsent):    ${pendingUsers.size}`);
  } else {
    console.log('\nDRY RUN — nothing sent. Re-run with --apply (try --limit=20 first).');
  }

  console.log(`\nmessage that ${APPLY ? 'was' : 'would be'} sent:`);
  console.log(`  title: ${TITLE}`);
  console.log(`  body:  ${BODY}`);

  await mongoose.disconnect();
  console.log('\ndone');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
