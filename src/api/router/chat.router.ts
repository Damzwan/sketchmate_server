import Router from 'koa-router';
import { conversation_model } from '../../models/conversation.model';
import { relationship_model } from '../../models/relationship.model';
import { requireAuth } from '../../middleware/auth';
import { message_model } from '../../models/message.model';
import { Types } from 'mongoose';
import { PUBLIC_USER_FIELDS } from '../../types/projections';
import { mateRequestStateFor } from '../services/mate-request.policy';

export const chatRouter = new Router();
chatRouter.use(requireAuth);

const conversationActivityAt = (conversation: any): number => {
  const timestamp = conversation.last_message?.createdAt ?? conversation.createdAt;
  return timestamp ? new Date(timestamp).getTime() : 0;
};

const ACTIVE_CHAT_STATUSES = ['temporary', 'mate', 'pending_mate', 'pending_invite', 'expired', 'blocked'];

/**
 * One compact startup response for unread counts, request counts and presence.
 * Message history is intentionally excluded and remains lazy per conversation.
 */
chatRouter.get('/shell', async (ctx) => {
  const userId = ctx.state.user._id.toString();
  const userOid = new Types.ObjectId(userId);

  const relationships = await relationship_model.find({
    users: userOid,
    chat_status: { $in: ACTIVE_CHAT_STATUSES }
  })
    .select('users conversation_id chat_status expires_at cooldown_until action_user_id blocked_by mate_requests')
    .lean();

  const conversationIds = relationships
    .map(rel => rel.conversation_id)
    .filter((id): id is Types.ObjectId => !!id);

  const onlineCandidates = new Set<string>();
  const blockedUserIds: string[] = [];
  for (const rel of relationships) {
    const partnerId = rel.users.find(id => id.toString() !== userId)?.toString();
    if (!partnerId) continue;
    if (['temporary', 'pending_mate', 'mate'].includes(rel.chat_status)) {
      onlineCandidates.add(partnerId);
    }
    if (rel.chat_status === 'blocked' && rel.blocked_by?.toString() === userId) {
      blockedUserIds.push(partnerId);
    }
  }

  const candidateIds = [...onlineCandidates];
  const conversationsPromise = conversationIds.length
    ? conversation_model.find({
      _id: { $in: conversationIds },
      participants: userOid
    })
      .populate('last_message')
      .populate('participants', PUBLIC_USER_FIELDS)
      .lean()
    : Promise.resolve([]);
  // All user rooms can be inspected in one adapter operation. The old endpoint
  // performed one fetchSockets() call per mate, which scaled startup latency
  // with the size of the social graph (and is especially costly with an adapter).
  const onlineSocketsPromise = candidateIds.length
    ? ctx.app.context.io.in(candidateIds).fetchSockets()
    : Promise.resolve([]);
  const [conversations, onlineSockets] = await Promise.all([
    conversationsPromise,
    onlineSocketsPromise
  ]);

  const conversationById = new Map(
    conversations.map(conversation => [conversation._id.toString(), conversation])
  );
  const activeChats: any[] = [];
  const pendingRequests: any[] = [];

  for (const rel of relationships) {
    const conversationId = rel.conversation_id?.toString();
    const conversation = conversationId ? conversationById.get(conversationId) : undefined;
    if (!conversation) continue;

    const hydrated = {
      ...conversation,
      status: rel.chat_status,
      trial_expires_at: rel.expires_at,
      cooldown_until: rel.cooldown_until,
      initiator_id: rel.action_user_id?.toString(),
      relationship_id: rel._id.toString(),
      ...mateRequestStateFor(rel as any, userId)
    };

    if (rel.chat_status === 'pending_invite' && rel.action_user_id?.toString() !== userId) {
      pendingRequests.push(hydrated);
    } else {
      activeChats.push(hydrated);
    }
  }

  activeChats.sort((a, b) => conversationActivityAt(b) - conversationActivityAt(a));
  pendingRequests.sort((a, b) => conversationActivityAt(b) - conversationActivityAt(a));

  const onlineSet = new Set<string>(
    onlineSockets
      .map((socket: any) => socket.data.user?._id?.toString())
      .filter((id: string | undefined): id is string => !!id)
  );

  ctx.body = {
    activeChats,
    pendingRequests,
    onlineFriendIds: candidateIds.filter(id => onlineSet.has(id)),
    blockedUserIds
  };
});

