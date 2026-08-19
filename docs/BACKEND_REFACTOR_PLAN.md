# Backend refactor, Bun/Elysia migration, Render move, and the monorepo

**Created:** 2026-08-19
**Author:** planning pass over `sketchmate_server@develop` (274f3db), `sketchmate@develop`, `sketchmate-platform` (untracked)
**Status:** proposal — nothing here is executed yet
**Owns:** backend architecture, runtime/host migration, repo topology, docs system
**Does not own:** draw engine ([`sketchmate/docs/DRAW_ENGINE.md`]), client bundle budget
([`sketchmate/docs/QUALITY_PERF_PLAN.md`]), moderation policy ([`ModerationPolicy.md`])

---

## 0. Recommended strategy in one page

Four things are being conflated into one "big refactor". They have different
risk profiles and must not ship together:

| # | Change | Risk | Reversible? | Value |
|---|---|---|---|---|
| A | Monorepo (repo topology + shared packages) | Low | Yes | High, immediate |
| B | Heroku → Render (host) | Medium | Yes (keep Heroku warm) | Medium |
| C | Node/Koa → Bun/Elysia (runtime + framework) | **High** | Expensive | Medium |
| D | Internal refactor (god modules, validation, tests) | Medium | Yes, incremental | **Highest** |

**Recommended order: A → D → B → C.**

The instinct is to do C first because it is the exciting one. Do it last. The
reasons, concretely:

1. **There are zero tests in this repo.** A framework rewrite with no test
   suite is a rewrite whose only oracle is production. D creates the oracle.
2. **The current code cannot be ported cleanly anyway.** `mongodb.ts` is an
   857-line module imported by 22 files that mixes DB access, S3 uploads, image
   processing and analytics, and it has a circular import with `main.ts`. Porting
   that to Elysia ports the mess. Refactoring first means the port is mechanical.
3. **B is nearly free once the refactor is done, and is where the real speed
   comes from.** Heroku's slow dyno boots and the single-dyno socket ceiling
   cost more than Koa-vs-Elysia ever will (see §4.3 — this app is I/O-bound on
   Mongo and S3, not on HTTP parsing).
4. **A pays back immediately and blocks nothing.** The client currently carries a
   1210-line hand-copied fork of the server's 1052-line `types.ts`. Every API
   change is a two-repo manual sync today.

The honest framing on C: **Bun+Elysia will not make this app meaningfully
faster.** Requests here spend their time in Mongo queries, S3 round-trips and
`sharp`. What Bun/Elysia actually buy is DX — native TS execution (no `tsc`
build step, no `ts-node`), a fast test runner, and Elysia's end-to-end typed
schema validation, which this codebase badly needs and currently has zero of.
That is a real and sufficient reason to do it. It is just not a performance one,
and pitching it as performance leads to doing it in the wrong order.

---

## 1. Measured baseline

Everything in this section was read off the repos on 2026-08-19, not estimated.

### 1.1 `sketchmate_server`

```
25,936 lines across 100 TS files
Runtime:    Node >=20.19, TypeScript 4.9, ts-node/nodemon dev, tsc → dist prod
Framework:  Koa 2 + koa-router 12 + socket.io 4.8
Data:       Mongoose 8 (+ raw mongodb 5 driver as a second direct dep)
Host:       Heroku, `web: node dist/src/main.js`, single dyno
Tests:      none
Validation: none (0 occurrences of zod/valibot/typebox)
Types:      607 `any`, 163 `as any`
Logging:    269 raw `console.*` calls, no structured logger
```

Ten biggest files — these are the refactor surface:

| File | LOC | Problem |
|---|---:|---|
| `src/api/router/competition.router.ts` | 1467 | Routing + business logic in handlers |
| `src/api/router/post.router.ts` | 1326 | Same; also the best-written file in the repo |
| `src/api/socket/drawSyncing.ts` | 1106 | In-process room state |
| `src/types/types.ts` | 1052 | Forked into the client by hand |
| `src/mongodb.ts` | 857 | God module, 22 importers, circular with `main.ts` |
| `src/scripts/merge-user-accounts.ts` | 839 | One-off script shipped in `src/` |
| `src/api/router/relationship.router.ts` | 822 | Routing + logic |
| `src/api/router/user.router.ts` | 763 | Routing + logic |
| `src/api/router/moderation.router.ts` | 713 | Routing + logic |
| `src/api/balloon.ts` | 704 | Domain module at the wrong level (`api/` root) |

### 1.2 What is actually good here

This is worth stating plainly, because a refactor plan that only lists problems
produces a rewrite when it should produce a migration:

- **Comment quality is unusually high.** Non-obvious decisions carry a paragraph
  explaining *why*, including the security history (`firebase-credential.ts`,
  the `getUser` `_id`-rebind removal, `syncAndFinalizeMigrationStats`). Preserve
  these verbatim through any port. They are the design docs.
- **The newer layers are already the target architecture.** `post.router.ts` +
  `post.service.ts` + `saved-post.service.ts` is exactly router→service→model.
  The refactor is "extend the pattern the newest code already uses", not
  "invent one".
- **Presigned S3 uploads already exist** (`POST /v2/post/upload-urls`). The
  correct upload pattern is in the codebase; it just is not used everywhere yet.
- **Admin surface is properly gated** — every `admin.*` and `dev*` router calls
  `requireAdminAuth`, which checks a Firebase custom claim *and* a Mongo flag.

### 1.3 `sketchmate` (client) and `sketchmate-platform` (admin)

