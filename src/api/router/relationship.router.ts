import Router from 'koa-router';
import dayjs from 'dayjs';
import { Types } from 'mongoose';
import { requireAuth } from '../../middleware/auth';
import { relationship_model } from '../../models/relationship.model';
import { conversation_model } from '../../models/conversation.model';
import { user_model } from '../../models/user.model';
import { RelationshipDocument } from '../../types/mongoose.types';
import { sendSocketNotificationToUser } from '../socket/socket';
import { PUBLIC_USER_FIELDS } from '../../types/projections';

export const relationshipRouter = new Router();
relationshipRouter.use(requireAuth);

/**
 * RESPOND: Accept or Decline trials and mate requests
 */
relationshipRouter.post('/:id/respond', async (ctx) => {
  const { id } = ctx.params;
  const user_id = ctx.state.user._id.toString();
  const { action } = ctx.request.body as { action: 'accept' | 'decline' };

  const rel = await relationship_model.findById(id);

  if (!rel || !rel.users.map((u: Types.ObjectId) => u.toString()).includes(user_id)) {
    return ctx.throw(404, 'Relationship not found');
  }

  if (rel.action_user_id?.toString() === user_id) {
    return ctx.throw(400, 'Waiting for partner response');
  }

  const partnerId = rel.users.find((u: Types.ObjectId) => u.toString() !== user_id);

  if (action === 'accept') {
    if (rel.chat_status === 'pending_invite') {
      const expiresAt = dayjs().add(24, 'hours').toDate();

      if (!rel.conversation_id) return ctx.throw(400, 'No conversation found for this relationship');

      const populatedConvo = await conversation_model
        .findById(rel.conversation_id)
        .populate('participants', PUBLIC_USER_FIELDS)
        .populate('last_message')
        .lean() as any;

      if (!populatedConvo) return ctx.throw(404, 'Conversation not found');

      rel.chat_status = 'temporary';
      rel.expires_at = expiresAt;
      rel.deleted_at = undefined;
      await rel.save();

      populatedConvo.status = 'temporary';
      populatedConvo.trial_expires_at = expiresAt;
      populatedConvo.relationship_id = rel._id.toString();
      populatedConvo.initiator_id = rel.action_user_id?.toString();

      if (partnerId) {
        sendSocketNotificationToUser(partnerId.toString(), 'chat:request_accepted', {
          conversation: populatedConvo
        });
      }

      ctx.body = { success: true, conversation: populatedConvo };
    } else if (rel.chat_status === 'pending_mate') {
      rel.chat_status = 'mate';
      rel.expires_at = undefined;
      rel.cooldown_until = undefined;
      rel.deleted_at = undefined;

      if (partnerId) {
        rel.follows = [
          { follower: new Types.ObjectId(user_id), followed: partnerId },
          { follower: partnerId, followed: new Types.ObjectId(user_id) }
        ];
      }

      await rel.save();

      await user_model.updateMany(
        { _id: { $in: rel.users } },
        { $inc: { 'stats.mates': 1, 'stats.followers': 1, 'stats.following': 1 } }
      );

      const populatedConvo = rel.conversation_id
        ? await conversation_model
          .findById(rel.conversation_id)
          .populate('participants', PUBLIC_USER_FIELDS)
          .populate('last_message')
          .lean()
        : null;

      if (populatedConvo) {
        (populatedConvo as any).status = 'mate';
        (populatedConvo as any).relationship_id = rel._id.toString();
      }

      if (partnerId) {
        sendSocketNotificationToUser(partnerId.toString(), 'chat:mate_matched', {
          conversation: populatedConvo
        });
      }

      ctx.body = { success: true, conversation: populatedConvo };
    }
  } else {
    if (rel.chat_status === 'pending_invite') {
      const conversationId = rel.conversation_id;

      if (rel.follows.length === 0) {
        await rel.deleteOne();
      } else {
        rel.chat_status = 'none';
        rel.action_user_id = undefined;
        rel.conversation_id = undefined;
        await rel.save();
      }

      if (conversationId) {
        await conversation_model.deleteOne({ _id: conversationId });
      }

      if (partnerId) {
        sendSocketNotificationToUser(partnerId.toString(), 'chat:request_declined', {
          conversation_id: conversationId?.toString()
        });
      }

      ctx.body = { success: true };
    } else {
      const isTrialValid = rel.expires_at && dayjs().isBefore(dayjs(rel.expires_at));
      rel.chat_status = isTrialValid ? 'temporary' : 'expired';
      if (!isTrialValid) rel.deleted_at = dayjs().add(30, 'days').toDate();
      rel.action_user_id = undefined;
      await rel.save();

      const populatedConvo = rel.conversation_id
        ? await conversation_model
          .findById(rel.conversation_id)
          .populate('participants', PUBLIC_USER_FIELDS)
          .lean() as any
        : null;

      if (populatedConvo) {
        populatedConvo.status = rel.chat_status;
        populatedConvo.relationship_id = rel._id.toString();
      }

      if (partnerId) {
        sendSocketNotificationToUser(partnerId.toString(), 'chat:mate_declined', {
          conversation_id: rel.conversation_id?.toString(),
          conversation: populatedConvo,
          status: rel.chat_status
        });
      }

      ctx.body = { success: true, status: rel.chat_status, conversation: populatedConvo };
    }
  }
});

