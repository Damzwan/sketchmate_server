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
import {
  isFeatureAllowed,
  parentalErrorBody,
  requireChildFeature
} from '../services/parental.service';
import { dispatchNotification } from '../services/notification.service';
import {
  matchNotification,
  mateRequestPushNotification,
  requestAcceptedPushNotification
} from '../../config/notification.config';
import { mixpanelEvents, trackEvent } from '../../mixpanel';
import {
  canSendMateRequest,
  isRepeatMateRequest,
  mateRequestStateFor,
  recordMateRequestCancelled,
  recordMateRequestDeclined,
  recordMateRequestSent
} from '../services/mate-request.policy';

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
    // Accepting is what creates the channel, so it needs the parent's switch.
    // Declining never does — a child must always be able to say no.
    if (!(await isFeatureAllowed(user_id, 'mate_add'))) {
      ctx.status = 403;
      ctx.body = parentalErrorBody('mate_add');
      return;
    }

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
      // Same compare-and-set shape as /unfriend, for the same reason: a
      // doc.save() after an in-memory status check lets two overlapping accepts
      // both pass and both credit +1, permanently inflating the counter. The
      // `chat_status: 'pending_mate'` filter makes the transition itself the
      // lock, so exactly one request can award the mate.
      const transitioned = await relationship_model.updateOne(
        { _id: rel._id, chat_status: 'pending_mate' },
        {
          $set: { chat_status: 'mate' },
          $unset: { expires_at: '', cooldown_until: '', deleted_at: '' }
        }
      );

      rel.chat_status = 'mate';
      rel.expires_at = undefined;
      rel.cooldown_until = undefined;
      rel.deleted_at = undefined;

      if (transitioned.modifiedCount > 0) {
        await user_model.updateMany(
          { _id: { $in: rel.users } },
          { $inc: { 'stats.mates': 1 } }
        );
      }

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
      // Capture the requester before action_user_id is cleared — that field is
      // the only record of who asked.
      const requesterId = rel.action_user_id?.toString();

      rel.chat_status = isTrialValid ? 'temporary' : 'expired';
      rel.action_user_id = undefined;
      // A "no" now costs the asker something. Without this the status returned
      // to 'temporary' and they could re-send instantly, forever.
      if (requesterId) recordMateRequestDeclined(rel, requesterId);
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
        // The socket payload below goes to the REQUESTER, so it carries their
        // freshly-escalated cooldown. Without it their client would re-render a
        // live "Become Mates" button the instant they were declined, and only
        // discover the cooldown by having the next request rejected.
        Object.assign(populatedConvo, mateRequestStateFor(rel, partnerId?.toString() ?? ''));
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

  // Compare-and-set, in ONE atomic operation, with `new: false` so the return
  // value is the pre-image.
  //
  // This used to be a read, then a guard on that read, then an unconditional
  // update, then `if (oldRel.chat_status === 'mate') $inc -1`. Nothing
  // serialised those steps, so two overlapping unfriends — a double tap, a
  // retry, or both partners unfriending at the same moment — each read
  // 'mate' and each ran the decrement. One +1 was cancelled by two -1s and the
  // counter went to -1. That is the negative `stats.mates`.
  //
  // Now the status filter is part of the write: whoever loses the race matches
  // nothing, gets null back, and never reaches the decrement.
  const oldRel = await relationship_model.findOneAndUpdate(
    {
      users: sortedUsers,
      chat_status: { $nin: ['expired', 'none', 'blocked'] }
    },
    {
      // No re-invite cooldown. There used to be a 48h `cooldown_until` here and
      // it was never enforced — nothing on this server reads it before creating
      // a `pending_invite`, so anyone who reached the chat from the friend
      // picker or a profile sheet could re-invite immediately. It only ever
      // greyed out the button for the one user who read the banner and believed
      // it. (The mate-request decline ladder is a different field,
      // `mate_requests[].cooldown_until`, and that one IS enforced.)
      //
      // Even enforced it would have been the wrong tool: it fires on the pair,
      // so a mis-tap punished both people equally, and the case it looks like it
      // guards — being re-invited by someone you just removed — is what block is
      // for. Repeated unwanted requests are handled by the enforced,
      // per-direction decline ladder instead of a global friendship quota.
      $set: {
        chat_status: 'expired',
        deleted_at: dayjs().add(30, 'days').toDate(),
        action_user_id: new Types.ObjectId(myId)
      },
      $unset: { cooldown_until: '' }
    },
    { new: false }
  ) as RelationshipDocument | null;

  if (!oldRel) {
    return ctx.throw(400, 'Invalid relationship state');
  }

  const rel = await relationship_model.findById(oldRel._id) as RelationshipDocument;

  if (rel?.conversation_id) {
    await conversation_model.findByIdAndUpdate(rel.conversation_id, { $set: { deleted_at: dayjs().add(30, 'days').toDate() } });
  }

  if (oldRel.chat_status === 'mate') {
    // Floored at 0, the same way /block already does it. The atomic guard above
    // should make an underflow impossible, but this is the only decrement in
    // the file that lacked the clamp — and a counter that can go negative is a
    // counter that eventually does.
    await user_model.updateMany(
      { _id: { $in: sortedUsers } },
      [
        {
          $set: {
            'stats.mates': {
              $max: [0, { $add: [{ $ifNull: ['$stats.mates', 0] }, -1] }]
            }
          }
        }
      ]
    );
  }

  const populatedConvo = rel.conversation_id
    ? await conversation_model
      .findById(rel.conversation_id)
      .populate('participants', PUBLIC_USER_FIELDS)
      .lean() as any
    : null;

  if (populatedConvo) {
    populatedConvo.status = 'expired';
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
  ctx.body = { success: true };
});