```
sketchmate           108k LOC, Vue 3 + Ionic + Capacitor, Vite, pnpm, biome
                     631 commits, deploying to Cloudflare (wrangler.jsonc)
                     19 docs in docs/ — good, keep this convention
sketchmate-platform  Nuxt 4 admin, Bun 1.3.14 already
                     NOT UNDER GIT AT ALL — no .git directory
                     talks directly to Mongo via its own server/utils/mongodb.ts
```

Two findings that drive the monorepo decision, and one that needs fixing today:

- `sketchmate/src/types/server.types.ts` (1210 LOC) is a hand-copied,
  **already-diverged** fork of `sketchmate_server/src/types/types.ts` (1052 LOC).
  `moderation.policy.ts` is duplicated the same way.
- `sketchmate-platform` reimplements Mongo access and Firebase admin auth in
  `server/utils/`, third copies of logic the backend owns.
- **`sketchmate-platform` has no version control.** It holds a
  `serviceAccount.json` and production Mongo credentials. This is the single
  highest-priority item in this document and it is independent of everything
  else here. See §9.1.

---

## 2. Does a monorepo make sense?

**Yes — but for the type-sharing, not for the tooling.**

### 2.1 The case, from evidence in the repos

The generic monorepo pitch (atomic cross-cutting commits, one CI, shared config)
is weak for a solo/small team. The specific case here is strong:

1. **The shared contract is already shared — badly.** Two copies of 1052 lines
   of API types, kept in sync by hand, and they have already drifted. Every
   endpoint change is a manual port. A monorepo with `packages/contracts` makes
   the client fail to typecheck when the server changes its response shape.
   This alone justifies the move.
2. **Three consumers of one API.** Client, admin platform, and the server's own
   dev routes. The admin platform bypasses the API entirely and hits Mongo
   directly — a monorepo makes "call the backend, don't re-derive it" the easy
   path, and lets the platform import a real client instead of `fetch` strings.
3. **The moderation policy is shared law.** `Capability`, restriction levels and
   strike thresholds are enforced server-side and rendered client-side. Two
   copies of a policy enum is a correctness bug waiting to happen.
4. **The Elysia migration multiplies the payoff.** Elysia's Eden Treaty gives an
   end-to-end typed client *derived from the server's route definitions* — but
   only if the client can import the server's types. That requires a monorepo.
   This is the strongest argument for A-before-C.

### 2.2 The case against, taken seriously

- **Mobile builds.** `sketchmate` carries `android/` and `ios/` Capacitor
  projects with absolute-ish path assumptions and a large native toolchain.
  These do not love being moved. Mitigation: the app keeps its directory
  structure verbatim under `apps/app/`; Capacitor paths are relative to the app
  root, and `capacitor.config.ts` + `ionic.config.json` move with it. Budget a
  half-day for `android/` gradle path fixes and one full device build to verify.
- **Git history.** 631 + 210 commits across two repos. Merging with
  `git subtree`/`--allow-unrelated-histories` preserves both; do not squash.
- **Tooling mismatch.** Client uses biome + pnpm; server uses eslint/prettier +
  pnpm; platform uses bun. Converging is work. Recommendation: **converge on
  biome and bun**, since two of three are already heading there and biome is
  ~20x faster than the eslint/prettier pair the server still runs.
- **CI cost.** A naive monorepo rebuilds everything on every push. Solved by
  Turborepo's affected-package filtering (§2.4), not by avoiding the monorepo.

**Verdict: do it.** The type duplication is a live, already-manifested bug
source, and it gets worse with every feature.

### 2.3 Proposed shape

```
sketchmate/                          # one repo, bun workspaces + turborepo
├── apps/
│   ├── app/                         # ← sketchmate (Ionic/Vue + Capacitor)
│   ├── api/                         # ← sketchmate_server (Bun + Elysia)
│   └── admin/                       # ← sketchmate-platform (Nuxt 4)
├── packages/
│   ├── contracts/                   # THE point of the monorepo
│   │   ├── src/api.ts               # request/response types, ENDPOINTS
│   │   ├── src/socket.ts            # SOCKET_ENDPONTS + payload types
│   │   ├── src/moderation.ts        # Capability, restriction levels
│   │   └── src/domain.ts            # User, Post, Balloon, Competition …
│   ├── config/                      # catalog, quota, competition constants
│   │                                #   (shared: client renders what server enforces)
│   ├── sdk/                         # generated/derived API client
│   │                                #   (Eden Treaty once on Elysia; hand-rolled before)
│   └── tsconfig/  packages/biome/   # shared toolchain config
├── docs/                            # §7 — the docs system
│   ├── adr/                         # architecture decision records
│   ├── domains/                     # one file per bounded context
│   └── plans/                       # this file lives here
├── turbo.json
├── package.json                     # workspaces
└── bunfig.toml
```

Notes on the shape:

- **`packages/contracts` must have no runtime dependencies.** Pure types, enums
  and constants. If it imports mongoose it has failed.
- **`packages/config` is the second-biggest win** after contracts.
  `catalog.config.ts` (595 LOC) and `quota.config.ts` describe items and limits
  the client must render and the server must enforce. One copy.
- **Do not create `packages/utils`.** It becomes a junk drawer. Shared code goes
  in a package named after its domain or it stays where it is.

### 2.4 Tooling

| Concern | Pick | Why |
|---|---|---|
| Package manager | **Bun workspaces** | Platform already on bun 1.3.14; needed for C anyway; installs are dramatically faster than pnpm here |
| Task runner | **Turborepo** | Content-hash caching + `--filter` for affected-only CI. Nx is more powerful and more ceremony than three apps need |
| Lint/format | **Biome** | Client already on it; replaces eslint 8 + prettier 2.8 on the server, both of which are two majors stale |
| TS | **5.9+, `strict: true`** on new packages | Server is on 4.9 with `@tsconfig/node18` |

