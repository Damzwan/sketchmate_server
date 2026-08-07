import { BalloonNotFoundError, CreateBalloonV2Params } from './balloon.service';
import { Balloon, InboxItem, SOCKET_ENDPONTS } from '../../types/types';
import mongoose, { Types } from 'mongoose';
import { assertBalloonQuota } from './quota.service';
import { BalloonDocument, RelationshipDocument } from '../../types/mongoose.types';
import { balloon_model } from '../../models/balloon.model';
import { mixpanelEvents, trackEvent } from '../../mixpanel';
import { userSocketMap } from '../socket/socket';
import { balloonMatchNotification, balloonMatchNotificationV2 } from '../../config/notification.config';
import { sendNotificationUser } from '../../notifications';
import dayjs from 'dayjs';
import {
  activeBalloonHolders,
  activeBalloonSkips,
  activeBalloonTimeouts,
  BALLOON_COOLDOWN_MS,
  HOT_POTATO_TIMEOUT_MS,
  MAX_LIVE_ROUTING_ATTEMPTS,
  v2AcceptBalloonCleanUp
} from '../balloon';
import { user_model } from '../../models/user.model';
import { relationship_model } from '../../models/relationship.model';
import { compareVersions } from '../../helper';
import { isChildDob } from './parental.service';
import { Capability, getLevelConfig } from '../../types/moderation.policy';
import { saveMessageLogic } from './chat.service';
import { quota_usage_model } from '../../models/quota_usage.model';
import { startOfUtcDay } from '../../config/quota.config';
import { dispatchNotification } from './notification.service';

const MIN_V3_CLIENT_VERSION = '0.4.3';

// ─── V3 CREATE ──────────────────────────────────────────────────────────

export async function createBalloonV3(params: CreateBalloonV2Params): Promise<Balloon> {
  const senderObjectId = new Types.ObjectId(params.sender);

  await assertBalloonQuota(params.sender);

  const balloonId = new Types.ObjectId();
  const now = new Date();

  const balloonToCreate: Partial<BalloonDocument> = {
    _id: balloonId,
    status: 'pending',
    createdAt: now,
    lastActivityAt: now,
    drawingJsonUrl: params.drawing_url,
    img: params.image_url,
    thumbnail: params.thumbnail_url,
    aspect_ratio: params.aspect_ratio,
    sender: senderObjectId,
    message: params.message,
    cancelledBalloons: [],
    version: 3,
    rejected_by: []
  };

  try {
    await balloon_model.create(balloonToCreate);
    await quota_usage_model.updateOne(
      { user_id: senderObjectId, date: startOfUtcDay() },
      { $inc: { balloons_sent: 1 } },
      { upsert: true }
    );
  } catch (e) {
    throw new Error(`Failed to create balloon: ${(e as Error).message}`);
  }

  trackEvent(params.sender, mixpanelEvents.balloon_v2_create);

  routeBalloonToOnlineUserV3(params.sender, balloonId.toString(), userSocketMap, 0)
    .catch((err: any) => console.error('Error during balloon v3 routing:', err));

  return {
    ...balloonToCreate,
    _id: balloonId.toString(),
    sender: params.sender,
    createdAt: now.toISOString(),
    lastActivityAt: now.toISOString()
  } as unknown as Balloon;
}

// ─── V3 ACCEPT ──────────────────────────────────────────────────────────

export interface AcceptBalloonV3Result {
  inboxItem: InboxItem;
  conversation: any;
  message: any;
}

