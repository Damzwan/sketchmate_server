import Router from 'koa-router';
import { user_model } from '../../models/user.model';
import {
  grantsForRcProduct,
  CATALOG_BY_ID,
  LIFETIME_RC_PRODUCT,
  PRO_ENTITLEMENT,
  isPaidTier
} from '../../config/catalog.config';

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
 * Subscription state is ALSO settled here — the webhook is the only actor that
 * sees a refund or a lapse when the app isn't open. The client mirrors
 * `getCustomerInfo()` into `subscription_tier` on launch, but it can only do
 * that while it's running, so tier transitions must survive without it.
 *
 * Docs: https://www.revenuecat.com/docs/integrations/webhooks/event-types
 */

interface RcWebhookEvent {
  type: string;
  app_user_id: string;
  product_id: string;
  original_app_user_id?: string;
  entitlement_ids?: string[] | null;
  /** CANCELLATION only. UNSUBSCRIBE / BILLING_ERROR keep access until the period
   *  ends; CUSTOMER_SUPPORT / DEVELOPER_INITIATED are refunds — access is gone. */
  cancel_reason?: string;
  expiration_reason?: string;
}

interface RcWebhookBody {
  event: RcWebhookEvent;
}

const GRANT_EVENTS = new Set(['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE']);
// RC has no 'REFUND' event type — a refund arrives as CANCELLATION with a
// cancel_reason of CUSTOMER_SUPPORT / DEVELOPER_INITIATED, followed by an
// EXPIRATION. CANCELLATION is kept here for one-time cosmetic refunds.
const REVOKE_EVENTS = new Set(['CANCELLATION']);

// ─── Pro subscription lifecycle ───────────────────────────────────────────────
// Events that mean "this account currently has Pro access".
const PRO_ACTIVE_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'PRODUCT_CHANGE',
  'SUBSCRIPTION_EXTENDED'
]);
// Events that mean "access ended now". EXPIRATION covers both a natural lapse
// and the tail of a refund; a CANCELLATION only lands here when it's a refund
// (see `isRefundCancellation`) — a plain UNSUBSCRIBE keeps access until the
// paid period actually expires.
const PRO_ENDED_EVENTS = new Set(['EXPIRATION']);
const REFUND_CANCEL_REASONS = new Set(['CUSTOMER_SUPPORT', 'DEVELOPER_INITIATED']);

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
  const isRefundCancellation =
    event.type === 'CANCELLATION' &&
    REFUND_CANCEL_REASONS.has(event.cancel_reason ?? '');
  const isRevoke = REVOKE_EVENTS.has(event.type);

  // Does this event carry the Pro entitlement? Lifetime is handled by product_id
  // below, so this only ever matches a real subscription.
  const touchesPro = (event.entitlement_ids ?? []).includes(PRO_ENTITLEMENT);
  const isProEvent =
    touchesPro &&
    (PRO_ACTIVE_EVENTS.has(event.type) ||
      PRO_ENDED_EVENTS.has(event.type) ||
      event.type === 'CANCELLATION');

  // Always respond 200 quickly so RC doesn't retry on unknown event types.
  if (!isGrant && !isRevoke && !isProEvent) {
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

  // ─── Pro subscription tier ────────────────────────────────────────────────
  // Runs BEFORE the catalog-grant path: a Pro subscription maps to no catalog
  // grants, so without this it fell through as "unmapped" and the tier was
  // never written — a refunded subscriber kept `pro` (and Pro quotas) forever.
  if (isProEvent) {
    const active = PRO_ACTIVE_EVENTS.has(event.type);
    const ended = PRO_ENDED_EVENTS.has(event.type) || isRefundCancellation;

    // A plain UNSUBSCRIBE / BILLING_ERROR cancellation is not a loss of access —
    // the user keeps Pro until EXPIRATION fires. Acknowledge and do nothing.
    if (!active && !ended) {
      console.log(
        `[RC webhook] PRO cancellation (${event.cancel_reason}) for ${app_user_id} — ` +
        `access retained until expiration`
      );
      ctx.status = 200;
      ctx.body = { ok: true, noop: true };
      return;
    }

    try {
      if (active) {
        const result = await user_model.updateOne(
          // Never demote a lifetime owner to plain `pro`.
          { auth_id: app_user_id, subscription_tier: { $ne: 'lifetime' } },
          {
            $set: { subscription_tier: 'pro' },
            $addToSet: { inventory: SUPPORTER_TITLE }
          }
        );
        if (result.matchedCount === 0) {
          console.warn(
            `[RC webhook] PRO grant matched no non-lifetime user: ${app_user_id}`
          );
        } else {
          console.log(`[RC webhook] PRO granted to ${app_user_id} (${event.type})`);
        }
      } else {
        // Lapsed or refunded → free. Lifetime is a separate one-time purchase
        // and must survive a subscription ending.
        await user_model.updateOne(
          { auth_id: app_user_id, subscription_tier: { $ne: 'lifetime' } },
          { $set: { subscription_tier: 'free' } }
        );
        console.log(
          `[RC webhook] PRO revoked from ${app_user_id} ` +
          `(${event.type}${event.cancel_reason ? `/${event.cancel_reason}` : ''}` +
          `${event.expiration_reason ? `/${event.expiration_reason}` : ''})`
        );
      }
      ctx.status = 200;
      ctx.body = { ok: true, pro: active };
    } catch (err) {
      console.error('[RC webhook] DB error (pro)', err);
      ctx.status = 500;
      ctx.body = { error: 'Internal error' };
    }
    return;
  }

  // ─── Lifetime ─────────────────────────────────────────────────────────────
  // Lifetime is a one-time product with no catalog grants (it unlocks
  // everything via tier, not inventory). Handle it here so the webhook — not
  // just the client — persists it under the account. Grant → tier 'lifetime' +
  // Supporter title; refund → back to 'free'.
  if (product_id === LIFETIME_RC_PRODUCT) {
    try {
      if (isGrant) {
        const result = await user_model.updateOne(
          { auth_id: app_user_id },
          {
            $set: { subscription_tier: 'lifetime' },
            $addToSet: { inventory: SUPPORTER_TITLE }
          }
        );
        if (result.matchedCount === 0) {
          console.warn(`[RC webhook] no user matched auth_id: ${app_user_id}`);
        } else {
          console.log(`[RC webhook] LIFETIME granted to ${app_user_id}`);
        }
      } else {
        // Refund of lifetime → drop to free. Client re-reads customerInfo too.
        await user_model.updateOne(
          { auth_id: app_user_id },
          { $set: { subscription_tier: 'free' } }
        );
        console.log(`[RC webhook] LIFETIME revoked from ${app_user_id}`);
      }
      ctx.status = 200;
      ctx.body = { ok: true, lifetime: isGrant };
    } catch (err) {
      console.error('[RC webhook] DB error (lifetime)', err);
      ctx.status = 500;
      ctx.body = { error: 'Internal error' };
    }
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
      isPaidTier(user.subscription_tier) ||
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