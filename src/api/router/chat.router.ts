import Router from 'koa-router';
import { conversation_model } from '../../models/conversation.model';
import { relationship_model } from '../../models/relationship.model';
import { requireAuth } from '../../middleware/auth';
import { message_model } from '../../models/message.model';
import { Types } from 'mongoose';
import { PUBLIC_USER_FIELDS } from '../../types/projections';

export const chatRouter = new Router();
chatRouter.use(requireAuth);

chatRouter.get('/active', async (ctx) => {
  const user_id = ctx.state.user._id.toString();

  const conversations = await conversation_model.find({
    participants: user_id
  })
    .populate('last_message')
    .populate('participants', PUBLIC_USER_FIELDS)
    .sort({ updatedAt: -1 })
    .lean();

  if (!conversations.length) {
    ctx.body = [];
    return;
  }

  const relationships = await relationship_model.find({
    users: user_id
  }).lean();

  // ADDED 'blocked' to the allowed statuses!
  const activeStatuses = ['temporary', 'mate', 'pending_mate', 'pending_invite', 'expired', 'blocked'];

  const activeConvos = conversations.map(c => {
    const partnerId = c.participants.find((p: any) => p._id.toString() !== user_id)?._id.toString();

    const rel = relationships.find(r =>
      r.users.some(u => u.toString() === partnerId)
    );

    return {
      ...c,
      status: rel?.chat_status || 'none',
      trial_expires_at: rel?.expires_at,
      cooldown_until: rel?.cooldown_until,
      initiator_id: rel?.action_user_id?.toString(),
      relationship_id: rel?._id?.toString()
    };
  }).filter(c => activeStatuses.includes(c.status));

  ctx.body = activeConvos;
});

chatRouter.get('/requests', async (ctx) => {
  const user_id = ctx.state.user._id.toString();

  const relationships = await relationship_model.find({
    users: new Types.ObjectId(user_id),
    chat_status: 'pending_invite',
    action_user_id: { $ne: new Types.ObjectId(user_id) }
  }).lean();

  if (!relationships.length) {
    ctx.body = [];
    return;
  }

  const partnerIds = relationships.map(r =>
    r.users.find(u => u.toString() !== user_id)
  ).filter(Boolean) as Types.ObjectId[];

  const conversations = await conversation_model.find({
    participants: { $in: partnerIds }
  })
    .populate('last_message')
    .populate('participants', PUBLIC_USER_FIELDS)
    .sort({ updatedAt: -1 })
    .lean();

  const relByPartnerId = new Map(
    relationships.map(r => {
      const partnerId = r.users.find(u => u.toString() !== user_id)?.toString();
      return [partnerId, r];
    })
  );

  ctx.body = conversations.map(c => {
    const partnerId = (c.participants as any[])
      .find(p => p._id.toString() !== user_id)?._id.toString();
    const r = partnerId ? relByPartnerId.get(partnerId) : undefined;

    return {
      ...c,
      status: r?.chat_status ?? 'pending_invite',
      initiator_id: r?.action_user_id?.toString(),
      relationship_id: r?._id?.toString()
    };
  });
});

chatRouter.get('/:id/messages', async (ctx) => {
  const { id } = ctx.params;
  const { before, limit } = ctx.query;

  const parsedLimit = Math.min(parseInt(limit as string, 10) || 20, 100);
  const query: any = { conversation_id: id };
  if (before) query.createdAt = { $lt: new Date(before as string) };

  const messages = await message_model
    .find(query)
    .sort({ createdAt: -1 })
    .limit(parsedLimit)
    .lean();

  ctx.body = {
    data: messages.reverse(),
    hasMore: messages.length === parsedLimit
  };
});

chatRouter.post('/:id/read', async (ctx) => {
  const user_id = ctx.state.user._id.toString();
  await conversation_model.updateOne(
    { _id: ctx.params.id },
    { $set: { [`unread_counts.${user_id}`]: 0 } }
  );
  ctx.status = 204;
});