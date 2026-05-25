import Router from 'koa-router';
import { user_model } from '../../models/user.model';
import { grantsForRcProduct } from '../../config/catalog.config';

/**
 * RevenueCat webhook.
 *
 * SECURITY: RC sends `Authorization: Bearer <secret>`. Set
 * `REVENUECAT_WEBHOOK_SECRET` in env and configure the same value in the RC
 * dashboard. Any request that doesn't match is rejected.
 *
 * Events we care about for non-subscription / one-time IAPs (cosmetics,
 * brushes, packs):
 *   - INITIAL_PURCHASE       → grant items
 *   - NON_RENEWING_PURCHASE  → grant items (one-time consumable/non-consumable)
 *
 * Subscription state (Pro / Lifetime entitlement) is read on the client via
 * `Purchases.getCustomerInfo()` and synced through `subscription_tier` on
 * the user — NOT through inventory.
 *
 * Docs: https://www.revenuecat.com/docs/integrations/webhooks/event-types
 */

interface RcWebhookEvent {
  type: string;
  app_user_id: string;
  product_id: string;
  original_app_user_id?: string;
}

interface RcWebhookBody {
  event: RcWebhookEvent;
}

const GRANT_EVENTS = new Set(['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE']);

export const revenuecatWebhookRouter = new Router();

revenuecatWebhookRouter.post('/revenuecat', async (ctx) => {
  // ─── Auth ─────────────────────────────────────────────────────────────────
  const authHeader = ctx.request.headers.authorization;
  const expected = `Bearer ${process.env.REVENUECAT_WEBHOOK_SECRET}`;

  if (!authHeader || authHeader !== expected) {
    ctx.status = 401;// src/stores/auth.store.ts
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as RcWebhookBody;
  const event = body?.event;

  if (!event) {
    ctx.status = 400;
    ctx.body = { error: 'Missing event' };
    return;
  }

  // Always respond 200 quickly so RC doesn't retry on unknown event types.
  if (!GRANT_EVENTS.has(event.type)) {
    console.log(`[RC webhook] ignoring event: ${event.type}`);
    ctx.status = 200;
    ctx.body = { ok: true, ignored: true };
    return;
  }

  const { app_user_id, product_id } = event;
  if (!app_user_id || !product_id) {
    console.warn('[RC webhook] missing app_user_id or product_id', event);
    ctx.status = 200;
    ctx.body = { ok: true, skipped: true };
    return;
  }

  const grants = grantsForRcProduct(product_id);
  if (grants.length === 0) {
    console.warn(`[RC webhook] no grants mapped for product: ${product_id}`);
    ctx.status = 200;
    ctx.body = { ok: true, unmapped: true };
    return;
  }

  try {
    const result = await user_model.updateOne(
      { auth_id: app_user_id },
      { $addToSet: { inventory: { $each: grants } } }
    );

    if (result.matchedCount === 0) {
      console.warn(`[RC webhook] no user matched auth_id: ${app_user_id}`);
      // Still 200 — don't make RC retry forever for a missing user.
    } else {
      console.log(
        `[RC webhook] granted [${grants.join(', ')}] to ${app_user_id} ` +
        `(product: ${product_id}, event: ${event.type})`
      );
    }

    ctx.status = 200;
    ctx.body = { ok: true, granted: grants };
  } catch (err) {
    console.error('[RC webhook] DB error', err);
    ctx.status = 500;
    ctx.body = { error: 'Internal error' };
  }
});