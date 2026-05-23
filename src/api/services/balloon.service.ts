import { Balloon, InboxItem, Mate, SOCKET_ENDPONTS } from '../../types/types';
import { Types } from 'mongoose';
import { assertBalloonQuota } from './quota.service';
import { BalloonDocument } from '../../types/mongoose.types';
import { balloon_model } from '../../models/balloon.model';
import { mixpanelEvents, trackEvent } from '../../mixpanel';
import {
  activeBalloonHolders,
  activeBalloonSkips,
  activeBalloonTimeouts,
  deleteBalloonS3,
  routeBalloonToOnlineUser, v2AcceptBalloonCleanUp
} from '../balloon';
import { userSocketMap } from '../socket/socket';
import { user_model } from '../../models/user.model';
import { match } from '../../mongodb';
import { sendNotificationUser } from '../../notifications';
import { balloonMatchNotification } from '../../config/notification.config';
import { quota_usage_model } from '../../models/quota_usage.model';
import { startOfUtcDay } from '../../config/quota.config';

export class BalloonNotFoundError extends Error {
  constructor() {
    super('Balloon not found');
    this.name = 'BalloonNotFoundError';
  }
}

export class BalloonForbiddenError extends Error {
  constructor() {
    super('Not your balloon');
    this.name = 'BalloonForbiddenError';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CREATE (quota-gated)
// ─────────────────────────────────────────────────────────────────────────

export interface CreateBalloonV2Params {
  sender: string;
  message: string;
  aspect_ratio: number;
  drawing_url: string;
  image_url: string;
  thumbnail_url: string;
}

export async function createBalloonV2(params: CreateBalloonV2Params): Promise<Balloon> {
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
    version: 2,
    rejected_by: []
  };

  try {
    await balloon_model.create(balloonToCreate);
  } catch (e) {
    throw new Error(`Failed to create balloon: ${(e as Error).message}`);
  }

  trackEvent(params.sender, mixpanelEvents.balloon_v2_create);

  routeBalloonToOnlineUser(params.sender, balloonId.toString(), userSocketMap, 0)
    .catch((err: any) => console.error('Error during balloon routing triage:', err));

  return {
    ...balloonToCreate,
    _id: balloonId.toString(),
    sender: params.sender,
    createdAt: now.toISOString(),
    lastActivityAt: now.toISOString()
  } as unknown as Balloon;
}

// ─────────────────────────────────────────────────────────────────────────
// LIST: my active sent balloons
// ─────────────────────────────────────────────────────────────────────────

export async function listMyActiveBalloons(userId: string): Promise<Balloon[]> {
  const docs = await balloon_model
    .find({
      sender: new Types.ObjectId(userId),
      status: { $in: ['pending', 'delivered'] }
    })
    .sort({ createdAt: -1 })
    .lean();
  return docs as unknown as Balloon[];
}

// ─────────────────────────────────────────────────────────────────────────
// CANCEL: sender pulls back their own balloon.
// Called by both legacy socket and the new HTTP route — identical effects.
// ─────────────────────────────────────────────────────────────────────────

export async function cancelBalloonV2(params: {
  balloon_id: string;
  user_id: string;
}): Promise<{ cancelled: true }> {
  if (activeBalloonTimeouts.has(params.balloon_id)) {
    clearTimeout(activeBalloonTimeouts.get(params.balloon_id)!);
    activeBalloonTimeouts.delete(params.balloon_id);
  }

  const currentHolderId = activeBalloonHolders.get(params.balloon_id);
  if (currentHolderId && userSocketMap[currentHolderId]) {
    userSocketMap[currentHolderId].forEach((s: any) => {
      s.emit(SOCKET_ENDPONTS.balloon_expired, { balloonId: params.balloon_id });
    });
  }
  activeBalloonHolders.delete(params.balloon_id);
  activeBalloonSkips.delete(params.balloon_id);

  const balloon = await balloon_model
    .findOne({ _id: params.balloon_id, sender: params.user_id })
    .lean() as unknown as BalloonDocument | null;

  if (!balloon) throw new BalloonNotFoundError();

  await Promise.all([
    deleteBalloonS3(balloon as unknown as Balloon),
    balloon_model.findByIdAndDelete(balloon._id),
    user_model.updateOne(
      { _id: params.user_id, 'balloon.sent': balloon._id },
      { $set: { 'balloon.sent': null } }
    ),
    quota_usage_model.updateOne(
      {
        user_id: new Types.ObjectId(params.user_id),
        date: startOfUtcDay(balloon.createdAt)
      },
      { $inc: { balloons_sent: -1 } }
    )
  ]);

  trackEvent(params.user_id, mixpanelEvents.balloon_v2_cancel);
  return { cancelled: true };
}

// ─────────────────────────────────────────────────────────────────────────
// REFUSE: recipient declines, balloon reroutes
// ─────────────────────────────────────────────────────────────────────────

export async function refuseBalloonV2(params: {
  balloon_id: string;
  sender_id: string;
  user_id: string;
  disable?: boolean;
}): Promise<{ refused: true }> {
  if (activeBalloonTimeouts.has(params.balloon_id)) {
    clearTimeout(activeBalloonTimeouts.get(params.balloon_id)!);
    activeBalloonTimeouts.delete(params.balloon_id);
  }
  activeBalloonHolders.delete(params.balloon_id);

  user_model.findByIdAndUpdate(params.user_id, {
    $set: {
      'balloon.last_received_at': new Date(),
      'balloon.disabled': params.disable ?? false
    }
  }).catch(err => console.error('Rate limit error:', err));

  const balloon = await balloon_model.findByIdAndUpdate(
    params.balloon_id,
    { $addToSet: { rejected_by: params.user_id } },
    { new: true }
  ).lean() as unknown as BalloonDocument | null;

  if (!activeBalloonSkips.has(params.balloon_id)) {
    activeBalloonSkips.set(params.balloon_id, new Set());
  }
  activeBalloonSkips.get(params.balloon_id)!.add(params.user_id);

  if (balloon && balloon.status === 'pending') {
    await routeBalloonToOnlineUser(
      params.sender_id,
      params.balloon_id,
      userSocketMap,
      0,
      balloon
    );
  }

  trackEvent(
    params.user_id,
    params.disable ? mixpanelEvents.balloon_v2_stop : mixpanelEvents.balloon_v2_refuse
  );

  return { refused: true };
}

// ─────────────────────────────────────────────────────────────────────────
// ACCEPT: recipient catches the balloon → match
// Emits sockets to both parties so other devices update live.
// ─────────────────────────────────────────────────────────────────────────

export interface AcceptBalloonV2Result {
  mate: Mate;
  acceptorId: string;
  inboxItem: InboxItem;
}

export async function acceptBalloonV2(params: {
  balloon_id: string;
  sender_id: string;
  user_id: string;
}): Promise<AcceptBalloonV2Result> {
  if (activeBalloonTimeouts.has(params.balloon_id)) {
    clearTimeout(activeBalloonTimeouts.get(params.balloon_id)!);
    activeBalloonTimeouts.delete(params.balloon_id);
  }
  activeBalloonHolders.delete(params.balloon_id);
  activeBalloonSkips.delete(params.balloon_id);

  void user_model.findByIdAndUpdate(params.user_id, {
    $set: { 'balloon.last_received_at': new Date() }
  }).catch(err => console.error('error:', err));

  const balloon = await balloon_model.findByIdAndUpdate(
    params.balloon_id,
    { $set: { status: 'accepted', matchedAt: new Date(), pairedUser: params.user_id } },
    { new: true }
  ).lean() as unknown as BalloonDocument | null;

  if (!balloon) throw new BalloonNotFoundError();

  const matchRes = await match({ _id: params.user_id, mate_id: params.sender_id });
  if (!matchRes) throw new Error('Match failed');

  const acceptor: any = await user_model.findById(params.user_id).lean();
  if (!acceptor) throw new Error('Acceptor not found');

  const inboxItem = await v2AcceptBalloonCleanUp(balloon, params.user_id);

  await sendNotificationUser(
    params.sender_id,
    balloonMatchNotification(`${acceptor.name} caught your balloon!`)
  );

  const senderPayload = { mate: matchRes.user, acceptorId: params.user_id, inboxItem };
  const acceptorPayload = { mate: matchRes.mate, acceptorId: params.user_id, inboxItem };

  userSocketMap[params.sender_id]?.forEach((s: any) =>
    s.emit(SOCKET_ENDPONTS.v2_accept_balloon, senderPayload)
  );
  userSocketMap[params.user_id]?.forEach((s: any) =>
    s.emit(SOCKET_ENDPONTS.v2_accept_balloon, acceptorPayload)
  );

  trackEvent(params.user_id, mixpanelEvents.balloon_v2_accept);

  return acceptorPayload;
}