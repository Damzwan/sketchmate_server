import Router from 'koa-router';
import dayjs from 'dayjs';
import { Types } from 'mongoose';
import { requireAuth } from '../../middleware/auth';
import { Capability, isCapabilityBlocked } from '../../types/moderation.policy';
import { relationship_model } from '../../models/relationship.model';
import { conversation_model } from '../../models/conversation.model';
import { user_model } from '../../models/user.model';
import { RelationshipDocument } from '../../types/mongoose.types';
import { isUserOnline, sendSocketNotificationToUser } from '../socket/socket';
import { PUBLIC_USER_FIELDS } from '../../types/projections';
import { requireCapability } from '../../middleware/moderation.middleware';
import { assertMateQuota } from '../services/quota.service';
import { dispatchNotification } from '../services/notification.service';
import {
  matchNotification,
  mateRequestPushNotification,
  requestAcceptedPushNotification
} from '../../config/notification.config';
import { mixpanelEvents, trackEvent } from '../../mixpanel';

export const relationshipRouter = new Router();
relationshipRouter.use(requireAuth);

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
        // ─── REPLACES: sendSocketNotificationToUser('chat:request_accepted', ...) ───
        dispatchNotification({
          recipient_id: partnerId.toString(),
          type: 'dm_message',
          actor: {
            _id: user_id,
            name: ctx.state.user.name,
            img: ctx.state.user.img
          },
          channels: {
            in_app: false,
            socket: {
              event: 'chat:request_accepted',
              data: { conversation: populatedConvo }
            },
            push: requestAcceptedPushNotification(ctx.state.user.name, ctx.state.user.img, rel.conversation_id.toString())
          }
        }).catch(err => console.error('Request accept dispatch failed:', err));
      }

      ctx.body = { success: true, conversation: populatedConvo };
    } else if (rel.chat_status === 'pending_mate') {
      await assertMateQuota(user_id);
      if (partnerId) {
        await assertMateQuota(partnerId.toString());
      }

      rel.chat_status = 'mate';
      rel.expires_at = undefined;
      rel.cooldown_until = undefined;
      rel.deleted_at = undefined;
      await rel.save();

      await user_model.updateMany(
        { _id: { $in: rel.users } },
        { $inc: { 'stats.mates': 1 } }
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
        // ─── REPLACES: sendSocketNotificationToUser('chat:mate_matched', ...) ───
        dispatchNotification({
          recipient_id: partnerId.toString(),
          type: 'dm_message',
          actor: {
            _id: user_id,
            name: ctx.state.user.name,
            img: ctx.state.user.img
          },
          channels: {
            in_app: false,
            socket: {
              event: 'chat:mate_matched',
              data: { conversation: populatedConvo }
            },
            push: matchNotification(ctx.state.user.name)
          }
        }).catch(err => console.error('Mate match dispatch failed:', err));
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
    } else if (rel.chat_status === 'pending_mate') {
      const isTrialValid = rel.expires_at && dayjs().isBefore(dayjs(rel.expires_at));
      rel.chat_status = isTrialValid ? 'temporary' : 'expired';
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
    } else {
      ctx.throw(400, 'Invalid state for decline');
    }
  }

  trackEvent(user_id, mixpanelEvents.mate_respond_v2, {
    action,
    resulting_status: rel.chat_status,
    partner_id: partnerId?.toString()
  });

  const partnerIsOnline = partnerId ? await isUserOnline(ctx.app.context.io, partnerId.toString()) : false;
  const iAmOnline = await isUserOnline(ctx.app.context.io, user_id);

  if (partnerIsOnline && partnerId) {
    sendSocketNotificationToUser(partnerId.toString(), 'friend:online', { user_id, status: 'online' });
  }
  if (iAmOnline && partnerIsOnline && partnerId) {
    sendSocketNotificationToUser(user_id, 'friend:online', { user_id: partnerId.toString(), status: 'online' });
  }
});

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
    // UNFOLLOW — silent. No notification on unfollow.
    await Promise.all([
      relationship_model.updateOne(
        { users: sortedUsers },
        { $pull: { follows: { follower: followerOID, followed: followedOID } } }
      ),
      user_model.updateOne({ _id: followedOID }, { $inc: { 'stats.followers': -1 } }),
      user_model.updateOne({ _id: followerOID }, { $inc: { 'stats.following': -1 } })
    ]);
    trackEvent(followerId, mixpanelEvents.unfollow_v2, { target_id: targetId });
    ctx.body = { isFollowing: false };
    return;
  }

  const userRestriction = ctx.state.user.restriction;
  const userLevel = userRestriction?.level ?? 0;

  if (isCapabilityBlocked(userLevel, Capability.FOLLOW_USER)) {
    ctx.status = 403;
    ctx.body = {
      error: 'capability_blocked',
      capability: Capability.FOLLOW_USER,
      restriction: {
        level: userLevel,
        reason: userRestriction?.reason,
        expires_at: userRestriction?.expires_at
      }
    };
    return;
  }

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

  dispatchNotification({
    recipient_id: targetId,
    type: 'follow',
    actor: {
      _id: followerId,
      name: ctx.state.user.name,
      img: ctx.state.user.img
    },
    aggregation_key: `follow:${targetId}`,
    target_type: 'user',
    target_id: followerId,
    channels: { in_app: true }
  }).catch(err => console.error('Follow dispatch failed:', err));

  trackEvent(followerId, mixpanelEvents.follow_v2, { target_id: targetId });
  ctx.body = { isFollowing: true };
});

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
      $set: {
        users: sortedUsers,
        chat_status: 'blocked',
        blocked_by: new Types.ObjectId(current_user_id),
        action_user_id: undefined,
        follows: []
      }
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
      user_model.updateOne({ _id: sortedUsers[0] }, [
        {
          $set: {
            'stats.mates': { $max: [0, { $add: [{ $ifNull: ['$stats.mates', 0] }, p1Stats.mates] }] },
            'stats.followers': { $max: [0, { $add: [{ $ifNull: ['$stats.followers', 0] }, p1Stats.followers] }] },
            'stats.following': { $max: [0, { $add: [{ $ifNull: ['$stats.following', 0] }, p1Stats.following] }] }
          }
        }
      ]),
      user_model.updateOne({ _id: sortedUsers[1] }, [
        {
          $set: {
            'stats.mates': { $max: [0, { $add: [{ $ifNull: ['$stats.mates', 0] }, p2Stats.mates] }] },
            'stats.followers': { $max: [0, { $add: [{ $ifNull: ['$stats.followers', 0] }, p2Stats.followers] }] },
            'stats.following': { $max: [0, { $add: [{ $ifNull: ['$stats.following', 0] }, p2Stats.following] }] }
          }
        }
      ])
    ]);
  }
  trackEvent(current_user_id, mixpanelEvents.block_v2, {
    target_id,
    previous_status: oldRel?.chat_status ?? 'none'
  });
  ctx.body = { success: true, message: 'User blocked' };
});

