import Router from 'koa-router';
import { requireAdminAuth } from '../../middleware/adminAuth.middleware';
import { legacy_usage_model } from '../../models/legacy-usage.model';

/**
 * Read side of the pre-/v2 route census. See models/legacy-usage.model.ts for
 * why the census exists and middleware/legacyTelemetry.middleware.ts for what
 * feeds it.
 *
 * Admin-gated purely because it describes the shape of the API's weakest
 * surface. It holds no user data.
 */
export const adminLegacyUsageRouter = new Router();

adminLegacyUsageRouter.use(requireAdminAuth);

adminLegacyUsageRouter.get('/', async (ctx) => {
  const rows = await legacy_usage_model.find().lean();

  // Rolled up per route, because the decision is per route: keep it, delete it,
  // or put it behind auth. The per-version split is what makes that decision —
  // traffic that is entirely `unknown` is old clients and cannot be broken;
  // traffic that is entirely current-version means the modern client still
  // depends on the route and it needs migrating, not deleting.
  const byRoute = new Map<string, {
    method: string;
    route: string;
    total: number;
    authenticated: number;
    versions: Record<string, number>;
    first_seen: Date;
    last_seen: Date;
  }>();

  for (const row of rows) {
    const key = `${row.method} ${row.route}`;
    const entry = byRoute.get(key) ?? {
      method: row.method,
      route: row.route,
      total: 0,
      authenticated: 0,
      versions: {} as Record<string, number>,
      first_seen: row.first_seen,
      last_seen: row.last_seen
    };

    entry.total += row.count;
    entry.authenticated += row.authenticated_count;
    entry.versions[row.version] = (entry.versions[row.version] ?? 0) + row.count;
    if (row.first_seen < entry.first_seen) entry.first_seen = row.first_seen;
    if (row.last_seen > entry.last_seen) entry.last_seen = row.last_seen;

    byRoute.set(key, entry);
  }

  const routes = [...byRoute.values()].sort((a, b) => b.total - a.total);

  ctx.body = {
    // A route with no row at all never fired once since the census started —
    // the strongest possible signal, and the one that is easy to miss when
    // reading a list of what *did* fire.
    observed_routes: routes.length,
    total_hits: routes.reduce((sum, r) => sum + r.total, 0),
    routes
  };
});

export default adminLegacyUsageRouter;
