import { Types } from 'mongoose';
import { user_model } from '../../models/user.model';
import { CATALOG_BY_ID, grantsForSku } from '../../config/catalog.config';

/**
 * Inventory granting — one implementation, several callers.
 *
 * Extracted from admin.inventory.router so that automated grants (competition
 * rewards) and manual ones (support, promos) cannot drift apart. Every grant
 * logs, because "why do I own this?" is a real support question.
 */

export interface GrantResult {
  granted: string[];
  /** False when the user id matched nothing — caller decides if that's fatal. */
  matched: boolean;
}

/** Expand a mix of raw item ids and SKU ids into a deduped item id list. */
export function resolveGrantItems(items: string[] = [], skus: string[] = []): string[] {
  const expanded = skus.flatMap((skuId) => {
    if (!CATALOG_BY_ID[skuId]) {
      console.warn(`[inventory] unknown SKU: ${skuId}`);
      return [];
    }
    return grantsForSku(skuId);
  });
  return Array.from(new Set([...items, ...expanded]));
}

export async function grantItems(
  userId: string | Types.ObjectId,
  items: string[],
  reason: string
): Promise<GrantResult> {
  if (!items.length) return { granted: [], matched: true };

  const result = await user_model.updateOne(
    { _id: userId },
    { $addToSet: { inventory: { $each: items } } }
  );

  if (result.matchedCount === 0) return { granted: [], matched: false };

  console.log(`[inventory grant] ${userId}: [${items.join(', ')}] (${reason})`);
  return { granted: items, matched: true };
}

export async function revokeItems(
  userId: string | Types.ObjectId,
  items: string[],
  reason: string
): Promise<GrantResult> {
  if (!items.length) return { granted: [], matched: true };

  const result = await user_model.updateOne(
    { _id: userId },
    { $pull: { inventory: { $in: items } } }
  );

  if (result.matchedCount === 0) return { granted: [], matched: false };

  console.log(`[inventory revoke] ${userId}: [${items.join(', ')}] (${reason})`);
  return { granted: items, matched: true };
}

/** Which of `items` the user does NOT already own. Used to grant a title once. */
export async function missingItems(
  userId: string | Types.ObjectId,
  items: string[]
): Promise<string[]> {
  const user = await user_model.findById(userId).select('inventory').lean();
  if (!user) return [];
  const owned = new Set(user.inventory ?? []);
  return items.filter((id) => !owned.has(id));
}