export async function acceptBalloonV3(params: {
  balloon_id: string;
  sender_id: string;
  user_id: string;
}): Promise<AcceptBalloonV3Result> {
  // 1. In-memory cleanup
  if (activeBalloonTimeouts.has(params.balloon_id)) {
    clearTimeout(activeBalloonTimeouts.get(params.balloon_id)!);
    activeBalloonTimeouts.delete(params.balloon_id);
  }
  activeBalloonHolders.delete(params.balloon_id);
  activeBalloonSkips.delete(params.balloon_id);

  void user_model.findByIdAndUpdate(params.user_id, {
    $set: { 'balloon.last_received_at': new Date() }
  }).catch((err) => console.error('error:', err));

  // 2. Mark the balloon accepted
  const balloon = (await balloon_model.findByIdAndUpdate(
    params.balloon_id,
    { $set: { status: 'accepted', matchedAt: new Date(), pairedUser: params.user_id } },
    { new: true }
  ).lean()) as unknown as BalloonDocument | null;

  if (!balloon) throw new BalloonNotFoundError();

  // 3. Need acceptor name for the system message payload
  const acceptor: any = await user_model
    .findById(params.user_id)
    .select('name img')
    .lean();
  if (!acceptor) throw new Error('Acceptor not found');

  // 4. Inbox transplant — drops the balloon doc
  const inboxItem = await v2AcceptBalloonCleanUp(balloon, params.user_id);

  // 5. Look up the existing relationship (likely none) for saveMessageLogic
  const existingRel = (await relationship_model
    .findOne({
      users: { $all: [new Types.ObjectId(params.sender_id), new Types.ObjectId(params.user_id)] }
    })
    .lean()) as RelationshipDocument | null;

  // 6. Save the system message + drive the relationship to 'temporary'
  //    in one pass. The acceptor is the "sender" of the system message —
  //    it represents the action they just took.
  const expiresAt = dayjs().add(24, 'hours').toDate();
  const { message, conversation } = await saveMessageLogic(
    params.user_id,
    params.sender_id,
    '',
    existingRel,
    undefined,
    {
      relationshipOverride: {
        chat_status: 'temporary',
        expires_at: expiresAt,
        action_user_id: new Types.ObjectId(params.user_id)
      },
      messageMeta: {
        type: 'system',
        system_kind: 'balloon_match',
        system_payload: {
          acceptor_id: params.user_id,
          acceptor_name: acceptor.name,
          sender_id: params.sender_id,
          balloon_id: params.balloon_id,
          thumbnail: inboxItem.thumbnail
        }
      }
    }
  );


  const chatPayload = {
    message,
    conversation,
    conversation_id: conversation._id.toString()
  };
  dispatchNotification({
    recipient_id: params.sender_id,
    type: 'dm_message',  // it's a system message in a DM thread
    actor: { _id: params.user_id, name: acceptor.name, img: acceptor.img },
    channels: {
      in_app: false,  // the convo is the record
      socket: { event: 'chat:receive_message', data: chatPayload },
      push: balloonMatchNotificationV2(acceptor.name, conversation._id.toString())
    }
  }).catch(err => console.error('Balloon match sender dispatch failed:', err));

  // To the acceptor — they pressed the button, they know what happened.
  // Just sync their other devices via socket. No push (it'd be annoying).
  dispatchNotification({
    recipient_id: params.user_id,
    type: 'dm_message',
    channels: {
      in_app: false,
      socket: { event: 'chat:receive_message', data: chatPayload },
      push: false
    }
  }).catch(err => console.error('Balloon match acceptor dispatch failed:', err));

  const senderIsOnline = !!userSocketMap[params.sender_id]?.length;
  const acceptorIsOnline = !!userSocketMap[params.user_id]?.length;

  if (senderIsOnline && acceptorIsOnline) {
    userSocketMap[params.user_id]?.forEach((s: any) =>
      s.emit('friend:online', { user_id: params.sender_id, status: 'online' })
    );

    userSocketMap[params.sender_id]?.forEach((s: any) =>
      s.emit('friend:online', { user_id: params.user_id, status: 'online' })
    );
  }

  trackEvent(params.user_id, mixpanelEvents.balloon_v2_accept);

  return { inboxItem, conversation, message };
}


/**
 * V3 hot-potato routing. Only routes v3 balloons to v3-capable clients.
 */