relationshipRouter.post('/unblock', async (ctx) => {
  const current_user_id = ctx.state.user._id.toString();
  const { target_id } = ctx.request.body;
  const sortedUsers = [current_user_id, target_id].sort();
  const rel = await relationship_model.findOne({ users: sortedUsers });

  if (rel?.chat_status === 'blocked' && rel.blocked_by?.toString() === current_user_id) {
    if (rel.conversation_id) {
      rel.chat_status = 'none';
      rel.blocked_by = undefined;
      await rel.save();
    } else {
      await relationship_model.deleteOne({ _id: rel._id });
    }

    ctx.body = { success: true, message: 'User unblocked' };
  } else {
    ctx.throw(403, 'Permission denied');
  }
});

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

  const populatedConvo = rel.conversation_id
    ? await conversation_model
      .findById(rel.conversation_id)
      .populate('participants', PUBLIC_USER_FIELDS)
      .lean() as any
    : null;

  if (populatedConvo) {
    populatedConvo.status = 'expired';
    populatedConvo.cooldown_until = rel.cooldown_until;
    populatedConvo.relationship_id = rel._id.toString();
  }

  sendSocketNotificationToUser(targetId, 'chat:mate_unfriended', {
    conversation_id: rel.conversation_id?.toString(),
    conversation: populatedConvo
  });
  trackEvent(myId, mixpanelEvents.unfriend_v2, {
    target_id: targetId,
    previous_status: oldRel.chat_status
  });
  ctx.body = { success: true, cooldown_until: rel.cooldown_until };
});

relationshipRouter.post('/:conversation_id/mate-request', requireCapability(Capability.SEND_MATE_REQUEST), async (ctx) => {
  const { conversation_id } = ctx.params;
  const user_id = ctx.state.user._id;


  await assertMateQuota(user_id.toString());

  console.log(conversation_id);
  const rel = await relationship_model.findOneAndUpdate(
    { conversation_id: new Types.ObjectId(conversation_id) },
    { $set: { chat_status: 'pending_mate', action_user_id: user_id } },
    { new: true }
  );

  console.log(rel);
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

    // ─── REPLACES: sendSocketNotificationToUser('chat:mate_requested', ...) ───
    dispatchNotification({
      recipient_id: partnerId.toString(),
      type: 'dm_message',
      actor: {
        _id: user_id.toString(),
        name: ctx.state.user.name,
        img: ctx.state.user.img
      },
      channels: {
        in_app: false,
        socket: {
          event: 'chat:mate_requested',
          data: { conversation_id, conversation: populatedConvo, wasExpired: false }
        },
        push: mateRequestPushNotification(ctx.state.user._id, ctx.state.user.name, ctx.state.user.img, conversation_id)
      }
    }).catch(err => console.error('Mate request dispatch failed:', err));
  }

  trackEvent(user_id.toString(), mixpanelEvents.mate_request_v2, {
    conversation_id,
    partner_id: partnerId?.toString()
  });

  ctx.body = { success: true };
});

