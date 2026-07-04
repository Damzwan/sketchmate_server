import Router from 'koa-router';
import { requireAuth } from '../../middleware/auth';
import { user_model } from '../../models/user.model';
import { CATALOG_BY_ID, isPaidTier } from '../../config/catalog.config';

/**
 * Engagement titles.
 *
 * Titles are earned, never sold. Ownership is stored in `inventory` under
 * `title.<id>` (same shape as cosmetics, so the client's `isOwned` works
 * unchanged). Eligibility is decided HERE, server-side — the client only
 * triggers a re-check; it can't grant itself a title.
 *
 *   early-tester → account created before the launch cutoff
 *   supporter    → Pro, or owns any purchasable catalog item
 *   contributor  → granted on feedback submit (POST /feedback below); there's
 *                  no eligibility to re-check, so /sync doesn't handle it
 *
 * `/sync` is idempotent ($addToSet) so the client can call it freely — on
 * login, after a purchase, etc.
 */

const TITLE_ITEM = {
  earlyTester: 'title.early-tester',
  contributor: 'title.contributor',
  supporter: 'title.supporter'
} as const;

const EARLY_TESTER_CUTOFF = new Date('2026-07-30T23:59:59Z');

function ownsAnyPurchasable(inventory: string[]): boolean {
  return inventory.some((id) => Boolean(CATALOG_BY_ID[id]));
}

/** Server-verifiable titles the user currently qualifies for. */
function eligibleTitles(user: {
  createdAt?: Date;
  subscription_tier?: string;
  inventory?: string[];
}): string[] {
  const out: string[] = [];
  const inventory = user.inventory ?? [];

  if (!user.createdAt || new Date(user.createdAt) <= EARLY_TESTER_CUTOFF) {
    out.push(TITLE_ITEM.earlyTester);
  }
  if (isPaidTier(user.subscription_tier) || ownsAnyPurchasable(inventory)) {
    out.push(TITLE_ITEM.supporter);
  }
  return out;
}

export const titlesRouter = new Router();

titlesRouter.post('/sync', requireAuth, async (ctx) => {
  const user = await user_model
    .findById(ctx.state.user._id)
    .select('createdAt subscription_tier inventory')
    .lean();

  if (!user) return ctx.throw(404, 'User not found');

  const owned = new Set(user.inventory ?? []);
  const toGrant = eligibleTitles(user).filter((id) => !owned.has(id));

  if (toGrant.length) {
    await user_model.updateOne(
      { _id: ctx.state.user._id },
      { $addToSet: { inventory: { $each: toGrant } } }
    );
    console.log(`[titles] granted [${toGrant.join(', ')}] to ${ctx.state.user._id}`);
  }

  ctx.body = { granted: toGrant };
});

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
