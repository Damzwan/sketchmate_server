# SketchMate API

Koa + Mongoose + socket.io backend for the SketchMate drawing app. Deployed to
Heroku from `dist/`; migrating to Bun/Elysia on Render — see
[`docs/BACKEND_REFACTOR_PLAN.md`](docs/BACKEND_REFACTOR_PLAN.md) for where that
stands and what order things happen in. **Read that plan before proposing
architectural changes**; most obvious suggestions are already sequenced there.

Related repos: `../sketchmate` (Ionic/Vue client), `../sketchmate-platform`
(Nuxt admin). Both are separate git repos today and are slated to merge into a
monorepo.

## Commands

```sh
pnpm start          # dev, nodemon + ts-node
pnpm build          # tsc → dist/
npx tsc --noEmit    # typecheck. Currently clean — keep it that way
pnpm lint           # eslint --fix
```

There is **no test suite**. Building one is the gate for the framework
migration, not an afterthought. Verify changes with `tsc --noEmit` and by
reading; do not claim a behavioural change is verified when it is not.

## Layout

```
src/
├── main.ts               app wiring, CORS, cron schedules
├── mongodb.ts            LEGACY god module — 850 lines, 8 domains, 22 importers.
│                         Do not add to it. New data access goes in a service.
├── helper.ts             mixed bag: image processing, versions, social stats
├── api/router/           one router per domain. The big ones also hold logic
├── api/services/         business logic. post.service.ts is the pattern to copy
├── api/socket/           socket.io handlers. drawSyncing.ts is the largest
├── models/               mongoose schemas
├── config/               catalog, quota, competition, notification constants
├── middleware/           auth, adminAuth, moderation capability gates
└── scripts/              one-off migrations. Not part of the running server
```

Target architecture is router → service → repository, grouped by domain.
`post.router.ts` + `post.service.ts` is the closest existing example. Move
toward it; do not invent a third pattern.

## Rules that are not obvious

- **Auth identity comes from the verified token, never from the request.**
  `ctx.state.auth_id` and `ctx.state.user._id` are set by `requireAuth`. A user
  id read from a path param, query string or body is not an identity claim.
  This has been the source of a real account-takeover bug here before; the
  comments recording those incidents are load-bearing documentation.
- **The pre-/v2 routes at the bottom of `api/router/router.ts` are mostly
  unauthenticated.** They exist for old installed clients. A census
  (`middleware/legacyTelemetry.middleware.ts`) is running to decide which can be
  removed. Do not add routes there, and do not remove one without checking
  `GET /admin/legacy-usage`.
- **`updateUser` writes an allowlist only.** Adding a schema field does not make
  it client-writable, deliberately — see the comment on `SELF_SERVICE_FIELDS`.
- **`inventory` and `subscription_tier` are owned by the RevenueCat webhook and
  the admin routes.** Nothing else grants paid entitlements.
- **The server is currently single-instance.** `userSocketMap` in
  `api/socket/socket.ts` and the room state in `drawSyncing.ts` are in-process,
  so a second instance would silently drop realtime messages. Cron schedules in
  `main.ts` would also double-fire. Both are tracked in the refactor plan.
- **Secrets are never committed.** `fcm.json` was in this repo's public history
  once and the key had to be revoked. Firebase credentials load via
  `FIREBASE_SERVICE_ACCOUNT` — see `src/firebase-credential.ts`.

## Comment style

Non-obvious decisions carry a paragraph saying *why*, including what went wrong
before. This is intentional and is the main design documentation the repo has.
Match it: explain reasoning and history, not what the line does. Preserve these
comments verbatim when moving code.
