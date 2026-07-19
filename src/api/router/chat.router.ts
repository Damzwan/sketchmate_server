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

  const activeStatuses = ['temporary', 'mate', 'pending_mate', 'pending_invite', 'expired', 'blocked'];

  const activeConvos = conversations.map(c => {
    const partnerId = c.participants.find((p: any) => p._id.toString() !== user_id)?._id.toString();

    // Prefer the relationship that actually owns THIS conversation. Matching on
    // the partner alone picks an arbitrary row if a duplicate relationship pair
    // ever exists, which shows the conversation under the wrong status.
    const rel =
      relationships.find(r => r.conversation_id?.toString() === c._id.toString()) ??
      relationships.find(r => r.users.some(u => u.toString() === partnerId));

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

  const meOID = new Types.ObjectId(user_id);

  const relationships = await relationship_model.find({
    users: meOID,
    chat_status: 'pending_invite',
    action_user_id: { $ne: meOID }
  }).lean();

  if (!relationships.length) {
    ctx.body = [];
    return;
  }

  // Resolve each invite through the relationship's OWN conversation_id.
  //
  // This used to be `{ participants: { $in: partnerIds } }`, which matched every
  // conversation the partner had with ANYONE — not just with us. A single
  // pending invite from P therefore surfaced as one row per conversation P is
  // in: several of them attributed to P (duplicate invitations from the same
  // person) and the rest to strangers, because the partner lookup below falls
  // back to participants[0] when neither participant is us and the status
  // defaults to 'pending_invite'.
  const relByConversationId = new Map(
    relationships
      .filter(r => r.conversation_id)
      .map(r => [r.conversation_id!.toString(), r])
  );

  if (!relByConversationId.size) {
    ctx.body = [];
    return;
  }

  const conversations = await conversation_model.find({
    _id: { $in: [...relByConversationId.keys()].map(id => new Types.ObjectId(id)) },
    // Belt and braces: never return a conversation we aren't part of, even if a
    // relationship somehow points at a foreign one.
    participants: meOID
  })
    .populate('last_message')
    .populate('participants', PUBLIC_USER_FIELDS)
    .sort({ updatedAt: -1 })
    .lean();

  ctx.body = conversations.map(c => {
    const r = relByConversationId.get(c._id.toString());

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