Migrate the app to bun workspaces carefully: `sketchmate` has a 330k-line
`pnpm-lock.yaml` and Capacitor native deps. Verify a full Android build before
deleting the pnpm lockfile.

---

## 3. Bun + Elysia migration analysis

### 3.1 Dependency risk table

Every current dependency, assessed against Bun. This is the migration's real
scope.

| Dependency | Bun status | Action |
|---|---|---|
| `koa`, `koa-router`, `@koa/cors`, `koa-compress`, `koa-etag`, `koa-conditional-get`, `koa-logger` | Replaced | → Elysia core + `@elysiajs/cors`. Compression/etag/conditional-get are **built into Bun's `Bun.serve` layer or Elysia plugins** — 6 middleware packages disappear |
| `koa-body` + `formidable` | Replaced | → Web-standard `FormData` / `Request.formData()`. **But see §3.3** — the better move is to delete multipart entirely |
| `socket.io` 4.8 | ⚠️ **The main risk** | Works on Bun (engine.io over `node:http`), but Bun's WebSocket path is not socket.io's tested target and the sticky-session story changes. See §3.4 |
| `mongoose` 8 | ✅ Works | No change. Mongoose 8 runs on Bun |
| `mongodb` 5 (direct) | Remove | Redundant with mongoose 8's bundled driver. Dead dep |
| `firebase-admin` 13 | ✅ Works | gRPC path has historically been the flaky one on Bun; force the REST transport if `verifyIdToken` misbehaves |
| `sharp` 0.35 | ✅ Works | Native N-API module, loads under Bun. On Render, ensure the linux-x64 binary — pin via Docker (§4.2) |
| `web-push` | ✅ Works | But — check if it is still used at all; FCM (`notifications.ts`) appears to have superseded it |
| `node-cron` | Replace | → Render Cron Jobs for the nightly sweep; keep an in-process ticker only for the hourly idempotent work. **Mandatory before scaling past one instance** (§4.4) |
| `pm2` | **Delete** | In `dependencies`, unused — `Procfile` runs plain node. Dead weight in every install |
| `@aws-sdk/client-s3`, `s3-request-presigner` | ✅ Works | No change |
| `axios` | Replace | → native `fetch`. One call site (`removeBackground` in `helper.ts`) |
| `mixpanel` (server SDK) | ✅ Works | No change |
| `uuid` | Replace | → `crypto.randomUUID()`. Built in |
| `obscenity` | ✅ Works | Pure JS |
| `dayjs` | ✅ Works | Keep, or drop for `Intl`/`Temporal` — low priority |
| `dotenv` | **Delete** | Bun loads `.env` natively |
| `ts-node`, `nodemon`, `cross-env`, `typescript` (build) | **Delete** | `bun --watch src/main.ts`. No build step, no `dist/`, no `rootDir` footgun (the one `tsconfig.json` has a 6-line comment about). `tsc --noEmit` stays as a typecheck gate only |
| `eslint` 8 + `@typescript-eslint` 5 + `prettier` 2.8 | Replace | → biome |

Net: **~15 dependencies removed**, 6 middleware packages collapse into the
framework, and the build step disappears. That is the DX win, stated concretely.

### 3.2 What Elysia changes structurally

Elysia is not a Koa reskin. Three differences drive the port:

**1. Schema-first routes.** Elysia validates request/response against TypeBox
schemas declared on the route, and derives the types from them.

```ts
// today — `parseParams<T>` is a cast, not a parse. Nothing is validated.
router.put(`${ENDPOINTS.user}/update`, async (ctx) => {
  ctx.body = await updateUser(parseParams<UpdateUserParams>(ctx.request.body));
});

// after
.put('/update', ({ body, user }) => updateUser(user._id, body), {
  body: t.Object({
    name: t.Optional(t.String({ minLength: 1, maxLength: 30 })),
    date_of_birth: t.Optional(t.Date())
  }),
  response: UserResponseSchema,
  beforeHandle: requireAuth
})
```

This closes the biggest correctness gap in the codebase. `parseParams<T>` does
`JSON.parse` and casts — every handler currently trusts client-shaped input, and
the 607 `any`s are downstream of that.

**2. `ctx` destructuring instead of mutation.** Koa's `ctx.body = x` becomes a
return value. Mechanical, but it touches every handler.

**3. Plugin-scoped state replaces `ctx.state`.** `ctx.state.user` /
`ctx.state.auth_id`, set by `requireAuth`, become a `derive`/`resolve` macro —
and unlike `ctx.state`, the resulting `user` is **typed** at every call site.

### 3.3 Kill multipart uploads (do this regardless of Bun)

The current upload path — `koa-body` → `formidable` → local `./uploads` →
`fs.readFile` → S3 → `fs.unlink`, plus a daily cron that sweeps orphans — exists
in `main.ts`, `helper.ts`, `router.ts` and `mongodb.ts`. It is:

- **ephemeral-disk-dependent** — same problem on Render as on Heroku;
- **a memory spike** — 30 MB max file, read fully into the API process;
- **already solved elsewhere in this repo** — `POST /v2/post/upload-urls`
  presigns straight to S3 and the client PUTs directly.

Migrating balloon, profile-image, sticker, emblem and saved-drawing uploads to
the presigned pattern deletes `koa-body`'s multipart config, `formidable`, the
`uploads` directory, `scheduleResetUploadFolder`, and the `fs` imports from four
files — and removes the largest single source of API-process memory pressure.

It also requires a client change, which is why it belongs after A (monorepo) so
both sides move in one commit.

### 3.4 The socket.io problem — the real blocker

This is the most important technical finding in this document.

