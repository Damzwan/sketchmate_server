import mongoose, { Schema } from 'mongoose';

/**
 * Hit counter for the pre-/v2 routes defined inline in api/router/router.ts.
 *
 * Those routes are almost all unauthenticated and take the user id from the
 * path or query, which makes them the largest remaining attack surface on the
 * API. They exist for clients shipped before /v2, and nobody currently knows
 * which of them are still called or by what.
 *
 * Guessing is not an option — deleting a route an installed client still uses
 * breaks that client permanently, since app updates are not something a user
 * can be made to take. So this counts first. One document per
 * (method, route, version) with a running total; a week of data is enough to
 * decide, per route, between "delete" and "authenticate behind a version gate".
 *
 * Deliberately not stored: user ids, IPs, payloads. The decision only needs
 * shape and volume, and this collection should be safe to keep indefinitely
 * and safe to hand to whoever asks. Drop the whole collection once the legacy
 * routes are gone.
 */
const legacy_usage_schema = new Schema({
  method: { type: String, required: true },

  // The matched Koa route pattern (`/user/img/:id`), never the raw URL, so ids
  // in the path can't turn this into one document per request.
  route: { type: String, required: true },

  // From the X-App-Version header. 'unknown' is the interesting bucket: it
  // means a client too old to send the header, which is exactly the population
  // that would break if the route disappeared.
  version: { type: String, required: true, default: 'unknown' },

  count: { type: Number, default: 0 },

  // How many of those hits carried a bearer token. A route whose traffic is
  // fully authenticated can have requireAuth added without a version gate.
  authenticated_count: { type: Number, default: 0 },

  first_seen: { type: Date, default: Date.now },
  last_seen: { type: Date, default: Date.now }
});

legacy_usage_schema.index({ method: 1, route: 1, version: 1 }, { unique: true });

export const legacy_usage_model = mongoose.model('legacy_usage', legacy_usage_schema);
