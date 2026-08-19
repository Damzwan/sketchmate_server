import { Context, Next } from 'koa';
import { legacy_usage_model } from '../models/legacy-usage.model';

/**
 * The pre-/v2 routes declared inline in api/router/router.ts. Only these are
 * counted — everything under /v2, /admin, /dev and /webhooks is current and
 * needs no census.
 *
 * Listed explicitly rather than inferred from "does the path start with /v2",
 * so a new route can never join this set by accident: adding one here is a
 * deliberate act, and the list doubles as the checklist for the removal work.
 */
const LEGACY_ROUTES = new Set([
  '/user',
  '/user/login',
  '/user/search_mate',
  '/user/update',
  '/user/img/:id',
  '/user/inbox/latest',
  '/partial_users',
  '/inbox',
  '/inbox/:userId/:inboxItemId',
  '/inbox/see/:id',
  '/subscribe',
  '/unsubscribe',
  '/sticker',
  '/sticker/:id',
  '/emblem',
  '/emblem/:id',
  '/saved',
  '/saved/:id',
  '/balloon',
  '/balloon/v2',
  '/balloon/:id'
]);

/**
 * Counts traffic to the legacy routes so their removal can be decided from data
 * instead of from memory. See models/legacy-usage.model.ts for what is stored
 * and why it is so little.
 *
 * Two properties matter more than accuracy here:
 *
 *   It never blocks the response. The counter is written after the handler has
 *   produced its body, and not awaited — a census must not add latency to the
 *   routes it is measuring.
 *
 *   It never fails a request. A telemetry write that throws would take down the
 *   exact endpoints this exists to protect, which would be an absurd way to
 *   lose an account-recovery route. Every error is swallowed at the .catch().
 *
 * Undercounting during a Mongo blip is acceptable; the decision is about orders
 * of magnitude, not exact totals.
 */
export async function legacyRouteTelemetry(ctx: Context, next: Next) {
  await next();

  // Set by koa-router once a route matched. Absent for 404s, which is correct:
  // an unmatched path is not evidence that anyone uses a legacy route.
  const route = (ctx as any)._matchedRoute as string | undefined;
  if (!route || !LEGACY_ROUTES.has(route)) return;

  const version = (ctx.get('X-App-Version') || '').trim() || 'unknown';
  const authenticated = ctx.get('Authorization')?.startsWith('Bearer ') ? 1 : 0;
  const now = new Date();

  legacy_usage_model
    .updateOne(
      { method: ctx.method, route, version: version.slice(0, 32) },
      {
        $inc: { count: 1, authenticated_count: authenticated },
        $set: { last_seen: now },
        $setOnInsert: { first_seen: now }
      },
      { upsert: true }
    )
    .catch(() => {
      /* Counting is best-effort by design — see the doc comment. */
    });
}