export async function routeBalloonToOnlineUserV3(
  senderId: string,
  balloonId: string,
  userSocketMap: any,
  attempts = 0,
  balloonData?: any
): Promise<any> {
  if (attempts >= MAX_LIVE_ROUTING_ATTEMPTS) {
    activeBalloonSkips.delete(balloonId);
    return false;
  }

  const currentBalloon = balloonData || await balloon_model.findById(balloonId);
  if (
    !currentBalloon ||
    currentBalloon.status !== 'pending' ||
    currentBalloon.moderation_status !== 'active' ||
    currentBalloon.version !== 3
  ) {
    activeBalloonSkips.delete(balloonId);
    return false;
  }

  const busyUserIds = Array.from(activeBalloonHolders.values());
  const currentSkips = activeBalloonSkips.get(balloonId) || new Set<string>();
  const dbRejects = currentBalloon.rejected_by?.map((id: any) => id.toString()) || [];

  const onlineUserIds = Object.keys(userSocketMap);
  const filteredCandidates = onlineUserIds.filter((id) => {
    const userSocket = userSocketMap[id]?.[0];
    if (!userSocket) return false;
    // Default-deny: an unconfirmed birthday could belong to an eight-year-old,
    // and a balloon is a drawing from a stranger.
    const oldEnough = !isChildDob(userSocket.data.user.date_of_birth);
    const hasV3Version =
      compareVersions(userSocket.data.user.version, MIN_V3_CLIENT_VERSION) >= 0;

    return (
      hasV3Version &&
      id !== senderId &&
      oldEnough &&
      !busyUserIds.includes(id) &&
      !currentSkips.has(id) &&
      !dbRejects.includes(id)
    );
  });

  if (filteredCandidates.length === 0) {
    activeBalloonSkips.delete(balloonId);
    return false;
  }

  // Exclude users already in any kind of relationship with the sender.
  // v3 social graph lives entirely in relationship_model.
  const existingRels = await relationship_model
    .find({
      users: { $all: [new mongoose.Types.ObjectId(senderId)] },
      chat_status: { $in: ['mate', 'temporary', 'pending_invite', 'pending_mate', 'blocked'] }
    })
    .select('users')
    .lean();

  const relatedUserIds = new Set<string>();
  for (const rel of existingRels) {
    for (const u of rel.users) {
      const s = u.toString();
      if (s !== senderId) relatedUserIds.add(s);
    }
  }

  const cooldownDate = new Date(Date.now() - BALLOON_COOLDOWN_MS);
  const prospective = await user_model
    .find({
      _id: {
        $in: filteredCandidates
          .filter((id) => !relatedUserIds.has(id))
          .map((id) => new mongoose.Types.ObjectId(id))
      },
      'balloon.disabled': { $ne: true },
      $or: [
        { 'balloon.last_received_at': { $lte: cooldownDate } },
        { 'balloon.last_received_at': null },
        { 'balloon.last_received_at': { $exists: false } }
      ]
    })
    .select('_id restriction')
    .lean();

  const allowed = prospective.filter((user) => {
    const level = user.restriction?.level ?? 0;
    const policy = getLevelConfig(level);
    return !policy.blocks.includes(Capability.RECEIVE_BALLOON);
  });

  if (allowed.length === 0) return false;

  const luckyWinner = allowed[Math.floor(Math.random() * allowed.length)];
  const matchedUserId = luckyWinner._id.toString();

  if (Array.from(activeBalloonHolders.values()).includes(matchedUserId)) {
    return routeBalloonToOnlineUserV3(senderId, balloonId, userSocketMap, attempts, currentBalloon);
  }

  activeBalloonHolders.set(balloonId, matchedUserId);

  userSocketMap[matchedUserId]?.forEach((s: any) => {
    s.emit(SOCKET_ENDPONTS.receive_new_balloon_v3, { balloon: currentBalloon });
  });
  trackEvent(matchedUserId, mixpanelEvents.balloon_v2_receive);

  const timeout = setTimeout(async () => {
    activeBalloonTimeouts.delete(balloonId);
    activeBalloonHolders.delete(balloonId);

    const updated = await balloon_model.findByIdAndUpdate(
      balloonId,
      { $addToSet: { rejected_by: matchedUserId } },
      { new: true }
    );

    if (
      updated &&
      updated.status === 'pending' &&
      updated.moderation_status === 'active' &&
      updated.version === 3
    ) {
      userSocketMap[matchedUserId]?.forEach((s: any) =>
        s.emit(SOCKET_ENDPONTS.balloon_missed, { balloonId })
      );
      trackEvent(matchedUserId, mixpanelEvents.balloon_v2_miss);

      if (!activeBalloonSkips.has(balloonId)) activeBalloonSkips.set(balloonId, new Set());
      activeBalloonSkips.get(balloonId)!.add(matchedUserId);

      routeBalloonToOnlineUserV3(senderId, balloonId, userSocketMap, attempts + 1, updated)
        .catch((err) => console.error(`v3 reroute failed for ${balloonId}:`, err));
    }
  }, HOT_POTATO_TIMEOUT_MS);

  activeBalloonTimeouts.set(balloonId, timeout);
  return true;
}

