# Moderation

This document describes how moderation works in the backend: the policy, the data model, the integration points, and how to extend it.

It is written for backend developers (i.e. me, six months from now). The user-facing version of these rules — the community guidelines and the in-app "Your Standing" page — should be derived from this document, not the other way around.

## Why this exists

The platform supports user-generated content across several surfaces: public posts, comments, private inbox drawings, balloons (drawings sent to strangers), DMs, and live drawing lobbies. Apple, Google, and basic human decency require us to give users a way to report bad content and block bad actors, to act on reports in a reasonable timeframe, and to keep a record of what we did.

There is one human reviewing reports (me). The system is designed to make that possible without burnout: most content is auto-quarantined when reports cross a threshold, and only the final uphold/dismiss decision needs a human.

## The two-axis model

Two concepts that look similar are kept strictly separate:

**Content state** — is this specific piece of content visible? Lives on the content document (`post.status`, `balloon.moderation_status`, `inbox.status`). Values: `active`, `under_review`, `removed`.

**User state** — what is this user allowed to do? Lives on the user document (`user.restriction`). Drives capability checks at request time.

The two are linked only through the moderation service: when a report is upheld, content moves to `removed` *and* the author may gain a strike (which may change their user state). They are not coupled — a user can have a high strike level without any specific piece of content being under review, and content can be under review without immediately affecting the author's state.

## Capabilities — the integration surface

Every gated action in the app corresponds to a `Capability` (see `config/moderation.policy.ts`). The full list is the source of truth; a short version:

`CREATE_POST`, `COMMENT_ON_POST`, `REACT_TO_POST`, `SEND_INBOX_DRAWING`, `COMMENT_ON_INBOX`, `SEND_BALLOON`, `RECEIVE_BALLOON`, `SEND_DM`, `SEND_MATE_REQUEST`, `CREATE_LOBBY`, `JOIN_PUBLIC_LOBBY`, `SEND_LOBBY_MESSAGE`, `DRAW_IN_LOBBY`, `CHANGE_NAME`, `CHANGE_PROFILE_IMG`, `REPORT_CONTENT`.

When you build a new social action, add a capability for it. Decide which strike levels block it. That's the entire integration — gate logic is centralized.

### Gating an HTTP route

```ts
import { requireCapability } from '../middleware/requireCapability';
import { Capability } from '../config/moderation.policy';

postRouter.post('/publish',
  requireAuth,
  requireCapability(Capability.CREATE_POST),
  async (ctx) => { /* handler */ }
);
```

When blocked, the middleware returns a `403` with a structured body matching `CapabilityBlockedError`. The frontend reads this and renders the restriction sheet — never just a generic "forbidden".

### Gating a socket handler

Socket handlers can't use Koa middleware. Use the `checkCapability` helper instead:

```ts
import { checkCapability } from '../middleware/requireCapability';

socket.on('chat:send_message', async (payload, callback) => {
  const check = checkCapability(socket.data.user, Capability.SEND_DM);
  if (check.blocked) {
    return callback({ error: 'capability_blocked', restriction: check.restriction });
  }
  // ...rest of handler
});
```

### Service-layer filtering (not gating)

Service files like `service/balloon.ts` do NOT call `requireCapability`. That's the entry point's job. What service files do is filter their queries so they don't surface moderated content. For example, `routeBalloonToOnlineUser` filters `moderation_status: 'active'` and `restriction.blocked_capabilities: { $nin: ['RECEIVE_BALLOON'] }`. The same principle applies to feed queries, inbox queries, etc.

The rule of thumb: **at the entry point, check what the user is allowed to do. In the data layer, filter what they're allowed to see.**

## Strike ladder

Strikes are upheld reports against a user. Old strikes decay after 90 days. The user's *active strike count* maps to a level on the ladder; the level dictates which capabilities are blocked and for how long.

