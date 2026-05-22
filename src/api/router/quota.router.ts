import Router from 'koa-router';
import { requireAuth } from '../../middleware/auth';
import { getQuotaSummary } from '../services/quota.service';

export const quotaRouter = new Router();

quotaRouter.get('/me', requireAuth, async (ctx) => {
  try {
    ctx.body = await getQuotaSummary(ctx.state.user._id.toString());
  } catch (error) {
    console.error('Quota fetch error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch quota' };
  }
});