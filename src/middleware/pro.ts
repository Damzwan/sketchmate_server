import { isPaidTier } from '../config/catalog.config';

/**
 * Pro gate. Mount AFTER `requireAuth` — it reads the tier that middleware
 * already selected onto `ctx.state.user`, so gating costs no extra query.
 *
 * Server-side enforcement is the point: the client hides Pro-only features, but
 * the tier on the account is what actually decides whether bytes get stored.
 */
export const requirePro = async (ctx: any, next: () => Promise<any>) => {
  if (!ctx.state.user) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (!isPaidTier(ctx.state.user.subscription_tier)) {
    ctx.status = 403;
    ctx.body = { error: 'pro_required' };
    return;
  }

  await next();
};
