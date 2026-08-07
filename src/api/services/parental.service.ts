import { Context, Next } from 'koa';
import { user_model } from '../../models/user.model';
import { isOldEnough } from '../../helper';
import { ParentalControls } from '../../types/types';

/**
 * Google Play Families policy — "Social Apps & Features".
 *
 * The client hides these features and asks a parent to switch them on, but a
 * hidden button is not a control: the same requests can be replayed from a
 * modified client. Every peer-to-peer surface therefore re-checks the account's
 * age and the adult-set flags here, at the point the exchange actually happens.
 *
 * Two rules the whole file rests on:
 *   1. Missing age = child. An account that never confirmed a birthday could be
 *      eight years old; treating "unknown" as "adult" is exactly the hole the
 *      policy is about.
 *   2. Missing flag = off. Consent is something a parent gave, never something
 *      inferred from an absent field.
 */

export type ChildFeature = 'mate_add' | 'mate_chat' | 'mate_send' | 'rooms';

const FEATURE_FLAG: Record<ChildFeature, keyof ParentalControls> = {
  mate_add: 'allow_mate_add',
  mate_chat: 'allow_mate_chat',
  mate_send: 'allow_mate_send',
  rooms: 'allow_rooms'
};

const FEATURE_MESSAGE: Record<ChildFeature, string> = {
  mate_add: 'Adding mates is switched off for this account. A parent or guardian can turn it on in Settings → Parental Controls.',
  mate_chat: 'Chat is switched off for this account. A parent or guardian can turn it on in Settings → Parental Controls.',
  mate_send: 'Sending drawings to mates is switched off for this account. A parent or guardian can turn it on in Settings → Parental Controls.',
  rooms: 'Shared drawing rooms are switched off for this account. A parent or guardian can turn it on in Settings → Parental Controls.'
};

interface AgeState {
  isChild: boolean;
  parental: ParentalControls;
}

/**
 * Short-lived cache. These two fields change rarely (a parent flipping a
 * switch, a birthday correction) but would otherwise cost a DB round trip on
 * every message and every draw event.
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { state: AgeState; expires: number }>();

/** Drop a user's cached state so a just-saved switch takes effect at once. */
export function invalidateParentalCache(userId: string) {
  cache.delete(String(userId));
}

export function isChildDob(dob?: Date | string | null): boolean {
  if (!dob) return true; // unknown age → child
  const date = dob instanceof Date ? dob : new Date(dob);
  if (isNaN(date.getTime())) return true;
  return !isOldEnough(date);
}

export async function getAgeState(userId: string): Promise<AgeState> {
  const key = String(userId);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.state;

  const doc = await user_model
    .findById(key)
    .select('date_of_birth parental')
    .lean() as { date_of_birth?: Date; parental?: ParentalControls } | null;

  // A user we can't find is not a user we should hand social features to.
  const state: AgeState = doc
    ? { isChild: isChildDob(doc.date_of_birth), parental: doc.parental || {} }
    : { isChild: true, parental: {} };

  cache.set(key, { state, expires: Date.now() + CACHE_TTL_MS });
  return state;
}

/** Adults always pass; children pass only on an explicit parental `true`. */
export async function isFeatureAllowed(
  userId: string,
  feature: ChildFeature
): Promise<boolean> {
  const { isChild, parental } = await getAgeState(userId);
  if (!isChild) return true;
  return parental[FEATURE_FLAG[feature]] === true;
}

/** True when the account may use features reserved for 13+ (strangers, public). */
export async function isAdultAccount(userId: string): Promise<boolean> {
  const { isChild } = await getAgeState(userId);
  return !isChild;
}

export function parentalErrorBody(feature: ChildFeature) {
  return {
    error: 'parental_locked',
    feature,
    message: FEATURE_MESSAGE[feature]
  };
}

/**
 * Koa middleware. Mirrors requireCapability's shape so routes read the same:
 * a structured 403 the client can turn into the "ask a grown-up" prompt.
 */
export function requireChildFeature(feature: ChildFeature) {
  return async (ctx: Context, next: Next) => {
    const userId = ctx.state.user?._id;
    if (!userId) return ctx.throw(401, 'Not authenticated');

    if (await isFeatureAllowed(userId.toString(), feature)) return next();

    ctx.status = 403;
    ctx.body = parentalErrorBody(feature);
  };
}

/** Blocks a route outright for under-13 accounts (public/stranger surfaces). */
export function requireAdultAccount(reason: string) {
  return async (ctx: Context, next: Next) => {
    const userId = ctx.state.user?._id;
    if (!userId) return ctx.throw(401, 'Not authenticated');

    if (await isAdultAccount(userId.toString())) return next();

    ctx.status = 403;
    ctx.body = { error: 'age_restricted', message: reason };
  };
}

/** Socket-side equivalent — sockets can't run Koa middleware. */
export async function checkSocketChildFeature(
  userId: string | undefined,
  feature: ChildFeature
): Promise<{ blocked: boolean; body?: ReturnType<typeof parentalErrorBody> }> {
  if (!userId) return { blocked: true, body: parentalErrorBody(feature) };
  const allowed = await isFeatureAllowed(userId, feature);
  return allowed ? { blocked: false } : { blocked: true, body: parentalErrorBody(feature) };
}

/**
 * Normalises a client-supplied `parental` object: booleans stay booleans, dates
 * are re-derived server-side, everything else is dropped. Without this the
 * generic user update would `$set` whatever shape arrived.
 */
export function sanitizeParental(input: any): ParentalControls | null {
  if (!input || typeof input !== 'object') return null;

  const out: ParentalControls = {};
  (Object.keys(FEATURE_FLAG) as ChildFeature[]).forEach((feature) => {
    const key = FEATURE_FLAG[feature];
    if (typeof input[key] === 'boolean') (out as any)[key] = input[key];
  });

  // Timestamps are "it happened", not "the client says it happened at": both
  // only ever move to now, so take the server clock and ignore the payload.
  if (input.reviewed_at) out.reviewed_at = new Date();
  if (input.safety_ack_at) out.safety_ack_at = new Date();

  return out;
}