| Level | Name | Duration | Effect |
|-------|------|----------|--------|
| 0 | Good Standing | — | All features unlocked |
| 1 | First Warning | 14 days | No capabilities blocked — just a warning surfaced in the Standing page |
| 2 | Balloon Pause | 7 days | `SEND_BALLOON`, `RECEIVE_BALLOON` |
| 3 | Public Pause | 30 days | Add: `CREATE_POST`, `COMMENT_ON_POST`, `JOIN_PUBLIC_LOBBY`, `CREATE_LOBBY` |
| 4 | Account Under Review | Until manual | Most public-facing capabilities. Triggers human review. |
| 5 | Suspended | Until manual | All capabilities |

Levels 4 and 5 do not auto-apply. They require a human (me) to escalate. The system surfaces these accounts in the mod queue but does not pull the trigger on its own — the cost of a false positive at these levels is too high.

Restrictions self-expire: the gate middleware checks `restriction.expires_at` on every request and lifts expired restrictions inline. No cron job needed.

## Reportable surfaces

Each surface has its own quarantine threshold because the risk profiles differ.

| Surface | Threshold | Auto-hide on 1st report? | Notes |
|---|---|---|---|
| Post | 3 | No | Discoverable, persistent — higher bar to remove |
| Comment | 2 | No | High volume but low-risk individually |
| Inbox drawing | 2 | No | Removal hides from ALL recipients, not just reporter |
| Inbox comment | 2 | No | Soft-delete (renders as "[removed]") |
| Balloon | 1 | Yes | Highest abuse surface; auto-hidden immediately |
| DM message | 999 | No | Never auto-acts; manual review only |
| Lobby message | 2 | No | Ephemeral but witnessed |
| Lobby drawing | 2 | No | Ephemeral but witnessed |
| User (whole account) | 5 | No | High bar; mods almost always action specific content instead |

A few of these deserve unpacking:

**Balloons auto-hide immediately.** They're pushed to strangers without consent, so a single report is enough to pull them out of circulation. The cost is low — the sender can just send another. The benefit is high — quarantined balloons stop circulating *now*, not after the third recipient also reports.

**DMs never auto-act.** A private message between two people has no public signal, so a single report doesn't tell us anything. They go straight to manual review. There's also a *cross-conversation pattern* check: if three different people have reported the same user's DMs in the last 30 days, those reports get elevated in the mod queue even though no individual report tripped the threshold.

**Inbox drawing removal is all-or-nothing.** If one recipient reports a drawing and the report is upheld, the drawing disappears from all five recipients' inboxes. The alternative — keeping it visible to four people because only one reported — makes no moral sense.

## Reasons and weights

| Reason | Severity | Weight | Notes |
|---|---|---|---|
| `minor_safety` | critical | 10 | Bypasses thresholds entirely — single credible report → auto-quarantine |
| `nsfw` | high | 1.5 | |
| `violence` | high | 1.5 | |
| `harassment` | high | 1.5 | |
| `hate_speech` | high | 1.5 | |
| `spam` | medium | 1.0 | |
| `impersonation` | medium | 1.0 | |
| `other` | low | 0.5 | Free-text required for any action |

When evaluating a target's total report weight against its quarantine threshold, each report contributes `REASON_WEIGHT * REPORTER_TRUST`. The `other` category counts for very little because it's a catch-all; reporters who consistently pick it tend to be venting, not reporting.

## Reporter trust

Reports aren't created equal. A reporter whose past reports have consistently been upheld has more weight than one whose reports have consistently been dismissed.

Trust is computed lazily from the reporter's history of resolved reports, smoothed toward 1.0 (Laplace), and clamped between 0.2 and 1.5. New users default to 1.0.

This is the system's main defense against report-brigading. Three coordinated friends can't nuke a post if their historical trust is low. Conversely, a long-time good-faith reporter's report can trip a threshold faster.

There is no UI for trust — the user never sees their own score. Surfacing it would create gaming incentives.

## New account grace period

For the first 7 days after signup, quarantine thresholds are halved for content the new user produces. The grace period is *stricter*, not looser — new accounts are statistically far more likely to be sockpuppets or trolls.