relationshipRouter.post('/:conversation_id/mate-request', requireCapability(Capability.SEND_MATE_REQUEST), requireChildFeature('mate_add'), async (ctx) => {
  const { conversation_id } = ctx.params;
  const user_id = ctx.state.user._id;

  // Read BEFORE writing so the anti-pestering ledger can veto the request.
  // The old code flipped the status straight to 'pending_mate' in the same
  // call that found the relationship, which left no point at which to say no.
  const rel = await relationship_model.findOne({
    conversation_id: new Types.ObjectId(conversation_id)
  });

  if (!rel) return ctx.throw(404, 'Relationship not found');

  if (!rel.users.some(u => u.toString() === user_id.toString())) {
    // The old lookup was by conversation_id alone, so any authenticated user
    // who knew a conversation id could drive someone else's relationship.
    return ctx.throw(403, 'Not part of this conversation');
  }

  if (rel.chat_status === 'pending_mate') {
    return ctx.throw(400, 'A mate request is already pending');
  }

  const gate = canSendMateRequest(rel, user_id.toString());
  if (!gate.allowed) {
    ctx.status = 429;
    ctx.body = {
      error: gate.locked ? 'mate_request_locked' : 'mate_request_cooldown',
      message: gate.reason,
      cooldown_until: gate.cooldown_until ?? null
    };
    return;
  }

  // Read before recordMateRequestSent — it increments the counter this reads.
  const isRepeat = isRepeatMateRequest(rel, user_id.toString());

  rel.chat_status = 'pending_mate';
  rel.action_user_id = user_id;
  recordMateRequestSent(rel, user_id.toString());
  await rel.save();

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
        // Only the first ask may buzz their phone. Repeats still land — the
        // socket event updates the UI and the request is waiting when they next
        // open the app — but they can't be used to spam notifications.
        push: isRepeat
          ? false
          : mateRequestPushNotification(ctx.state.user._id, ctx.state.user.name, ctx.state.user.img, conversation_id)
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
    // `?status=mate` narrows to PERMANENT mates only. Opt-in, so every existing
    // caller keeps the broad list: pickers that hand someone a drawing are
    // happy to include a live trial, but ones that put a name on a public post
    // are not — a 24h trial is not a friendship worth publishing.
    if (String(ctx.query.status || '') === 'mate') {
      query.chat_status = 'mate';
    } else {
      // Permanent mates + pending requests always count. A 'temporary' (24h trial)
      // only counts while it hasn't expired — an expired trial is not a mate.
      query.$or = [
        { chat_status: { $in: ['mate', 'pending_mate'] } },
        { chat_status: 'temporary', expires_at: { $gt: new Date() } }
      ];
    }
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

    // Keep both constraints. Replacing `users: oid` here used to search every
    // relationship belonging to a name match, including pairs the requester
    // was not part of.
    delete query.users;
    query.$and = [
      { users: oid },
      { users: { $in: matchingUserIds } }
    ];
  }

  // 1. Get the real total matches count immediately
  const totalMatches = await relationship_model.countDocuments(query);

  if (totalMatches === 0) {
    ctx.body = { total: 0, data: [] };
    return;
  }

  // Mates are people, not presence rows: rank them by the exact timestamp of
  // their latest message. Relationship `updatedAt` changes for requests and
  // state transitions, so it made pickers feel effectively random.
  const rels: any[] = type === 'mates'
    ? await relationship_model.aggregate([
      { $match: query },
      {
        $lookup: {
          from: 'conversations',
          localField: 'conversation_id',
          foreignField: '_id',
          as: '_conversation'
        }
      },
      { $unwind: { path: '$_conversation', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'messages',
          localField: '_conversation.last_message',
          foreignField: '_id',
          as: '_last_message'
        }
      },
      {
        $addFields: {
          last_interaction_at: {
            $ifNull: [
              { $arrayElemAt: ['$_last_message.createdAt', 0] },
              '$createdAt'
            ]
          }
        }
      },
      { $sort: { last_interaction_at: -1, _id: -1 } },
      { $skip: skip },
      { $limit: Number(limit) },
      { $project: { _conversation: 0, _last_message: 0 } }
    ])
    : await relationship_model
      .find(query)
      // _id tiebreaker keeps pagination stable when many rels share updatedAt.
      .sort({ updatedAt: -1, _id: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

  const targetIds = rels.map(r =>
    r.users.find((id: Types.ObjectId) => id.toString() !== user_id)
  );
  const users = await user_model
    .find({ _id: { $in: targetIds } })
    .select(PUBLIC_USER_FIELDS)
    .lean();

  const userById = new Map(users.map(u => [u._id.toString(), u]));
  const transformedData = rels.flatMap(rel => {
    const targetId = rel.users.find((id: Types.ObjectId) => id.toString() !== user_id);
    const u = targetId ? userById.get(targetId.toString()) : undefined;
    if (!u) return [];
    return {
      ...u,
      chat_status: rel.chat_status,
      expires_at: rel.expires_at,
      relationship_id: rel._id,
      last_interaction_at: rel.last_interaction_at
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
  // Withdrawing isn't a rejection, so it doesn't move the decline ladder — but
  // the partner was still notified, and cancel/re-send would otherwise be a
  // free way around every cooldown in the policy.
  recordMateRequestCancelled(rel, user_id.toString());
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

  // The canceller's own short cooldown just started — hand it back so their
  // client greys the button immediately instead of on the next fetch.
  ctx.body = {
    success: true,
    status: rel.chat_status,
    ...mateRequestStateFor(rel, user_id.toString())
  };
});
