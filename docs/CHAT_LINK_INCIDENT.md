# Chats missing from the overview — findings, fixes, and what is still open

Written 2026-08-20, after a report that one user's chat "loads nothing until you
send a message". Three independent faults turned out to be in play. Two are
fixed in the backend, one was environmental, and the frontend half is untouched
and carried here as TODO for the next version.

Read this before changing anything in `api/router/chat.router.ts`,
`api/services/chat.service.ts` or the relationship lifecycle — and before
porting any of it to the new stack, because the invariants at the bottom are
what the current code gets wrong.

---

## 1. What the user saw

- A chat with a current mate was absent from the overview at startup.
- Tapping that person from "online now" opened an empty thread.
- Sending a message made the whole history appear at once.
- Next app start, gone again.
- Two different ids appeared in the logs for what looked like one chat.

Every part of that is explained below, and none of it needed a client change to
diagnose.

---

## 2. Fault 1 — relationships with no `conversation_id` (the actual bug)

`GET /v2/chats/shell` walks **relationship → `conversation_id` → conversation**.
A relationship missing that one field therefore has no thread as far as the
overview is concerned, no matter how many messages the conversation holds.

Two sources:

1. **The mates backfill.** A one-off script (not in this repo) created
   relationships from the legacy `user.mates` array and never set
   `conversation_id`. On the reporting account this was a block of ~30
   relationships created in the same second, all `mate`, all unlinked.
2. **`saveMessageLogic` never repaired it.** The relationship write is guarded by
   `needsRelationshipWrite`, which only fires when the *status* changes
   (`!rel`, `'none'`, or an explicit override). An established `mate` could
   therefore message for months and the link would never be written.

The knock-on through the client, for the record — this is why it looked like a
frontend bug:

- chat absent from `activeChats`
- `openChatWithUser` (`store/chatWidget.store.ts`) falls through to its else
  branch and sets `activeTab` to the **partner's user id**
- `switchToConversation` → `loadMessages` issues
  `GET /v2/chats/<USER_ID>/messages`
- the server casts that id into `conversation_id`, matches nothing, returns an
  empty page — the "null" in the logs
- sending resolves the real conversation and the client swaps to its id, so the
  history appears
- nothing wrote the link, so the next startup repeats it

**Fixed:**

- `api/router/chat.router.ts` — `/shell` resolves unlinked relationships by
  participant pair, includes those conversations in the response, and writes the
  link back (not awaited; a self-heal must not add latency).
- `api/services/chat.service.ts` — every send reconciles
  `relationship.conversation_id` against the conversation it just wrote into.
- `/shell` now logs relationships pointing at a missing conversation instead of
  silently `continue`-ing past them.

---

## 3. Fault 2 — TTL tombstone desync (latent, would have kept firing)

`deleted_at` on `relationships` and `conversations` is **not** a soft-delete
flag. Both schemas carry `expireAfterSeconds: 0` on it, so it is a *scheduled
deletion*.

`PUT /unfriend/:target_id` stamps both documents with `now + 30d`. Every path
that revived the pair afterwards cleared `relationship.deleted_at` and left the
conversation's stamp in place:

- `relationship.router.ts` accept-invite (`pending_invite → temporary`)
- accept-mate (`pending_mate → mate`)

So a pair who fell out and made up kept a working chat for the rest of the 30 day
window, and then mongo deleted the conversation out from under them — leaving a
relationship pointing at a dead `_id`, which lands in Fault 1's failure mode with
the history stranded under the old conversation id.

The sweep found **78 armed tombstones**: conversations scheduled for deletion
whose relationship was alive (`mate`, `temporary`, `pending_mate`, `blocked`,
`expired`), firing between 2026-08-20 and 2026-09-18. All defused.

**Fixed:** `reviveConversation()` in `api/router/relationship.router.ts`, called
from both accept paths, plus a `$unset` on every send in `chat.service.ts`. The
rule is now: *the two halves move together, always*.

---

## 4. Fault 3 — Atlas out of space (environmental, resolved)

Mid-investigation the cluster hit its 512 MB quota and Atlas blocked **all
writes**. Everything read-only kept working, so the app looked half-broken:

- `POST /:post_id/comment` → `create` + `$inc` → `500 Failed to post comment`
- message sends, read receipts, unread counters — all failing
- intermittent as usage hovered at the limit, so it presented as "only some
  accounts"

This is almost certainly the reported "commenting on posts" regression. It is
**not** related to Faults 1 and 2 — a full disk does not delete a field.

Resolved by upgrading off the free tier. Note for the future: on shared tiers,
deleting documents does not return space (no `compact`); only dropping
collections or indexes does.

---

## 5. Also fixed while in there

- **`GET /v2/chats/:id/messages` had no participant check.** Any authenticated
  user could page through any conversation by id. Now 403 for non-participants.
  A missing or invalid id still returns an empty page, because that is the
  legitimate "chat head for someone you have never messaged" case.