```ts
// src/api/socket/socket.ts
export const userSocketMap: UserSocketMap = {};   // in-process, per-instance

export function sendSocketNotificationToUser(userId, endpoint, data) {
  if (!userSocketMap[userId]) return;             // ← only knows THIS instance
  userSocketMap[userId].forEach(s => s.emit(endpoint, data));
}
```

`userSocketMap` is a module-level object. `drawSyncing.ts` (1106 LOC) holds room
state the same way. **The server is architecturally single-instance.** Add a
second Render instance and half of all realtime notifications silently vanish —
no error, no log, just users not receiving balloons.

There is a clean fix already 90% present in the code. Every socket does
`socket.join(userIdString)` on login. So:

```ts
// the map is redundant — socket.io already tracks this in the room
export function sendSocketNotificationToUser(io, userId, endpoint, data) {
  io.to(userId).emit(endpoint, data);
}
```

Rooms are adapter-aware. Swap in `@socket.io/mongo-adapter` (no new
infrastructure — Mongo is already there; a capped collection is all it needs) and
the app scales horizontally. `isUserOnline` already does it correctly via
`io.in(userId).fetchSockets()` — the pattern is in the file, just not used
consistently.

**Order this before both B and C.** Migrating to Render or Bun while carrying a
single-instance assumption means arriving at the new host unable to use its main
advantage.

`drawSyncing.ts` needs the same treatment and is harder — 1106 lines of
collaborative-drawing room state. Options, in order of preference: (1) move room
state into socket.io rooms + a Mongo/Redis-backed store; (2) accept
single-instance for draw sync and route it to a dedicated instance; (3) sticky
sessions by room id. Decide with an ADR (§7.2) before writing code.

### 3.5 Honest performance expectation

Elysia's benchmark wins are HTTP parsing and routing throughput. A representative
request here — `GET /v2/post/feed` — spends its time in: Firebase token verify
(network, cached), 2–4 Mongo queries, hydration, S3 URL signing. Framework
overhead is single-digit microseconds against tens of milliseconds of I/O.

**Where speed actually is, in priority order:**

1. Mongo query and index work (§6.4) — the only place with 10x available
2. Removing the Heroku cold-boot/router hop (§4.3)
3. N+1 elimination in hydration paths (§6.4)
4. Framework choice — last, and by a wide margin

Do C for the DX and the validation. Get the speed from 1–3.

---

## 4. Heroku → Render

### 4.1 Service topology on Render

| Render service | Source | Notes |
|---|---|---|
| `sketchmate-api` (Web Service) | `apps/api` | Bun runtime or Docker (§4.2). Needs WebSocket support — Render supports it natively, no extra config |
| `sketchmate-admin` (Web Service) | `apps/admin` | Nuxt 4. Or keep on its current host |
| `sketchmate-app` | — | **Stays on Cloudflare** — `wrangler.jsonc` already exists. Do not move it |
| `risk-sweep` (Cron Job) | `apps/api` | Replaces the 03:00 `node-cron` entry |
| `competition-advance` (Cron Job) | `apps/api` | Replaces the hourly tick, once multi-instance |

Use a `render.yaml` blueprint checked into the repo so the topology is code, not
dashboard clicks. With a monorepo, set each service's **Root Directory** to its
app path and a build filter so a client-only push does not redeploy the API.

### 4.2 Docker vs native runtime

**Recommend Docker.** Render's native Bun support is fine, but `sharp` needs a
matching native binary and Docker makes that reproducible and pinned. It also
makes local `docker run` identical to production — worth more than the build-time
savings of a native environment.

### 4.3 What actually improves

- **No 30s dyno boot / no idle sleep** on paid Render instances. The Heroku
  router adds a hop and the boot cost shows up on every deploy and restart.
- **Persistent disk available if ever needed** (it should not be — §3.3 removes
  the only use).
- **Cron as first-class jobs**, not an in-process scheduler competing with request
  handling on the same event loop.
- **Native health checks**, so a wedged instance gets replaced instead of
  silently serving 500s — which the current `uncaughtException` handler
  guarantees (§6.1).

### 4.4 The cron double-fire trap

```ts
cron.schedule('0 */1 * * *', async () => { await pairBalloons(); … });
```

With one dyno this is correct. With N Render instances it runs N times per hour.
`advancePhases` is documented as idempotent — good. `pairBalloons`,
`removeExpiredBalloons` and `runCompetitionNotifications` are **not verified
idempotent**, and duplicate notifications are user-visible.

Two-step fix: (1) move each job to a Render Cron Job invoking a dedicated
admin-authenticated endpoint or a `bun run jobs/<name>.ts` entry point;
(2) until then, guard in-process crons behind an instance check or a Mongo
advisory lock (`findOneAndUpdate` on a `job_locks` collection with a TTL).

### 4.5 Cutover

Zero-downtime, reversible:

1. Deploy the API to Render pointing at the **same** Mongo and S3. Do not migrate
   data — there is nothing host-specific in it.
2. Run both hosts in parallel. Heroku keeps serving `server.sketchmate.ninja`.
3. Smoke the Render instance on a separate hostname with the contract tests from
   D. Include a real socket.io connect/emit/receive cycle.
4. Shift DNS with a low TTL. Watch error rate and socket connection count.
5. Keep Heroku deployable for two weeks. Then delete, and remove `Procfile`,
   `start:heroku`, and the `herokuapp.com` entry in `main.ts`'s CORS list.

---

## 5. Target backend architecture

### 5.1 Layering

The rule, enforced by lint: **routers do not touch models.**

