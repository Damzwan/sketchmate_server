import Router from 'koa-router';
import { user_model } from '../../models/user.model';
import { grantsForRcProduct, CATALOG_BY_ID } from '../../config/catalog.config';

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
 *   - CANCELLATION           → store refund of a one-time purchase → revoke
 *
 * We only ever touch inventory for products that map to catalog grants. A plain
 * subscription cancellation maps to nothing, so cosmetics are never stripped on
 * a lapsed Pro — only a real refund of a cosmetic revokes it.
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
const REVOKE_EVENTS = new Set(['CANCELLATION', 'REFUND']);

const SUPPORTER_TITLE = 'title.supporter';

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

  const isGrant = GRANT_EVENTS.has(event.type);
  const isRevoke = REVOKE_EVENTS.has(event.type);

  // Always respond 200 quickly so RC doesn't retry on unknown event types.
  if (!isGrant && !isRevoke) {
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

  // Only products that map to catalog grants touch inventory. This is also what
  // keeps a subscription CANCELLATION from stripping cosmetics — Pro maps to no
  // grants, so it falls through here.
  const grants = grantsForRcProduct(product_id);
  if (grants.length === 0) {
    console.warn(`[RC webhook] no grants mapped for product: ${product_id}`);
    ctx.status = 200;
    ctx.body = { ok: true, unmapped: true };
    return;
  }

  try {
    if (isGrant) {
      // Any purchase also earns the Supporter title.
      const grantsWithTitle = [...grants, SUPPORTER_TITLE];
      const result = await user_model.updateOne(
        { auth_id: app_user_id },
        { $addToSet: { inventory: { $each: grantsWithTitle } } }
      );

      if (result.matchedCount === 0) {
        console.warn(`[RC webhook] no user matched auth_id: ${app_user_id}`);
      } else {
        console.log(
          `[RC webhook] granted [${grantsWithTitle.join(', ')}] to ${app_user_id} ` +
          `(product: ${product_id}, event: ${event.type})`
        );
      }

      ctx.status = 200;
      ctx.body = { ok: true, granted: grantsWithTitle };
      return;
    }

    // ─── Revoke (refund) ──────────────────────────────────────────────────────
    // Pull the refunded product's items, then drop the Supporter title if the
    // user no longer owns ANY purchasable item and isn't Pro.
    await user_model.updateOne(
      { auth_id: app_user_id },
      { $pull: { inventory: { $in: grants } } }
    );

    const user = await user_model
      .findOne({ auth_id: app_user_id })
      .select('inventory subscription_tier')
      .lean();

    if (!user) {
      console.warn(`[RC webhook] no user matched auth_id: ${app_user_id}`);
      ctx.status = 200;
      ctx.body = { ok: true, revoked: grants };
      return;
    }

    const inventory = user.inventory ?? [];
    const stillSupporter =
      user.subscription_tier === 'pro' ||
      inventory.some((id) => Boolean(CATALOG_BY_ID[id]));

    const revoked = [...grants];
    if (!stillSupporter && inventory.includes(SUPPORTER_TITLE)) {
      await user_model.updateOne(
        { auth_id: app_user_id },
        { $pull: { inventory: SUPPORTER_TITLE } }
      );
      revoked.push(SUPPORTER_TITLE);
    }

    console.log(
      `[RC webhook] revoked [${revoked.join(', ')}] from ${app_user_id} ` +
      `(product: ${product_id}, event: ${event.type})`
    );

    ctx.status = 200;
    ctx.body = { ok: true, revoked };
  } catch (err) {
    console.error('[RC webhook] DB error', err);
    ctx.status = 500;
    ctx.body = { error: 'Internal error' };
  }
});