/**
 * FOLLOW / UNFOLLOW
 */
relationshipRouter.put('/follow/:target_id', async (ctx) => {
  const followerId = ctx.state.user._id.toString();
  const targetId = ctx.params.target_id;
  if (followerId === targetId) return ctx.throw(400, 'Cannot follow yourself');

  const sortedUsers = [followerId, targetId].sort();
  const followerOID = new Types.ObjectId(followerId);
  const followedOID = new Types.ObjectId(targetId);

  const existing = await relationship_model.findOne({
    users: sortedUsers,
    'follows.follower': followerOID,
    'follows.followed': followedOID
  });

  if (existing) {
    await Promise.all([
      relationship_model.updateOne(
        { users: sortedUsers },
        { $pull: { follows: { follower: followerOID, followed: followedOID } } }
      ),
      user_model.updateOne({ _id: followedOID }, { $inc: { 'stats.followers': -1 } }),
      user_model.updateOne({ _id: followerOID }, { $inc: { 'stats.following': -1 } })
    ]);
    ctx.body = { isFollowing: false };
  } else {
    await Promise.all([
      relationship_model.updateOne(
        { users: sortedUsers },
        {
          $setOnInsert: { users: sortedUsers },
          $addToSet: { follows: { follower: followerOID, followed: followedOID } }
        },
        { upsert: true }
      ),
      user_model.updateOne({ _id: followedOID }, { $inc: { 'stats.followers': 1 } }),
      user_model.updateOne({ _id: followerOID }, { $inc: { 'stats.following': 1 } })
    ]);
    ctx.body = { isFollowing: true };
  }
});

/**
 * BLOCK / UNBLOCK
 */
relationshipRouter.post('/block', async (ctx) => {
  const current_user_id = ctx.state.user._id.toString();
  const { target_id } = ctx.request.body;
  if (!target_id) return ctx.throw(400, 'target_id is required');
  if (current_user_id === target_id) return ctx.throw(400, 'You cannot block yourself');

  const sortedUsers = [current_user_id, target_id].sort();
  const oldRel = await relationship_model.findOne({ users: sortedUsers });

  await relationship_model.findOneAndUpdate(
    { users: sortedUsers },
    {
      users: sortedUsers,
      chat_status: 'blocked',
      blocked_by: new Types.ObjectId(current_user_id),
      action_user_id: undefined,
      conversation_id: undefined,
      follows: []
    },
    { upsert: true, new: true }
  );

  if (oldRel && oldRel.chat_status !== 'blocked') {
    const isPermanentMate = oldRel.chat_status === 'mate';
    const p1Stats = { mates: isPermanentMate ? -1 : 0, followers: 0, following: 0 };
    const p2Stats = { mates: isPermanentMate ? -1 : 0, followers: 0, following: 0 };

    oldRel.follows.forEach(f => {
      if (f.follower.toString() === sortedUsers[0].toString()) {
        p1Stats.following--;
        p2Stats.followers--;
      } else {
        p2Stats.following--;
        p1Stats.followers--;
      }
    });

    await Promise.all([
      user_model.updateOne({ _id: sortedUsers[0] }, {
        $inc: {
          'stats.mates': p1Stats.mates,
          'stats.followers': p1Stats.followers,
          'stats.following': p1Stats.following
        }
      }),
      user_model.updateOne({ _id: sortedUsers[1] }, {
        $inc: {
          'stats.mates': p2Stats.mates,
          'stats.followers': p2Stats.followers,
          'stats.following': p2Stats.following
        }
      })
    ]);
  }
  ctx.body = { success: true, message: 'User blocked' };
});

relationshipRouter.post('/unblock', async (ctx) => {
  const current_user_id = ctx.state.user._id.toString();
  const { target_id } = ctx.request.body;
  const sortedUsers = [current_user_id, target_id].sort();
  const rel = await relationship_model.findOne({ users: sortedUsers });

  if (rel?.chat_status === 'blocked' && rel.blocked_by?.toString() === current_user_id) {
    await relationship_model.deleteOne({ _id: rel._id });
    ctx.body = { success: true, message: 'User unblocked' };
  } else {
    ctx.throw(403, 'Permission denied');
  }
});

