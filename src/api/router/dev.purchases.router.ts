import Router from 'koa-router';
import { requireAuth } from '../../middleware/auth';
import { user_model } from '../../models/user.model';
import { isDev } from '../../config/app.config';
import {
  grantsForSku,
  CATALOG_BY_ID,
  isPaidTier
} from '../../config/catalog.config';

/**
 * Dev-only purchase tooling.
 *
 * Simulates a RevenueCat refund so the whole revoke path (inventory pull,
 * Supporter re-check, tier reset) can be exercised locally without touching the
 * RC dashboard. Mirrors `revenuecat.webhook.ts` revoke logic exactly.
 *
 * Hard-gated: returns 404 unless NODE_ENV === 'development', so it can never be
 * reached in production even if the route stays mounted.
 */

const SUPPORTER_TITLE = 'title.supporter';

export const devPurchasesRouter = new Router();

devPurchasesRouter.use(async (ctx, next) => {
  if (!isDev) return ctx.throw(404);
  await next();
});
devPurchasesRouter.use(requireAuth);

// POST /v2/dev/purchases/refund
// Body: { skuId?: string; resetTier?: boolean }
//   - skuId:     refund a purchasable SKU — pull its catalog grants
//   - resetTier: drop subscription_tier back to 'free' (simulate a Lifetime /
//                Pro refund)
// After either, the Supporter title is dropped if the user no longer owns any
// purchasable item and isn't on a paid tier — same rule as the webhook.
devPurchasesRouter.post('/refund', async (ctx) => {
  const { skuId, resetTier } = (ctx.request.body ?? {}) as {
    skuId?: string;
    resetTier?: boolean;
  };

  const userId = ctx.state.user._id;

  if (resetTier) {
    await user_model.updateOne(
      { _id: userId },
      { $set: { subscription_tier: 'free' } }
    );
  }

  const grants = skuId ? grantsForSku(skuId) : [];
  if (grants.length) {
    await user_model.updateOne(
      { _id: userId },
      { $pull: { inventory: { $in: grants } } }
    );
  }

  // Re-check Supporter exactly like the webhook does.
  const user = await user_model
    .findById(userId)
    .select('inventory subscription_tier')
    .lean();
  const inventory = user?.inventory ?? [];
  const stillSupporter =
    isPaidTier(user?.subscription_tier) ||
    inventory.some((id) => Boolean(CATALOG_BY_ID[id]));

  if (!stillSupporter && inventory.includes(SUPPORTER_TITLE)) {
    await user_model.updateOne(
      { _id: userId },
      { $pull: { inventory: SUPPORTER_TITLE } }
    );
  }

  console.log(
    `[dev refund] user ${userId} skuId=${skuId ?? '-'} resetTier=${!!resetTier}`
  );

  ctx.body = { ok: true, refundedSku: skuId ?? null, tierReset: !!resetTier };
});

export default devPurchasesRouter;
