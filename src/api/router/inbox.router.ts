import Router from 'koa-router';
import { requireAuth } from '../../middleware/auth';
import { getInboxItemsV2, removeFromInbox, seeInbox } from '../../mongodb';

export const inboxRouter = new Router();

inboxRouter.get('/', requireAuth, async (ctx) => {
  const { limit, lastDate } = ctx.query as any;

  // SECURE: Implicitly fetch for the authenticated user
  ctx.body = await getInboxItemsV2({
    user_id: ctx.state.user._id.toString(),
    limit: parseInt(limit) || 20,
    lastDate: lastDate ? new Date(lastDate) : undefined
  });
});

inboxRouter.delete('/:inboxId', requireAuth, async (ctx) => {
  ctx.body = await removeFromInbox({
    user_id: ctx.state.user._id.toString(),
    inbox_id: ctx.params.inboxId
  });
});

inboxRouter.post('/see/:inboxId', requireAuth, async (ctx) => {
  ctx.body = await seeInbox({
    inbox_id: ctx.params.inboxId,
    user_id: ctx.state.user._id.toString()
  });
});