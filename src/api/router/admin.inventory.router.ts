import Router from 'koa-router';
import { Types } from 'mongoose';
import { user_model } from '../../models/user.model';
import { CATALOG_BY_ID, grantsForSku } from '../../config/catalog.config';
import { requireAdminAuth } from '../../middleware/adminAuth.middleware';

/**
 * Admin inventory management.
 *
 * All routes require `is_admin: true` via `requireAdminAuth` (same pattern as
 * `devModerationRouter`).
 *
 * Use cases:
 *   - Customer support: "I purchased X but didn't get it" → grant
 *   - Promotions: free Sakura theme for a campaign
 *   - Compensation: blanket-grant after an incident
 *   - Testing: granting yourself items in QA
 */
export const adminInventoryRouter = new Router();

adminInventoryRouter.use(requireAdminAuth);

// ─── Grant items to a single user ────────────────────────────────────────────
// POST /admin/inventory/grant/:user_id
// Body: { items?: string[], skus?: string[], reason?: string }
//   - items: raw item IDs (e.g. "theme.midnight") — added as-is
//   - skus:  SKU IDs (e.g. "pack.sakura") — expanded via catalog grants
adminInventoryRouter.post('/grant/:user_id', async (ctx) => {
  const { user_id } = ctx.params;
  if (!user_id || !Types.ObjectId.isValid(user_id)) {
    return ctx.throw(400, 'Valid user_id required');
  }

  const { items = [], skus = [], reason } = ctx.request.body as {
    items?: string[];
    skus?: string[];
    reason?: string;
  };

  if (items.length === 0 && skus.length === 0) {
    return ctx.throw(400, 'No items or skus provided');
  }

  // Expand SKUs through the catalog
  const expanded = skus.flatMap((skuId) => {
    if (!CATALOG_BY_ID[skuId]) {
      console.warn(`[admin grant] unknown SKU: ${skuId}`);
      return [];
    }
    return grantsForSku(skuId);
  });

  const toGrant = Array.from(new Set([...items, ...expanded]));
  if (toGrant.length === 0) {
    return ctx.throw(400, 'No valid items resolved');
  }

  const result = await user_model.updateOne(
    { _id: user_id },
    { $addToSet: { inventory: { $each: toGrant } } }
  );

  if (result.matchedCount === 0) {
    return ctx.throw(404, 'User not found');
  }

  console.log(
    `[admin grant] ${ctx.state.user._id} → ${user_id}: [${toGrant.join(', ')}]` +
    (reason ? ` (${reason})` : '')
  );

  ctx.body = { success: true, granted: toGrant };
});

// ─── Revoke items from a user ────────────────────────────────────────────────
// POST /admin/inventory/revoke/:user_id
// Body: { items: string[], reason?: string }
adminInventoryRouter.post('/revoke/:user_id', async (ctx) => {
  const { user_id } = ctx.params;
  if (!user_id || !Types.ObjectId.isValid(user_id)) {
    return ctx.throw(400, 'Valid user_id required');
  }

  const { items, reason } = ctx.request.body as {
    items: string[];
    reason?: string;
  };

  if (!items?.length) {
    return ctx.throw(400, 'items[] required');
  }

  const result = await user_model.updateOne(
    { _id: user_id },
    { $pull: { inventory: { $in: items } } }
  );

  if (result.matchedCount === 0) {
    return ctx.throw(404, 'User not found');
  }

  console.log(
    `[admin revoke] ${ctx.state.user._id} → ${user_id}: [${items.join(', ')}]` +
    (reason ? ` (${reason})` : '')
  );

  ctx.body = { success: true, revoked: items };
});

// ─── Bulk grant (promotions) ─────────────────────────────────────────────────
// POST /admin/inventory/bulk-grant
// Body: { userIds?: string[], filter?: object, items: string[], reason?: string, confirm?: boolean }
adminInventoryRouter.post('/bulk-grant', async (ctx) => {
  const { userIds, filter, items, reason, confirm } = ctx.request.body as {
    userIds?: string[];
    filter?: Record<string, unknown>;
    items: string[];
    reason?: string;
    confirm?: boolean;
  };

  if (!items?.length) return ctx.throw(400, 'items[] required');
  if (!userIds?.length && !filter) {
    return ctx.throw(400, 'userIds or filter required');
  }

  const query = userIds?.length ? { _id: { $in: userIds } } : filter!;

  // Safety net — block accidental "grant to everyone" without explicit confirm
  const count = await user_model.countDocuments(query);
  if (count > 10_000 && !confirm) {
    ctx.status = 400;
    ctx.body = {
      error: `Bulk grant would affect ${count} users. Set confirm:true to proceed.`,
      count
    };
    return;
  }

  const result = await user_model.updateMany(
    query,
    { $addToSet: { inventory: { $each: items } } }
  );

  console.log(
    `[admin bulk-grant] ${ctx.state.user._id}: ${result.modifiedCount}/${count} ` +
    `users granted [${items.join(', ')}]` + (reason ? ` (${reason})` : '')
  );

  ctx.body = {
    success: true,
    matched: result.matchedCount,
    modified: result.modifiedCount,
    items
  };
});

// ─── Inspect a user's inventory ──────────────────────────────────────────────
// GET /admin/inventory/:user_id
adminInventoryRouter.get('/:user_id', async (ctx) => {
  const { user_id } = ctx.params;
  if (!user_id || !Types.ObjectId.isValid(user_id)) {
    return ctx.throw(400, 'Valid user_id required');
  }

  const user = await user_model
    .findById(user_id)
    .select('_id name inventory subscription_tier')
    .lean();

  if (!user) return ctx.throw(404, 'User not found');

  ctx.body = {
    _id: user._id,
    name: user.name,
    subscription_tier: user.subscription_tier,
    inventory: user.inventory || []
  };
});

export default adminInventoryRouter;