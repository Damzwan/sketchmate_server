// /**
//  * RevenueCat webhook handler.
//  *
//  * SECURITY: RevenueCat sends an `Authorization: Bearer <secret>` header.
//  * Set `REVENUECAT_WEBHOOK_SECRET` in env and configure the same value in the
//  * RC dashboard. Reject any request that doesn't match.
//  *
//  * RC docs: https://www.revenuecat.com/docs/integrations/webhooks/event-types
//  *
//  * Events we care about for non-subscription / lifetime IAPs:
//  *   - INITIAL_PURCHASE      → first purchase, grant items
//  *   - NON_RENEWING_PURCHASE → one-time consumable/non-consumable
//  *   - RENEWAL               → subscriptions renewing (no-op for inventory)
//  *   - CANCELLATION          → subscription cancelled (no-op for inventory;
//  *                              we DON'T revoke purchased cosmetics)
//  *   - PRODUCT_CHANGE        → user switched plans (no-op for inventory)
//  *
//  * Subscription state (Pro/Lifetime) is read from RC on the client via
//  * `getCustomerInfo().entitlements.active`. We don't track it in inventory.
//  */
// import Router from 'koa-router';
//
// interface RcWebhookEvent {
//   type: string;
//   app_user_id: string;        // RC's user ID — match this to your auth_id
//   product_id: string;         // The product purchased
//   original_app_user_id?: string;
//   // ...many other fields, omitted
// }
//
// interface RcWebhookBody {
//   event: RcWebhookEvent;
// }
//
// const GRANT_EVENTS = new Set(['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE']);
//
// export const revenuecatWebhookRouter = new Router();
//
// revenuecatWebhookRouter.post('/webhooks/revenuecat', async (req: Request, res: Response) => {
//   // ─── Auth ─────────────────────────────────────────────────────────────────
//   const authHeader = req.headers.authorization;
//   const expected = `Bearer ${process.env.REVENUECAT_WEBHOOK_SECRET}`;
//   if (!authHeader || authHeader !== expected) {
//     return res.status(401).json({ error: 'Unauthorized' });
//   }
//
//   const body = req.body as RcWebhookBody;
//   const event = body?.event;
//   if (!event) {
//     return res.status(400).json({ error: 'Missing event' });
//   }
//
//   // Always respond 200 quickly so RC doesn't retry. Log + ignore unknown types.
//   if (!GRANT_EVENTS.has(event.type)) {
//     console.log(`[RC webhook] Ignoring event type: ${event.type}`);
//     return res.status(200).json({ ok: true, ignored: true });
//   }
//
//   const { app_user_id, product_id } = event;
//   if (!app_user_id || !product_id) {
//     console.warn('[RC webhook] Missing app_user_id or product_id', event);
//     return res.status(200).json({ ok: true, skipped: true });
//   }
//
//   // Look up what this product grants
//   const grants = grantsForRcProduct(product_id);
//   if (grants.length === 0) {
//     console.warn(`[RC webhook] No grants mapped for product_id: ${product_id}`);
//     return res.status(200).json({ ok: true, unmapped: true });
//   }
//
//   try {
//     // `app_user_id` should be the user's auth_id (configure on client via
//     // `Purchases.logIn(authId)`). If you use a different mapping, adjust here.
//     const result = await user_model.updateOne(
//       { auth_id: app_user_id },
//       { $addToSet: { inventory: { $each: grants } } }
//     );
//
//     if (result.matchedCount === 0) {
//       console.warn(`[RC webhook] No user found for auth_id: ${app_user_id}`);
//       // Still 200 — don't make RC retry forever for a missing user
//     } else {
//       console.log(
//         `[RC webhook] Granted ${grants.join(', ')} to user ${app_user_id} ` +
//         `(product: ${product_id}, event: ${event.type})`
//       );
//     }
//
//     return res.status(200).json({ ok: true, granted: grants });
//   } catch (err) {
//     console.error('[RC webhook] DB error', err);
//     return res.status(500).json({ error: 'Internal error' });
//   }
// });