```
apps/api/src/
├── index.ts                    # compose app, listen. ~40 lines
├── app.ts                      # plugin registration, no side effects
├── modules/                    # one directory per bounded context
│   ├── user/
│   │   ├── user.routes.ts      # Elysia plugin: paths, schemas, auth. Thin
│   │   ├── user.service.ts     # business logic. No ctx, no Elysia import
│   │   ├── user.repository.ts  # the ONLY place user_model is touched
│   │   ├── user.model.ts       # mongoose schema
│   │   └── user.schema.ts      # TypeBox request/response schemas
│   ├── post/ balloon/ competition/ moderation/ relationship/
│   ├── inbox/ chat/ quota/ notification/ inventory/ draw-sync/
├── platform/                   # cross-cutting, domain-free
│   ├── auth/                   # requireAuth, requireAdminAuth, requirePro macros
│   ├── db/                     # connection, indexes, health
│   ├── storage/                # S3 + presigning (today's s3.ts)
│   ├── realtime/               # socket.io server + adapter + room helpers
│   ├── telemetry/              # logger + mixpanel (today's 269 console calls)
│   └── jobs/                   # cron entry points, individually invocable
└── config/                     # re-exports packages/config + env parsing
```

Why this and not the current `api/router` + `api/services` split: the current
layout groups by *technical role* across all domains, so a competition change
touches `router/competition.router.ts`, `services/competition.service.ts`,
`services/competitionNotifications.service.ts`, `models/competition.model.ts`
and `config/competition.config.ts` in five different trees. Grouping by domain
puts a feature in one directory — which matters more for an AI agent reading the
codebase than for a human, and matters a lot for both.

### 5.2 Dissolving `mongodb.ts`

The 857-line god module, imported by 22 files, exporting 30+ functions across 8
domains, and holding `export let s3Creator` — a mutable module-level binding
assigned inside `connectDb()`, so any importer that runs before connection gets
`undefined`. It also imports `minimum_online_version` from `main.ts`, creating a
**circular dependency** `main → mongodb → main`, which works today only because
of hoisting order.

Mapping:

| Current export | Goes to |
|---|---|
| `connectDb`, `s3Creator` | `platform/db/connection.ts`, `platform/storage/` — injected, not a module-level `let` |
| `createUser`, `getUser`, `updateUser`, `changeUserName`, `getPartialUser(s)`, `searchMate` | `modules/user/user.repository.ts` |
| `uploadProfileImg`, `deleteProfileImg`, `createSticker`, `createEmblem`, `createSaved`, `delete*` | `modules/user/avatar.service.ts` + `modules/inventory/` — presigned (§3.3) |
| `getInboxItems`, `comment`, `removeFromInbox`, `seeInbox`, `storeMessage` | `modules/inbox/` |
| `match`, `unMatch`, `sendMateRequest`, `cancel*`, `refuse*` | `modules/relationship/` (partially there already) |
| `createBalloon`, `getBalloon` | `modules/balloon/` |
| `subscribe`, `unsubscribe`, `getUserSubscription`, `pruneSubscriptionTokens` | `modules/notification/` |
| `minimum_supported_version`, `minimum_online_version` | `config/versions.ts` — **kills the circular import** |

Do this incrementally on Koa, before the Elysia port. Each extraction is a
mechanical move + import update, verifiable by `tsc --noEmit`.

### 5.3 Retire the legacy root router

`src/api/router/router.ts` mounts 20 sub-routers (good) and then defines ~20
legacy pre-`/v2` handlers inline (not good). **Only one of them —
`GET /user` — has `requireAuth`.** The rest read an id from the path or query
and act on it:

```
PUT    /user                → changeUserName(body)          no auth
PUT    /user/update         → updateUser(body)              no auth
PUT    /user/img/:id        → uploadProfileImg(path id)     no auth
DELETE /user/img/:id        → deleteProfileImg(path id)     no auth
POST   /sticker/:id         → createSticker(path id)        no auth
POST   /emblem/:id  /saved/:id                              no auth
GET    /partial_users?_ids= /inbox?_ids=                    no auth
DELETE /inbox/:userId/:inboxItemId                          no auth
POST   /balloon  /balloon/v2                                no auth
GET    /user/inbox/latest?user_id=   (widget)               no auth
```

Since `_id` is public — it comes back from `/partial_users`, posts and mates —
these are IDOR-shaped: knowing another user's `_id` is sufficient to act as them
on these routes. The `getUser` comment shows this class of bug has already been
found and fixed once here.

The reason they are unauthenticated is presumably old clients. So the fix is a
measurement, not a guess:

1. Add per-route hit-counting with client-version tagging (one middleware, one
   Mongo counter, one week).
2. `minimum_supported_version` is already the enforcement lever, and
   `compareVersions` already exists in `helper.ts`.
3. Routes with no traffic from supported versions → delete.
4. Routes with traffic → add `requireAuth` and derive the id from
   `ctx.state.user._id`, never from the path. Ship behind a version gate.

**This should start now, in parallel with everything else** — it is a week of
waiting followed by an hour of deletion, and the port is much smaller afterwards.

### 5.4 Validation and error handling

- Every route gets a TypeBox `body`/`query`/`params` schema. No exceptions.
  `parseParams<T>` is deleted.
- One error taxonomy: `AppError` with `status`, `code`, `message`, `meta`.
  The current handler returns raw `err.message` as the body — internal messages
  and stack-adjacent strings reach clients on any unhandled 500.