- **`saveMessageLogic` matched conversations with an exact array equality on
  `participants`**, which is order sensitive. Pairs stored the other way round
  were missed and a duplicate conversation inserted; the unique index on
  `(participants.0, participants.1)` does not catch it, because reversed order is
  a different key. Now `$all` + `$size: 2`, with the duplicate-key race handled
  by reading the winner back. The sweep found **0** existing duplicates, so this
  is prevention only.

---

## 6. The server changes, in full — port every one of these

Six changes, all in this repo, all on `develop`. The port is not done until each
one has an equivalent. Line numbers are as written; the behaviour is what
matters.

### 6.1 `/chats/shell` resolves and backfills unlinked relationships
`api/router/chat.router.ts:61`

Before the main conversation query, relationships with no `conversation_id` are
resolved by participant pair, their conversations folded into the response, and
the link written back. The repair is deliberately **not awaited** — a self-heal
must not add latency to the request that triggered it, and a failed write just
means the next `/shell` tries again.

```ts
const recovered = new Map<string, Types.ObjectId>();
const unlinked = relationships.filter(rel => !rel.conversation_id);

if (unlinked.length) {
  const partnerIds = unlinked.map(partnerOf).filter(Boolean).map(id => new Types.ObjectId(id));

  const found = await conversation_model.find({
    $and: [{ participants: userOid }, { participants: { $in: partnerIds } }]
  }).select('participants').lean();

  // ...map conversation -> partner, then per unlinked relationship:
  recovered.set(rel._id.toString(), conversationId);
  conversationIds.push(conversationId);

  relationship_model
    .updateOne({ _id: rel._id, conversation_id: null }, { $set: { conversation_id: conversationId } })
    .catch(err => console.error('[chat/shell] conversation_id backfill failed:', err));
}
```

The row loop then reads
`(rel.conversation_id ?? recovered.get(rel._id.toString()))`.

A pair with no conversation is **skipped, not created**: mates who have never
messaged genuinely have no thread yet.

### 6.2 Every send reconciles the relationship link
`api/services/chat.service.ts:189`

The pre-existing relationship write is gated on `needsRelationshipWrite`, which
only fires on a status change — so an established `mate` never got its link
written. This runs unconditionally instead, and is a no-op when already correct.
It must not go through the status-write path, which would downgrade a `mate` to
`pending_invite`.

```ts
if (updatedRel && updatedRel.conversation_id?.toString() !== conversation._id.toString()) {
  await relationship_model.updateOne(
    { _id: updatedRel._id },
    { $set: { conversation_id: conversation._id } }
  );
  updatedRel.conversation_id = conversation._id;
}
```

### 6.3 Order-insensitive conversation lookup, with the race handled
`api/services/chat.service.ts:53` — `findOrCreateConversation()`

```ts
const pairFilter = { participants: { $all: sortedParticipants, $size: 2 } };

try {
  const upserted = await conversation_model.findOneAndUpdate(
    pairFilter,
    {
      $setOnInsert: { participants: sortedParticipants, unread_counts: new Map([...]) },
      $unset: { deleted_at: '' }
    },
    { upsert: true, new: true }
  );
  if (upserted) return upserted;
} catch (err: any) {
  // Two first messages racing: both upserts miss, both insert, the unique index
  // rejects the loser. The winner is what both sides should use.
  if (err?.code !== 11000) throw err;
}

const existing = await conversation_model.findOne(pairFilter);
```

`{ participants: sortedParticipants }` — the previous form — is an exact array
equality and therefore order sensitive. The unique index on
`(participants.0, participants.1)` does not save you: reversed order is a
different key.

### 6.4 `reviveConversation()` on every relationship revival
`api/router/relationship.router.ts:53`, called at `:108` (accept invite) and
`:155` (accept mate request)

```ts
async function reviveConversation(conversationId?: Types.ObjectId | null, populated?: any) {
  if (!conversationId) return;
  await conversation_model.updateOne({ _id: conversationId }, { $unset: { deleted_at: '' } });
  if (populated) delete populated.deleted_at;
}
```

Plus the `$unset: { deleted_at: '' }` in 6.3 (conversation) and on the
relationship writes in `saveMessageLogic` — a message is proof the thread is
live.

### 6.5 Participant guard on history
`api/router/chat.router.ts:326`

```ts
if (!Types.ObjectId.isValid(id)) { ctx.body = { data: [], hasMore: false }; return; }

const conversation = await conversation_model.findById(id).select('participants').lean();
if (!conversation) { ctx.body = { data: [], hasMore: false }; return; }

const userId = ctx.state.user._id.toString();
if (!conversation.participants.some((p: any) => p.toString() === userId)) {
  return ctx.throw(403, 'Not a participant in this conversation');
}
```

Previously the handler queried messages on the path id alone — any authenticated
user could page through any conversation in the database. The empty page for a
missing id is **required**, not laziness: it is the "chat head for someone you
have never messaged" case, and 404-ing it breaks new chats.

### 6.6 Unresolvable chats are logged
`api/router/chat.router.ts:149`