/**
 * UNFRIEND
 */
relationshipRouter.put('/unfriend/:target_id', async (ctx) => {
  const myId = ctx.state.user._id.toString();
  const targetId = ctx.params.target_id;
  const sortedUsers = [myId, targetId].sort();
  const oldRel = await relationship_model.findOne({ users: sortedUsers });

  if (!oldRel || ['expired', 'none', 'blocked'].includes(oldRel.chat_status)) {
    return ctx.throw(400, 'Invalid relationship state');
  }

  const rel = await relationship_model.findOneAndUpdate(
    { users: sortedUsers },
    {
      $set: {
        conversation_id: null,
        chat_status: 'expired',
        cooldown_until: dayjs().add(48, 'hours').toDate(),
        deleted_at: dayjs().add(30, 'days').toDate(),
        action_user_id: new Types.ObjectId(myId)
      }
    },
    { new: true }
  ) as RelationshipDocument;

  if (rel?.conversation_id) {
    await conversation_model.findByIdAndUpdate(rel.conversation_id, { $set: { deleted_at: dayjs().add(30, 'days').toDate() } });
  }

  if (oldRel.chat_status === 'mate') {
    await user_model.updateMany({ _id: { $in: sortedUsers } }, { $inc: { 'stats.mates': -1 } });
  }

  if (ctx.app.context.io) {
    ctx.app.context.io.to(targetId).emit('chat:mate_unfriended', { relationship_id: rel._id, unfriended_by: myId });
  }
  ctx.body = { success: true };
});

/**
 * MATE REQUEST
 */
relationshipRouter.post('/:conversation_id/mate-request', async (ctx) => {
  const { conversation_id } = ctx.params;
  const user_id = ctx.state.user._id;

  const rel = await relationship_model.findOneAndUpdate(
    { conversation_id: new Types.ObjectId(conversation_id) },
    { $set: { chat_status: 'pending_mate', action_user_id: user_id } },
    { new: true }
  );

  if (!rel) return ctx.throw(404, 'Relationship not found');

  const partnerId = rel.users.find(u => u.toString() !== user_id.toString());

  if (partnerId) {
    const populatedConvo = await conversation_model
      .findById(conversation_id)
      .populate('participants', PUBLIC_USER_FIELDS)
      .populate('last_message')
      .lean() as any;

    populatedConvo.status = 'pending_mate';
    populatedConvo.initiator_id = user_id.toString();
    populatedConvo.relationship_id = rel._id.toString();

    sendSocketNotificationToUser(partnerId.toString(), 'chat:mate_requested', {
      conversation_id,
      conversation: populatedConvo,
      wasExpired: false
    });
  }

  ctx.body = { success: true };
});

/**
 * NETWORK LISTS - now returns enriched user data so the cache can ingest it
 */
relationshipRouter.get('/:user_id/network/:type', async (ctx) => {
  const { user_id, type } = ctx.params;
  const { page = 1, limit = 20 } = ctx.query;
  const skip = (Number(page) - 1) * Number(limit);
  const oid = new Types.ObjectId(user_id);
  const query: any = { users: oid };

  if (type === 'blocked') {
    query.chat_status = 'blocked';
    query.blocked_by = oid;
  } else if (type === 'mates') {
    query.chat_status = { $in: ['mate', 'temporary', 'pending_mate'] };
  } else if (type === 'followers') {
    query.follows = { $elemMatch: { followed: oid } };
  } else if (type === 'following') {
    query.follows = { $elemMatch: { follower: oid } };
  }

  const rels = await relationship_model.find(query).sort({ updatedAt: -1 }).skip(skip).limit(Number(limit)).lean();
  const targetIds = rels.map(r => r.users.find(id => id.toString() !== user_id));
  // Use the projection — same fields we ship everywhere else
  const users = await user_model.find({ _id: { $in: targetIds } }).select(PUBLIC_USER_FIELDS).lean();

  ctx.body = users.map(u => {
    const rel = rels.find(r => r.users.some(id => id.toString() === u._id.toString()));
    return { ...u, chat_status: rel?.chat_status, expires_at: rel?.expires_at, relationship_id: rel?._id };
  });
});

relationshipRouter.get('/blocked-ids', async (ctx) => {
  const rels = await relationship_model.find({
    users: ctx.state.user._id,
    chat_status: 'blocked',
    blocked_by: ctx.state.user._id
  }).select('users').lean();
  ctx.body = rels.map(r => r.users.find(u => u.toString() !== ctx.state.user._id.toString()));
});

relationshipRouter.get('/:userId/stats', async (ctx) => {
  const user = await user_model.findById(ctx.params.userId).select('stats').lean();
  ctx.body = user?.stats || { mates: 0, followers: 0, following: 0, posts: 0 };
});