## Lifecycle of a report

1. **User taps Report.** Frontend submits to `POST /report` with `target_id`, `target_type`, `reason`, optional `details`.
2. **Anti-spam cooldown.** 60 seconds since this reporter's last report; otherwise 429.
3. **Duplicate check.** Unique index on `(reporter_id, target_id, target_type)` — second report by same user is a silent no-op (we pretend it succeeded so the UI doesn't look broken).
4. **Author resolution + content snapshot.** We capture a snapshot of the reported content because ephemeral surfaces (balloons, DMs, lobby chat) can be deleted before review. For DMs, the snapshot includes a 10-minute context window of surrounding messages.
5. **Auto-moderation evaluation.** Sum the weighted report scores. If the threshold is crossed (or if the surface has `auto_hide: true`, or the reason is `minor_safety`), the content is moved to `under_review` and existing pending reports against it are marked `auto_actioned`.
6. **Manual review.** I see the report in the mod queue. I uphold or dismiss.
   7a. **Upheld.** Content moves to `removed`. Author receives a strike via `applyStrike()`. If the strike crosses a ladder level, their restriction is updated and a `moderation:strike` socket event fires. The reporter's trust score nudges up.
   7b. **Dismissed.** Content is restored to `active` if it was quarantined. Reporter's trust score nudges down.

The "Your Standing" page on the frontend shows the user their current level, their recent moderation history (sanitized — no source report IDs), and the date their current restriction lifts.

## Data model

Three collections, two of which are new:

**`users`** — gains two fields:
- `restriction` — denormalized projection of current state. Read on every gated request, so it must be cheap.
- `strike_summary` — counts of active and total strikes. Recomputed when a strike is applied.

**`reports`** — every report submission. Indexed for the mod queue (`status + createdAt`), duplicate prevention (`reporter_id + target_id + target_type`), and author lookups (`target_author_id + status`).

**`moderation_actions`** — append-only audit log. Every strike, decay, restriction application, restriction lift, and appeal lands here. This is the source of truth; `user.restriction` and `user.strike_summary` are projections of this collection.

Why the audit log is a separate collection and not just timestamps on the user doc:
- Tweaking the strike ladder doesn't rewrite history
- Computing strike decay is a simple `count where created_at > cutoff`
- Appeals can produce a coherent timeline of "what happened to this account"
- Analytics queries don't have to unpack user documents

Content documents (`post`, `balloon`, `inbox`, etc.) gain a `moderation` sub-object that captures the transition timestamps: `quarantined_at`, `removed_at`, `last_report_at`, `last_report_reason`. The mod dashboard sorts the queue by `quarantined_at` so the oldest pending case is reviewed first.

## Content vs lifecycle status (balloon caveat)

Balloons have *two* status fields:

- `status: 'pending' | 'paired' | 'accepted'` — lifecycle
- `moderation_status: 'active' | 'under_review' | 'removed'` — moderation

These change independently. A balloon can be `paired` and `under_review` simultaneously — meaning two people matched on it, but it's been quarantined and shouldn't be processed further. Every read in `service/balloon.ts` filters on `moderation_status: 'active'` for this reason.

## Endpoints

- `POST /report` — submit a report (authenticated users)
- `GET /report/standing` — current user's own moderation status (for the Standing page)
- `GET /report/queue` — admin only; pending mod queue
- `POST /report/:id/resolve` — admin only; uphold or dismiss with `{ action: 'uphold' | 'dismiss' }`

Socket events the frontend subscribes to:

- `moderation:strike` — user just received a strike. Payload includes level, name, description, expires_at, blocked_capabilities. The frontend opens the restriction modal.
- `moderation:restriction_lifted` — restriction was lifted (auto-expiry or appeal granted). The frontend can show a small welcome-back toast.

## Adding a new gated action

Five steps. The fact that there are exactly five is the whole point of the system:

1. Add the capability to `Capability` enum in `config/moderation.policy.ts`.
2. Decide which strike levels block it; add it to the relevant entries in `STRIKE_LADDER`.
3. If it's an HTTP route: add `requireCapability(Capability.X)` middleware.
4. If it's a socket handler: add a `checkCapability(socket.data.user, Capability.X)` early in the handler.
5. If service-layer queries surface content tied to this capability, add a filter on `restriction.blocked_capabilities`.

## Adding a new reportable surface

1. Add the type to `ReportableType` and to the `REPORTABLE` config in `moderation.policy.ts` with its threshold and `auto_hide` flag.
2. Add the moderation fields (`status`, `reports_count`, `moderation` sub-object) to the surface's Mongoose schema.
3. Update `resolveTargetAuthor()` and `snapshotContent()` in the report router to handle the new type.
4. Update `quarantineContent()`, `restoreContent()`, and `removeContent()` to handle the new type's status transitions.
5. Make sure any service file that surfaces this content type filters on `status: 'active'` (or `status: { $in: ['active', 'under_review'] }` if you want to preserve visibility for the author themselves — see "Author visibility" below).

## Author visibility of own quarantined content

This is a deliberate policy decision worth stating: a user CAN see their own content while it's `under_review`. They cannot see other people's quarantined content, but their own profile shows it (greyed out, with a "Under review" badge). Two reasons:

- Hiding it from them looks like a bug ("where did my post go?")
- It gives them the chance to delete it themselves before the verdict, which is a graceful out

Queries that filter on `status: 'active'` will hide under-review content from the author too, which is wrong. The fix is to write `{ $or: [{ status: 'active' }, { author_id: viewer_id, status: 'under_review' }] }` in any query that loads content for display. The feed handler does this; user-profile post queries should too.

## What the moderation system does NOT do

- **No AI/ML content scanning.** This is a deliberate choice for cost and false-positive reasons. We rely on user reports plus reporter trust.
- **No proactive DM scanning.** Privacy first. Reported DMs are reviewable; the rest are not.
- **No public moderation log.** Users only see actions taken against them. Other users' moderation history is private.
- **No automatic unsuspension at level 5.** Permanent bans only lift through appeals.
- **No shadowbanning by default.** When content is quarantined, the author is told. The one exception is the existing block flow in chat (`chat_status === 'blocked'` returns a fake-success response to the blocked sender) — that's a different system and we may revisit it.

## Appeals

Users with an active restriction see an "Appeal" button on their Standing page. It opens a contact email. Appeals are not automated — they go to my inbox and I respond manually. When granted, `liftRestriction()` is called with `reason: 'appeal_granted'`, which writes an appeal entry to the audit log and clears the user's restriction.

This is intentionally low-tech. An appeal queue and admin UI would be nice but are not necessary at current volume. Reconsider when volume forces it.

## Operations / running the mod queue

For now: MongoDB Compass + a thin CLI. The endpoints exist; an admin dashboard does not. The queue is:

```
db.reports.find({ status: { $in: ['pending', 'auto_actioned'] } }).sort({ createdAt: 1 })
```

For each: review the `content_snapshot`, check the `target_author_id`'s recent moderation history, then `POST /report/:id/resolve` with the verdict. Build a dashboard when the queue regularly exceeds 20 items at the start of the day, not before.

## Things to revisit

- **Build a real admin dashboard.** Compass works for tens of reports per week. It will not work for hundreds.
- **Image hashing for known-bad content.** If we ever ship CSAM detection or known-extremist imagery filtering, it goes through PhotoDNA or a similar service — not built in-house.
- **Trusted reporter promotion.** Eventually some users might be elevated to "first responder" status with elevated reporter trust and direct mod-queue visibility. Not now.
- **Multi-language reasons.** Reason labels are currently English-only.
- **Sender pointer clearing on balloon quarantine.** When a balloon is quarantined, the sender's `user.balloon.sent` pointer should be cleared so they can send a new one. Currently this is a TODO in the moderation service — the routing layer correctly stops circulating the balloon, but the sender is left thinking theirs is still flying.