relationshipRouter.get('/:user_id/network/:type', async (ctx) => {
  const { user_id, type } = ctx.params;
  const { page = 1, limit = 20, search = '' } = ctx.query;
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

  const searchTerm = String(search).trim();
  if (searchTerm.length >= 3) {
    const safeSearchTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const matchingUsers = await user_model
      .find({
        _id: { $ne: oid },
        name: { $regex: safeSearchTerm, $options: 'i' }
      })
      .select('_id')
      .lean();

    const matchingUserIds = matchingUsers.map(u => u._id);

    if (matchingUserIds.length === 0) {
      ctx.body = { total: 0, data: [] };
      return;
    }

    query.users = { $in: matchingUserIds };
  }

  // 1. Get the real total matches count immediately
  const totalMatches = await relationship_model.countDocuments(query);

  if (totalMatches === 0) {
    ctx.body = { total: 0, data: [] };
    return;
  }

  // 2. Fetch the paginated subset
  const rels = await relationship_model
    .find(query)
    // _id tiebreaker keeps pagination stable when many rels share updatedAt —
    // without it, skip/limit returns overlapping rows across pages.
    .sort({ updatedAt: -1, _id: -1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

  const targetIds = rels.map(r => r.users.find(id => id.toString() !== user_id));
  const users = await user_model
    .find({ _id: { $in: targetIds } })
    .select(PUBLIC_USER_FIELDS)
    .lean();

  const transformedData = users.map(u => {
    const rel = rels.find(r => r.users.some(id => id.toString() === u._id.toString()));
    return {
      ...u,
      chat_status: rel?.chat_status,
      expires_at: rel?.expires_at,
      relationship_id: rel?._id
    };
  });

  // 3. Return payload mapping containing global totals
  ctx.body = {
    total: totalMatches,
    data: transformedData
  };
});

relationshipRouter.get('/blocked-ids', async (ctx) => {
  const currentUserId = new Types.ObjectId(ctx.state.user._id);

  const rels = await relationship_model.find({
    users: currentUserId,
    chat_status: 'blocked',
    blocked_by: currentUserId
  }).select('users').lean();

  ctx.body = rels.map(r =>
    r.users.find(u => u.toString() !== ctx.state.user._id.toString())
  );
});

relationshipRouter.get('/:userId/stats', async (ctx) => {
  const user = await user_model.findById(ctx.params.userId).select('stats').lean();
  ctx.body = user?.stats || { mates: 0, followers: 0, following: 0, posts: 0 };
});

relationshipRouter.post('/:conversation_id/mate-request/cancel', async (ctx) => {
  const { conversation_id } = ctx.params;
  const user_id = ctx.state.user._id;

  const rel = await relationship_model.findOne({ conversation_id: new Types.ObjectId(conversation_id) });

  if (!rel) return ctx.throw(404, 'Relationship not found');

  if (rel.chat_status !== 'pending_mate' || rel.action_user_id?.toString() !== user_id.toString()) {
    return ctx.throw(400, 'Cannot cancel this request');
  }

  const isTrialValid = rel.expires_at && dayjs().isBefore(dayjs(rel.expires_at));
  rel.chat_status = isTrialValid ? 'temporary' : 'expired';
  rel.action_user_id = undefined;
  await rel.save();

  const partnerId = rel.users.find(u => u.toString() !== user_id.toString());

  if (partnerId) {
    const populatedConvo = await conversation_model
      .findById(conversation_id)
      .populate('participants', PUBLIC_USER_FIELDS)
      .lean() as any;

    if (populatedConvo) {
      populatedConvo.status = rel.chat_status;
      populatedConvo.relationship_id = rel._id.toString();
    }

    sendSocketNotificationToUser(partnerId.toString(), 'chat:mate_declined', {
      conversation_id,
      conversation: populatedConvo,
      status: rel.chat_status
    });
  }

  trackEvent(user_id.toString(), mixpanelEvents.mate_request_cancel_v2, {
    conversation_id,
    resulting_status: rel.chat_status
  });

  ctx.body = { success: true, status: rel.chat_status };
});