`/shell` collects relationships whose conversation is missing and logs them
rather than `continue`-ing silently. The chat is still hidden — there is nothing
to render — but the next occurrence leaves a trace. The absence of one is why
this took a full investigation to find.

---

## 7. Data repair

`src/scripts/repair-orphaned-conversations.ts` — dry-run by default, `--apply`
to write, `--user <id>` to scope, idempotent, safe on a live server.

Dry-run totals across prod:

| phase | result |
|---|---|
| live tombstones defused | 78 (of 422 stamped; the other ~344 are correctly dying with their relationship) |
| duplicate conversations merged | 0 |
| relationships linked | 2342 |
| links skipped as not-currently-visible | 78 (`expired`, `blocked`) |
| conversations rebuilt | phase 4 only — active relationship pointing at a reaped conversation |
| orphan messages left in place | ~128+ |

Two deliberate restrictions, both opt-in flags:

- **`--include-inactive`** — linking is limited to `temporary`, `mate`,
  `pending_mate`, `pending_invite`. `ACTIVE_CHAT_STATUSES` also contains
  `expired` and `blocked`, so linking those would resurface long-dead chats,
  including with people the user **blocked**. That is a product decision, not a
  data repair. Recommendation: leave `blocked` permanently.
- **`--reattach-orphans`** — orphaned messages are *not* automatically damage.
  Declining an invite deliberately deletes the conversation and leaves the
  messages, so a thread with no conversation is the normal end state of a
  rejected invitation. Rebuilding it resurrects something a person refused, and
  where the pair later became mates with a new conversation, moving the old
  messages in would drop rejected messages into their live chat. Orphaned
  messages are unreachable anyway, so leaving them costs nothing.

Supporting scripts added:

- `src/scripts/inspect-chat-state.ts` — read-only dump of one user's chat state.
  Queries through the **raw driver on purpose**: mongoose casts queries against
  the schema, so a type mismatch in a stored field reads back as "no such
  document" and sends an investigation the wrong way.
- `src/scripts/report-storage.ts` — read-only per-collection data/storage/index
  sizes plus `$indexStats` usage, for finding droppable indexes.

---

## 8. TODO — frontend (not touched)

1. **`openChatWithUser` must not key a tab by user id.**
   `store/chatWidget.store.ts` falls back to `activeTab = userId` when no
   conversation is in `activeChats`, and `loadMessages` then requests history for
   an id that is not a conversation. This is what turned a backend gap into
   "the chat is just empty" with no error anywhere. Either skip the history fetch
   for `type: "user"` heads, or model the pre-conversation state explicitly
   instead of borrowing the conversation id slot.

2. **Retire the `legacyConvo` merge block** in `store/chat.store.ts` (~line 361).
   It exists to paper over duplicate conversations arriving by socket — scar
   tissue from the order-sensitive lookup now fixed server-side. Keep it until
   the repair has run everywhere, then delete it; it silently reassigns messages
   between conversation ids, which will hide the next occurrence of this class of
   bug just as effectively as it hid this one.

3. **Surface empty-history-with-no-conversation as a state, not as silence.**
   An empty thread and a broken thread currently look identical to the user.

---

## 9. TODO — backend / migration

1. **Delete the mates backfill script** wherever it lives, or fix it to write
   `conversation_id`. It is not in this repo and may be re-run.

2. **`ACTIVE_CHAT_STATUSES` is duplicated** in `api/router/chat.router.ts` and
   both repair scripts. One definition, imported.

3. **`/chats/active` and `/chats/shell` disagree.** `active` is conversation-first
   and would have shown these chats; `shell` is relationship-first and did not.
   Two endpoints answering "what chats do I have" with different answers is how
   this stayed invisible. Pick one for the new stack.

4. **`relationship.users` is upserted with an exact array match** in
   `saveMessageLogic` — the same order-sensitivity that was just fixed for
   conversations, still present for relationships. The existing comment there
   records that it already caused duplicate invitations once.

5. **Investigate the 32 `status: 'none'` relationships** on the reporting account
   (10144 unlinked DB-wide, most with no conversation). Confirm they are declined
   invites and not another backfill artifact.

6. **The `deleted_at` TTL design is a foot-gun.** A field whose presence deletes
   the document, on two collections that must expire together, with three code
   paths that revive one of them. In the new backend either make deletion an
   explicit job that removes both halves, or drop the TTL and delete
   synchronously. This bug will come back in any port that copies the schema.

---

## 10. Invariants for the new backend

These are what the current code gets wrong. Whatever the port looks like, hold
these:

1. A relationship and its conversation are **created, revived and deleted
   together**. Neither is ever tombstoned alone.
2. `relationship.conversation_id` is **written on every send**, not only on a
   status change. It is the only route from a person to their thread.
3. Conversation lookup by pair is **order insensitive**. Never an exact array
   equality on `participants`.
4. A chat that cannot be resolved is **logged**, never silently dropped from a
   list response.
5. Conversation history is readable **only by its participants**, verified from
   the token, never from the path.