export async function triageWaitingRoomV3(userId: string): Promise<boolean> {
  // Gate: must have a record, not disabled, not capability-blocked
  const user = (await user_model
    .findById(userId)
    .select('balloon restriction')
    .lean()) as any;
  if (!user || user.balloon?.disabled === true) return false;

  const userLevel = user.restriction?.level ?? 0;
  if (getLevelConfig(userLevel).blocks.includes(Capability.RECEIVE_BALLOON)) return false;

  // Cooldown
  const cooldownDate = new Date(Date.now() - BALLOON_COOLDOWN_MS);
  const lastReceived = user.balloon?.last_received_at;
  if (lastReceived && new Date(lastReceived) > cooldownDate) return false;

  // Exclusion set from the relationship graph — v3 replaces the
  // `user.mates` array. Anyone you have any kind of standing relationship
  // with (mate, temporary, pending, blocked) is off the candidate list.
  const myRels = await relationship_model
    .find({
      users: { $all: [new Types.ObjectId(userId)] },
      chat_status: { $in: ['mate', 'temporary', 'pending_invite', 'pending_mate', 'blocked'] }
    })
    .select('users')
    .lean();

  const excludedSenders: Types.ObjectId[] = [new Types.ObjectId(userId)];
  for (const rel of myRels) {
    for (const u of rel.users) {
      if (u.toString() !== userId) {
        excludedSenders.push(new Types.ObjectId(u.toString()));
      }
    }
  }

  // Skip any balloon that's currently being held by another user
  const activeBalloons = Array.from(activeBalloonHolders.keys()).map(
    (id) => new Types.ObjectId(id)
  );

  const waitingBalloon = await balloon_model
    .findOne({
      _id: { $nin: activeBalloons },
      status: 'pending',
      moderation_status: 'active',
      version: 3,
      sender: { $nin: excludedSenders },
      rejected_by: { $ne: new Types.ObjectId(userId) }
    })
    .sort({ createdAt: 1 });

  if (!waitingBalloon) return false;

  const balloonId = waitingBalloon._id.toString();
  activeBalloonHolders.set(balloonId, userId);

  // Deliver to ALL the user's sockets (handles multiple tabs/devices)
  userSocketMap[userId]?.forEach((s: any) => {
    s.emit(SOCKET_ENDPONTS.receive_new_balloon_v3, { balloon: waitingBalloon });
  });
  trackEvent(userId, mixpanelEvents.balloon_v2_receive);

  // Hot-potato timeout — if they don't accept/refuse in time, mark them as
  // rejected and reroute through the v3 fan-out.
  const timeout = setTimeout(async () => {
    activeBalloonTimeouts.delete(balloonId);
    activeBalloonHolders.delete(balloonId);

    const currentBalloon = await balloon_model.findByIdAndUpdate(
      balloonId,
      { $addToSet: { rejected_by: userId } },
      { new: true }
    );

    if (
      currentBalloon &&
      currentBalloon.status === 'pending' &&
      currentBalloon.moderation_status === 'active' &&
      currentBalloon.version === 3
    ) {
      userSocketMap[userId]?.forEach((s: any) =>
        s.emit(SOCKET_ENDPONTS.balloon_missed, { balloonId })
      );
      trackEvent(userId, mixpanelEvents.balloon_v2_miss);

      routeBalloonToOnlineUserV3(
        currentBalloon.sender.toString(),
        balloonId,
        userSocketMap,
        0,
        currentBalloon
      ).catch((err) => console.error(`v3 triage reroute failed for ${balloonId}:`, err));
    }
  }, HOT_POTATO_TIMEOUT_MS);

  activeBalloonTimeouts.set(balloonId, timeout);
  return true;
}