- Structured logging (`pino` or Bun's built-in) with request id, user id, route,
  duration. Replaces 269 `console.*` calls. Non-negotiable on Render, where
  `heroku logs --tail` is not there to save you.

---

## 6. Code-level findings

Ordered by severity. Each is independently actionable.

### 6.1 Correctness / operational

**`uncaughtException` swallows and continues** (`main.ts:126`)

```ts
process.on('uncaughtException', (error) => { console.error(...); });
```

After an uncaught exception the process is in an undefined state — open handles,
half-mutated module state, possibly a broken Mongo connection. Continuing serves
corrupt responses instead of restarting. Correct behaviour: log, flush, `exit(1)`,
let the platform restart. Render's health checks make this safe; on a single
Heroku dyno it was a rational (if costly) hack. **Fix as part of the Render
move, not before** — it changes restart behaviour under the current host.

**`unhandledRejection` ignores `promise`** — same file, same treatment.

**Circular import `main ↔ mongodb`** — §5.2.

**`export let s3Creator`** — undefined for any importer evaluated before
`connectDb()`. Currently safe by accident of import order.

### 6.2 Security

1. **`sketchmate-platform` is unversioned and holds `serviceAccount.json`.**
   §9.1. Highest priority in this document.
2. **The legacy root router** — §5.3.
3. **`errorHandler` leaks `err.message`** to clients on 500 — §5.4.
4. **CORS allowlist hardcoded in `main.ts`**, including a `herokuapp.com` test
   host. Move to env-driven config; drop the test host at cutover.
5. **No rate limiting anywhere.** `search_mate` (regex over users), the balloon
   create path (30 MB uploads) and guest recovery are the exposed ones. Elysia
   has a rate-limit plugin; add at least on those three.
6. `verifyIdToken(idToken)` in `requireAuth` vs `verifyIdToken(idToken, true)`
   in `requireAdminAuth` — the admin path checks revocation, the user path does
   not. Probably deliberate (the revocation check costs a network call per
   request); worth an explicit comment either way.

### 6.3 Readability / structure

- **Five 700–1500 line routers.** Split router ↔ service per §5.1. `post.router.ts`
  is the model to copy — it already delegates to `post.service.ts`.
- **607 `any` / 163 `as any`.** Most cluster around mongoose `.lean()` results
  (`as unknown as UserDocument`) and `ctx.request.files`. Both disappear with
  proper `lean<T>()` generics and presigned uploads. Target: `as any` under 20,
  then enable `noImplicitAny`.
- **`src/scripts/` (1600+ LOC of one-off migrations) ships inside `src/`** and is
  compiled into `dist/`. Move to `apps/api/scripts/`, excluded from the build.
- **`src/api/balloon.ts` (704 LOC)** sits at the wrong level — it is a domain
  module in a directory of routers/services/sockets. → `modules/balloon/`.
- **Two balloon service versions** (`balloon.service.ts`, `balloon.service.v3.ts`)
  coexisting. Determine which is live, delete the other or name the split
  explicitly.
- **Naming is inconsistent**: `user_model` (snake) vs `userSocketMap` (camel),
  `devCompetition.router.ts` (camel) vs `admin.competition.router.ts` (dot),
  `SOCKET_ENDPONTS` (typo, and it is in the client copy too — fix in
  `packages/contracts` where it is fixed once).

### 6.4 Performance — where the real wins are

These are worth more than the framework swap combined:

1. **Audit indexes against actual query shapes.** Every `find` in
   `relationship.router.ts`, `post.router.ts` and `socket.ts` filters on fields
   whose index status is unverified. `relationship_model.find({ users: oid,
   chat_status: {$in: [...]} })` runs on **every socket login** and again on every
   presence broadcast — it needs a compound index on `{users: 1, chat_status: 1}`.
   Run `explain()` on the top 10 query shapes. This is the single highest-value
   performance task in this document.
2. **`getPresenceWatcherRooms` duplicates the login query.** `socket.ts` runs the
   same relationship query in `registerSocketHandlers`' login handler and again
   in `broadcastFriendPresence`. Cache the watcher set on `socket.data`.
3. **`runCompetitionNotifications` reads the full opted-in user set 2–3× per
   hourly tick**, then runs `isEngaged` as two sequential queries per candidate
   — already documented as a known cost in `sketchmate/docs/COMPETITION.md`
   §10.3. Aggregate instead.
4. **`GET /competition/:id/entries` loads the whole week's entries per request**
   for an in-memory shuffle — same doc, deliberate, but it needs a ceiling
   before the next competition scales.
5. **`sharp` runs on the API event loop.** `createThumbnail`/`compressImg` are
   CPU-bound and block. Either move to a worker (Bun supports `Worker`) or push
   thumbnailing to the client, which already has canvas access — the client
   already produces `-thumb.webp` for posts.
6. **No caching layer at all.** `getPartialUsers` is called on nearly every
   hydration path. An in-process LRU with a short TTL is 20 lines and removes a
   large share of Mongo reads.

---

## 7. Docs system

The ask: a `docs/` folder that (a) renders as a browsable site, (b) is
manageable, (c) gives AI agents an accurate picture of *progress*.

`sketchmate/docs/` (19 files) already demonstrates the right instinct — the
COMPETITION.md "Status / Known gaps" block is exactly what an agent needs. The
gap is that this state is prose: nothing can query it, and it goes stale silently.

### 7.1 Recommendation: VitePress + frontmatter as the database

**Site generator: VitePress.** Vue-native (matches the stack), markdown-first,
zero-config local dev, deploys to Cloudflare Pages next to the app. Alternatives
considered: Docusaurus (React, wrong ecosystem here), Starlight (excellent, adds
Astro as a fourth framework), Mintlify (hosted, paid, and your docs then live
somewhere your agents cannot cheaply read).

**Make every doc machine-readable** with required frontmatter:

```yaml
---
title: Weekly Art Competition
domain: competition
status: partial            # planned | in-progress | partial | shipped | deprecated
owners: [api, app]
updated: 2026-08-19
supersedes: []
tasks:
  - id: COMP-8.3
    title: Promote runner-up when a winning entry is removed
    status: todo
  - id: COMP-10.3
    title: Load-check a synthetic competition week
    status: todo
code:
  - apps/api/src/modules/competition/
  - apps/app/src/views/competition/
---
```

Then a small script (`bun run docs:index`) walks `docs/**/*.md` and emits:

- **`docs/.index.json`** — every doc, its status, its open tasks, its code paths.
- **`docs/STATUS.md`** — generated roll-up: what is shipped, in progress, open.
  Never hand-edited.
- **`llms.txt`** at the docs root — the emerging convention for pointing an AI at
  a site's canonical structure.

This is the piece that makes it work for agents. An agent asking "what is the
state of competitions?" reads one JSON file instead of inferring from 19
markdown documents. And a CI check that fails when a doc's `code:` paths changed
but its `updated:` did not is what stops the drift.

### 7.2 Structure

```
docs/
├── index.md                 # start here — the map
├── llms.txt                 # canonical structure for AI agents
├── STATUS.md                # GENERATED — do not edit
├── architecture/            # how it is built, present tense
│   ├── overview.md  api.md  realtime.md  data-model.md  auth.md
├── domains/                 # one per bounded context, mirrors §5.1 modules
│   ├── competition.md  moderation.md  balloon.md  post.md  relationship.md …
├── adr/                     # decisions, immutable once accepted
│   ├── 0001-monorepo.md
│   ├── 0002-bun-elysia.md
│   ├── 0003-render.md
│   ├── 0004-socketio-adapter.md      # ← the §3.4 decision
│   └── 0005-docs-system.md
├── plans/                   # time-bound work. This file.
│   └── backend-refactor.md
├── runbooks/                # deploy, rollback, incident, cron, key rotation
└── contributing/            # conventions, AGENTS.md, review checklist
```

**ADRs matter more than usual here.** "Why Elysia and not Hono/Fastify", "why
the socket adapter is Mongo and not Redis", "why the app stays on Cloudflare" —
those questions get re-asked every few months, by you and by every agent session.
An ADR answers once. Use the standard template: Context / Decision / Status /
Consequences. Never edit an accepted ADR; supersede it.

### 7.3 Agent integration

- **`AGENTS.md` / `CLAUDE.md` at the repo root** — currently absent from
  `sketchmate_server`. It should be short and point outward: how to run things,
  the layering rule from §5.1, and "read `docs/.index.json` before planning".
- **Per-app `CLAUDE.md`** in `apps/api`, `apps/app`, `apps/admin`.
- **Doc-freshness CI check** as above.
- Optional later: an MCP server exposing `docs/.index.json` as a queryable tool.
  Do not build this until the index exists and has proven useful — a JSON file
  an agent can `cat` covers most of the value.

---

## 8. Phased roadmap

Each phase ships independently and leaves the app in a working state. No phase
depends on a later one.

### Phase 0 — Stop the bleeding (days, do immediately)

Independent of every other decision.

- [ ] **`git init` `sketchmate-platform`**, `.gitignore` `serviceAccount.json`
      and `.env`, push private. **Rotate the service-account key and Mongo
      credentials** — they have been sitting unversioned on one disk.
- [ ] Add legacy-route hit counting (§5.3) and start the one-week measurement.
- [ ] Delete dead deps: `pm2`, direct `mongodb`, `web-push` if confirmed unused.
- [ ] Write `CLAUDE.md` for `sketchmate_server`.

**Gate:** platform is versioned, keys rotated, route telemetry flowing.

### Phase 1 — Monorepo (1–2 weeks)

- [ ] New repo `sketchmate` (or reuse the client's, it has the most history).
- [ ] `git subtree add` each project under `apps/`, preserving history.
- [ ] Bun workspaces + Turborepo + shared biome/tsconfig packages.
- [ ] **`packages/contracts`**: move `types/types.ts`, `moderation.policy.ts`,
      `notification.type.ts`; reconcile the two diverged copies field by field
      (expect real behavioural bugs to surface here — that is the point);
      delete `sketchmate/src/types/server.types.ts`.
- [ ] **`packages/config`**: `catalog.config.ts`, `quota.config.ts`,
      `competition.config.ts`.
- [ ] CI: typecheck + lint + build all three apps, affected-only.
- [ ] Verify a full Android build from the new location.

**Gate:** all three apps build from the monorepo; one contract change breaks the
client typecheck as designed; Android build produces a working APK.

### Phase 2 — Backend refactor on Koa (3–4 weeks)

Still Node, still Koa, still Heroku. Highest-value phase, lowest-drama.

- [ ] **Contract tests first.** `bun:test` (or vitest) against a real
      `mongodb-memory-server`, covering every `/v2` route's happy path + auth
      failure + one edge each. This is the oracle for Phases 3 and 4. Do not skip
      it and do not aim for coverage percentages — aim for "every route is
      exercised once".
- [ ] Dissolve `mongodb.ts` into repositories (§5.2). Kill the circular import.
- [ ] Reorganize into `modules/` by domain (§5.1).
- [ ] Split the five oversized routers into router + service.
- [ ] **Fix `sendSocketNotificationToUser` to use rooms; delete `userSocketMap`**
      (§3.4). Add `@socket.io/mongo-adapter`.
- [ ] Presigned uploads everywhere; delete formidable/multipart/`uploads/`/the
      cleanup cron (§3.3). Requires a coordinated client change — now possible in
      one commit.
- [ ] Structured logging replaces 269 `console.*`.
- [ ] Error taxonomy; stop leaking `err.message`.
- [ ] Retire or authenticate the legacy root routes, using Phase 0's data (§5.3).
- [ ] Index audit + `explain()` on the top 10 query shapes (§6.4).
- [ ] TS 5.9, `strict: true`, drive `as any` under 20.

**Gate:** contract tests green; `as any` < 20; no file over 400 lines; two
instances can run simultaneously without losing socket messages (test this
explicitly).

### Phase 3 — Render (1 week)

- [ ] `render.yaml` blueprint + Dockerfile.
- [ ] Extract crons to Render Cron Jobs; add the Mongo advisory lock (§4.4).
- [ ] `uncaughtException` → log + exit; health-check endpoint.
- [ ] Parallel-run, smoke, DNS cutover, two-week Heroku standby (§4.5).

**Gate:** 48h on Render with error rate and p95 at or below Heroku's; a
deliberate instance kill recovers without user-visible loss.

### Phase 4 — Bun + Elysia (2–3 weeks)

Now mechanical, because Phase 2 did the thinking.

- [ ] Port `platform/` first (db, storage, auth, telemetry) — no framework
      coupling, so it moves nearly unchanged.
- [ ] Port module by module, one PR each, contract tests green after every one.
      Order: quota → notification → inbox → user → relationship → post →
      competition → moderation → balloon → draw-sync (hardest last).
- [ ] Add TypeBox schemas as each module ports. Delete `parseParams`.
- [ ] Socket.io on Bun: **spike this before committing to the phase.** If it does
      not hold, the fallback is Elysia for HTTP + a separate Node socket service,
      which the Phase 2 room refactor makes viable.
- [ ] Adopt Eden Treaty in `packages/sdk`; the client's 15 `*.api.ts` files
      become typed calls.
- [ ] Delete: `tsc` build, `dist/`, ts-node, nodemon, dotenv, cross-env, axios,
      uuid, koa + 6 middleware packages.

**Gate:** contract tests green on Bun; parallel-run against the Node service on
production traffic shape; socket cycle verified end to end.

### Phase 5 — Docs system (parallel, from Phase 1 onward)

- [ ] VitePress in `apps/docs`, deployed to Cloudflare Pages.
- [ ] Frontmatter schema + `docs:index` generator + `STATUS.md` + `llms.txt`.
- [ ] Backfill: migrate `sketchmate/docs/*` into `docs/domains/`, write
      `docs/architecture/*` from the Phase 2 result.
- [ ] ADRs 0001–0005 written as the decisions are made, not after.
- [ ] CI freshness check.

---

## 9. Risks

### 9.1 Immediate

**`sketchmate-platform` is not under version control** and contains a Firebase
`serviceAccount.json` plus production Mongo credentials in `.env`. One `rm -rf`
or disk failure loses the admin platform entirely, and there is no audit trail
for the credentials. Phase 0, day one. Rotate the keys as part of it — an
unversioned secret is one whose exposure history is unknown.

### 9.2 Migration risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| socket.io misbehaves on Bun | Medium | Spike in Phase 4 before committing; fallback = split HTTP/socket services, enabled by the Phase 2 room refactor |
| Contract reconciliation surfaces real bugs | **High** | This is a feature. Budget a week for Phase 1 and fix them |
| Capacitor/Android breaks on move | Medium | Full device build as a Phase 1 gate |
| Multi-instance loses socket messages | **High if unaddressed** | §3.4 is a Phase 2 gate, tested explicitly with two instances |
| Cron double-fires on Render | High if unaddressed | §4.4 advisory lock, Phase 3 gate |
| `sharp` binary mismatch | Low | Docker (§4.2) |
| Scope creep — all four changes at once | **High** | The phase gates. Each phase ships alone |
| Old clients break on legacy-route removal | Medium | Measure first (§5.3), version-gate, never guess |

### 9.3 Rollback

- Phase 1: monorepo lives alongside the old repos until CI is green. Old repos
  stay read-only, not deleted, for a month.
- Phase 2: incremental on `develop`, every step behind a green test suite.
- Phase 3: DNS revert, Heroku kept deployable two weeks.
- Phase 4: per-module PRs; the Koa version stays deployable on a branch until
  the Bun service has run a week in production.

---

## 10. Effort

| Phase | Estimate | Can run parallel with |
|---|---|---|
| 0 — Stop the bleeding | 1–2 days | everything |
| 1 — Monorepo | 1–2 weeks | 5 |
| 2 — Backend refactor | 3–4 weeks | 5 |
| 3 — Render | 1 week | 5 |
| 4 — Bun + Elysia | 2–3 weeks | 5 |
| 5 — Docs | ongoing | all |

**~8–11 weeks** of focused work. Phases 0–2 deliver most of the value and are
~5 weeks; if the effort has to stop somewhere, stop after 2 and the codebase is
still dramatically better than it is today.

---

## 11. Open questions

1. **Is `balloon.service.v3.ts` live, or is `balloon.service.ts`?** Both exist.
   Determines whether Phase 2 deletes ~270 or ~460 lines.
2. **Is `web-push` still used**, or has FCM fully replaced it?
3. **What is the actual client-version distribution?** Phase 0's telemetry
   answers this and it drives the whole §5.3 scope.
4. **Does `sketchmate-platform` need to keep direct Mongo access**, or should it
   go through the API? Direct access is faster to write and a second copy of
   every invariant. Recommend: through the API, with the admin routes that
   already exist.
5. **Draw-sync scaling model** — §3.4 option (1), (2) or (3)? Needs ADR-0004
   before Phase 2 touches `drawSyncing.ts`.
6. **Keep Heroku for staging** after cutover, or use a Render preview
   environment?
