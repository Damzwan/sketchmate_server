import Router from 'koa-router';
import { requireAuth } from '../../middleware/auth';
import { notification_model } from '../../models/notification.model';

export const notificationRouter = new Router();
notificationRouter.use(requireAuth);

// Paginated feed
notificationRouter.get('/', async (ctx) => {
  const { before, limit } = ctx.query;
  const parsedLimit = Math.min(parseInt(limit as string, 10) || 20, 50);

  const query: any = { recipient_id: ctx.state.user._id };
  if (before) query.updatedAt = { $lt: new Date(before as string) };

  const items = await notification_model
    .find(query)
    .sort({ updatedAt: -1 })   // sort by updatedAt so aggregated entries bubble up
    .limit(parsedLimit)
    .lean();

  ctx.body = { data: items, hasMore: items.length === parsedLimit };
});

// Badge count — split so the client can show "5 unseen on the bell, 12 unread inside"
notificationRouter.get('/counts', async (ctx) => {
  const [unseen, unread] = await Promise.all([
    notification_model.countDocuments({ recipient_id: ctx.state.user._id, seen: false }),
    notification_model.countDocuments({ recipient_id: ctx.state.user._id, read: false })
  ]);
  ctx.body = { unseen, unread };
});

// Mark all as seen (when they open the bell)
notificationRouter.post('/seen', async (ctx) => {
  await notification_model.updateMany(
    { recipient_id: ctx.state.user._id, seen: false },
    { $set: { seen: true } }
  );
  ctx.status = 204;
});

// Mark one as read (when they tap)
notificationRouter.post('/:id/read', async (ctx) => {
  await notification_model.updateOne(
    { _id: ctx.params.id, recipient_id: ctx.state.user._id },
    { $set: { read: true, seen: true } }
  );
  ctx.status = 204;
});

notificationRouter.delete('/:id', async (ctx) => {
  await notification_model.deleteOne({
    _id: ctx.params.id,
    recipient_id: ctx.state.user._id
  });
  ctx.status = 204;
});

notificationRouter.post('/read-all', async (ctx) => {
  await notification_model.updateMany(
    { recipient_id: ctx.state.user._id, read: false },
    { $set: { read: true, seen: true } }
  );
  ctx.status = 204;
});