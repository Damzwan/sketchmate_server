import Router from 'koa-router';
import { requireAuth } from '../../middleware/auth';
import { user_model } from '../../models/user.model';

/**
 * Engagement titles.
 *
 * Titles are earned, never sold. Ownership is stored in `inventory` under
 * `title.<id>` (same shape as cosmetics, so the client's `isOwned` works
 * unchanged). Eligibility is decided server-side — the client can't grant
 * itself a title.
 *
 *   early-tester → account created before the launch cutoff. Granted (with the
 *                  OG gift) by the v1 migration in user.router.ts — see
 *                  migrationGrants() in helper.ts. Stat-gated titles added later
 *                  get a new migration_version rather than a live re-check.
 *   supporter    → owns a purchased catalog item (a real IAP). Granted by the RC
 *                  webhook on genuine purchase events, and backfilled for
 *                  existing purchasers by the same migration.
 *   contributor  → granted on feedback submit (POST /feedback below)
 */

const TITLE_ITEM = {
  contributor: 'title.contributor'
} as const;

export const titlesRouter = new Router();

titlesRouter.post('/feedback', requireAuth, async (ctx) => {
  const { message } = (ctx.request.body ?? {}) as { message?: string };
  if (!message || !message.trim()) {
    return ctx.throw(400, 'message required');
  }


  const user = await user_model
    .findById(ctx.state.user._id)
    .select('inventory')
    .lean();
  if (!user) return ctx.throw(404, 'User not found');

  const granted = (user.inventory ?? []).includes(TITLE_ITEM.contributor)
    ? []
    : [TITLE_ITEM.contributor];

  await user_model.updateOne(
    { _id: ctx.state.user._id },
    { $addToSet: { inventory: TITLE_ITEM.contributor } }
  );

  ctx.body = { granted };
});

export default titlesRouter;