chatRouter.get('/active', async (ctx) => {
  const user_id = ctx.state.user._id.toString();

  const [conversations, relationships] = await Promise.all([
    conversation_model.find({ participants: user_id })
      .populate('last_message')
      .populate('participants', PUBLIC_USER_FIELDS)
      .lean(),
    relationship_model.find({ users: user_id })
      .select('users conversation_id chat_status expires_at cooldown_until action_user_id mate_requests')
      .lean()
  ]);

  if (!conversations.length) {
    ctx.body = [];
    return;
  }

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
      relationship_id: rel?._id?.toString(),
      // Per-viewer, so the client can hide the "Become Mates" affordance rather
      // than offer it and have the request rejected. Never the partner's state:
      // whether they've been declined is not this user's business.
      ...(rel ? mateRequestStateFor(rel as any, user_id) : {})
    };
  })
    .filter(c =>
      ACTIVE_CHAT_STATUSES.includes(c.status) &&
      // Incoming invites have their own `/requests` payload. Returning them in
      // both lists mounted duplicate overview rows and double-counted unread.
      !(c.status === 'pending_invite' && c.initiator_id !== user_id)
    )
    .sort((a, b) => conversationActivityAt(b) - conversationActivityAt(a));

  ctx.body = activeConvos;
});

chatRouter.get('/requests', async (ctx) => {
  const user_id = ctx.state.user._id.toString();

  const meOID = new Types.ObjectId(user_id);

  const relationships = await relationship_model.find({
    users: meOID,
    chat_status: 'pending_invite',
    action_user_id: { $ne: meOID }
  })
    .select('conversation_id chat_status action_user_id')
    .lean();

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
    .lean();

  ctx.body = conversations.map(c => {
    const r = relByConversationId.get(c._id.toString());

    return {
      ...c,
      status: r?.chat_status ?? 'pending_invite',
      initiator_id: r?.action_user_id?.toString(),
      relationship_id: r?._id?.toString()
    };
  }).sort((a, b) => conversationActivityAt(b) - conversationActivityAt(a));
});

chatRouter.get('/:id/messages', async (ctx) => {
  const { id } = ctx.params;
  const { before, limit } = ctx.query;

  const parsedLimit = Math.min(parseInt(limit as string, 10) || 20, 100);
  // Moderated-away messages don't come back in history. The removal write only
  // started taking effect once `moderation_status` was declared on the schema
  // (mongoose strict mode had been dropping it), so without this filter
  // "remove" from the mod dashboard still left the message on screen.
  const query: any = {
    conversation_id: id,
    moderation_status: { $ne: 'removed' }
  };
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

chatRouter.post('/read-all', async (ctx) => {
  const user_id = ctx.state.user._id.toString();
  await conversation_model.updateMany(
    {
      participants: new Types.ObjectId(user_id),
      [`unread_counts.${user_id}`]: { $gt: 0 }
    },
    { $set: { [`unread_counts.${user_id}`]: 0 } },
    // Reading is not conversation activity. In particular, it must not change
    // overview ordering or the timestamp shown beside the last message.
    { timestamps: false }
  );
  ctx.status = 204;
});

chatRouter.post('/:id/read', async (ctx) => {
  const user_id = ctx.state.user._id.toString();
  await conversation_model.updateOne(
    { _id: ctx.params.id, participants: new Types.ObjectId(user_id) },
    { $set: { [`unread_counts.${user_id}`]: 0 } },
    { timestamps: false }
  );
  ctx.status = 204;
});
