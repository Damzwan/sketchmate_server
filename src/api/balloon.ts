// The life-support monitor for active balloons
import { user_model } from '../models/user.model';
import mongoose from 'mongoose';
import { AcceptBalloonParams, Balloon, CancelBalloonParams, InboxItem, SOCKET_ENDPONTS } from '../types/types';
import { balloon_model } from '../models/balloon.model';
import { sendNotificationUser } from '../notifications';
import {
  balloonExpiredNotification,
  balloonMatchExpiredNotification,
  balloonReceivedNotification,
  otherBalloonExpiredNotification
} from '../config/notification.config';
import { mixpanelEvents, trackEvent } from '../mixpanel';
import { sendSocketNotificationToUser, userSocketMap } from './socket/socket';
import { s3Creator } from '../mongodb';
import { ObjectId } from 'mongodb';
import { inbox_model } from '../models/inbox.model';
import { CONTAINER } from '../s3';
import { compareVersions, isOldEnough } from '../helper';

const BALLOON_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 Hours
const HOT_POTATO_TIMEOUT_MS = 60000;          // 60 Seconds
const MAX_LIVE_ROUTING_ATTEMPTS = 5;


export const activeBalloonTimeouts = new Map<string, any>();
export const activeBalloonHolders = new Map<string, string>();
export const activeBalloonSkips = new Map<string, Set<string>>();


export async function routeBalloonToOnlineUser(
  senderId: string,
  balloonId: string,
  userSocketMap: any,
  attempts = 0,
  balloonData?: any
): Promise<any> {
  if (attempts >= MAX_LIVE_ROUTING_ATTEMPTS) {
    console.log(`Balloon ${balloonId} exhausted attempts. Returning to Waiting Room.`);
    activeBalloonSkips.delete(balloonId); // CLEANUP
    return false;
  }

  // 1. Fetch balloon first so we know who permanently rejected it.
  //    MODERATION: a balloon must be both lifecycle-pending AND moderation-active
  //    to be eligible for circulation. A quarantined balloon stays in the DB but
  //    is invisible to the routing layer.
  const currentBalloon = balloonData || await balloon_model.findById(balloonId);
  if (
    !currentBalloon ||
    currentBalloon.status !== 'pending' ||
    currentBalloon.moderation_status !== 'active'
  ) {
    activeBalloonSkips.delete(balloonId);
    return false;
  }

  // 2. Gather all exclusion lists
  const busyUserIds = Array.from(activeBalloonHolders.values());
  const sender = await user_model.findById(senderId).select('mates');
  const mateIds = sender?.mates?.map(m => m._id.toString()) || [];
  const currentSkips = activeBalloonSkips.get(balloonId) || new Set<string>();

  // Extract persistent rejections from the DB
  const dbRejects = currentBalloon.rejected_by?.map((id: any) => id.toString()) || [];

  // 3. Filter online users
  const onlineUserIds = Object.keys(userSocketMap);

  const filteredCandidates = onlineUserIds.filter(id => {
    const userSocket = userSocketMap[id]?.[0];
    const oldEnough = userSocket.data.user.date_of_birth ? isOldEnough(userSocket.data.user.date_of_birth) : true;
    const hasRecentVersion = compareVersions(userSocket.data.user.version, '0.4.1') >= 0;

    return (
      hasRecentVersion &&
      id !== senderId &&
      oldEnough &&
      !busyUserIds.includes(id) &&
      !mateIds.includes(id) &&
      !currentSkips.has(id) &&
      !dbRejects.includes(id)
    );
  });


  if (filteredCandidates.length === 0) {
    console.log(`No eligible candidates for ${balloonId}.`);
    activeBalloonSkips.delete(balloonId); // CLEANUP
    return false;
  }

  const cooldownDate = new Date(Date.now() - BALLOON_COOLDOWN_MS);

  // 4. THE AGGREGATION: Find an eligible user from our meticulously filtered list.
  //    MODERATION: exclude any user whose RECEIVE_BALLOON capability is blocked.
  //    blocked_capabilities is an array on user.restriction; the $nin match below
  //    works against both never-restricted users (empty array) and currently
  //    restricted users.
  const eligibleUser = await user_model.aggregate([
    {
      $match: {
        _id: { $in: filteredCandidates.map(id => new mongoose.Types.ObjectId(id)) },
        'balloon.disabled': { $ne: true },
        'restriction.blocked_capabilities': { $nin: ['RECEIVE_BALLOON'] },
        $or: [
          { 'balloon.last_received_at': { $lte: cooldownDate } },
          { 'balloon.last_received_at': null },
          { 'balloon.last_received_at': { $exists: false } }
        ]
      }
    },
    { $sample: { size: 1 } }
  ]);

  if (!eligibleUser || eligibleUser.length === 0) return false;
  const matchedUserId = eligibleUser[0]._id.toString();

  const currentlyBusy = Array.from(activeBalloonHolders.values());
  if (currentlyBusy.includes(matchedUserId)) {
    console.log(`Race condition avoided! ${matchedUserId} was just taken.`);
    return routeBalloonToOnlineUser(senderId, balloonId, userSocketMap, attempts, currentBalloon);
  }

  // 5. Administer the balloon
  activeBalloonHolders.set(balloonId, matchedUserId);

  if (userSocketMap[matchedUserId]) {
    userSocketMap[matchedUserId].forEach((s: any) => {
      s.emit(SOCKET_ENDPONTS.receive_new_balloon, { balloon: currentBalloon });
    });
    trackEvent(matchedUserId, mixpanelEvents.balloon_v2_receive);
  }

  // 6. Start the Hot Potato Timer
  const timeout = setTimeout(async () => {
    activeBalloonTimeouts.delete(balloonId);
    activeBalloonHolders.delete(balloonId);

    const updatedBalloon = await balloon_model.findByIdAndUpdate(
      balloonId,
      { $addToSet: { rejected_by: matchedUserId } },
      { new: true }
    );

    // MODERATION: re-check moderation_status — a balloon can be quarantined
    // mid-flight by a report from a previous holder. If so, stop circulating.
    if (
      updatedBalloon &&
      updatedBalloon.status === 'pending' &&
      updatedBalloon.moderation_status === 'active'
    ) {
      if (userSocketMap[matchedUserId]) {
        userSocketMap[matchedUserId].forEach((s: any) => s.emit(SOCKET_ENDPONTS.balloon_missed, { balloonId }));
      }
      trackEvent(matchedUserId, mixpanelEvents.balloon_v2_miss);

      if (!activeBalloonSkips.has(balloonId)) activeBalloonSkips.set(balloonId, new Set());
      activeBalloonSkips.get(balloonId)!.add(matchedUserId);

      routeBalloonToOnlineUser(senderId, balloonId, userSocketMap, attempts + 1, updatedBalloon).catch(err => console.error(`Hot potato reroute failed for ${balloonId}:`, err));
    } else if (updatedBalloon && updatedBalloon.moderation_status !== 'active') {
      // Balloon was quarantined while in this user's hands — just clean up silently.
      // The sender will be notified by the moderation service.
      activeBalloonSkips.delete(balloonId);
      console.log(`Balloon ${balloonId} quarantined mid-flight; circulation halted.`);
    }
  }, HOT_POTATO_TIMEOUT_MS);

  activeBalloonTimeouts.set(balloonId, timeout);
  return true;
}

export async function pairBalloons() {
  console.log('Starting optimized V1 matching cycle...');

  // 1. Bulk Fetch: only pending V1 balloons that are moderation-active.
  const pendingBalloons = await balloon_model
    .find({
      status: 'pending',
      version: { $ne: 2 },
      moderation_status: 'active'   // MODERATION: quarantined balloons never pair
    })
    .sort({ createdAt: 1 })
    .lean();

  if (pendingBalloons.length < 2) return;

  const senderIds = [...new Set(pendingBalloons.map(b => b.sender.toString()))];

  // 3. Bulk Fetch Users. We need mates AND restriction to filter senders whose
  //    SEND_BALLOON capability was revoked after they sent the balloon. This is
  //    rare (already-sent balloons usually stay in circulation) but the policy
  //    says blocked users shouldn't keep matching, so we honor it here.
  const users = await user_model
    .find({ _id: { $in: senderIds } })
    .select('mates restriction')
    .lean();

  const userMap = new Map();
  for (const user of users) {
    userMap.set(user._id.toString(), user);
  }

  const matchedBalloonIds = new Set<string>();
  const dbUpdates = [];

  for (let i = 0; i < pendingBalloons.length; i++) {
    const balloon1 = pendingBalloons[i];
    const b1Id = balloon1._id.toString();

    if (matchedBalloonIds.has(b1Id)) continue;

    const user1 = userMap.get(balloon1.sender.toString());
    if (!user1) {
      dbUpdates.push(balloon_model.findByIdAndDelete(balloon1._id));
      continue;
    }

    // MODERATION: sender was restricted after sending — skip pairing.
    // The balloon stays pending and will be cleaned up when the restriction
    // expires or by the standard expiry sweep.
    if (user1.restriction?.blocked_capabilities?.includes('SEND_BALLOON')) continue;

    for (let j = i + 1; j < pendingBalloons.length; j++) {
      const balloon2 = pendingBalloons[j];
      const b2Id = balloon2._id.toString();

      if (matchedBalloonIds.has(b2Id)) continue;
      if (balloon1.sender.toString() === balloon2.sender.toString()) continue;

      const user2 = userMap.get(balloon2.sender.toString());
      if (!user2) continue;

      // Same check for the other side
      if (user2.restriction?.blocked_capabilities?.includes('SEND_BALLOON')) continue;

      const cancelled1 = balloon1.cancelledBalloons?.map((id: any) => id.toString()) || [];
      const cancelled2 = balloon2.cancelledBalloons?.map((id: any) => id.toString()) || [];

      if (cancelled1.includes(b2Id) || cancelled2.includes(b1Id)) continue;

      const mates1 = user1.mates?.map((m: any) => m._id.toString()) || [];
      const mates2 = user2.mates?.map((m: any) => m._id.toString()) || [];

      if (mates1.includes(user2._id.toString()) || mates2.includes(user1._id.toString())) continue;

      // ✅ MATCH FOUND
      matchedBalloonIds.add(b1Id);
      matchedBalloonIds.add(b2Id);

      dbUpdates.push((async () => {
        await Promise.all([
          balloon_model.updateOne(
            { _id: balloon1._id },
            {
              $set: {
                status: 'paired',
                pairedUser: balloon2.sender,
                pairedBalloon: balloon2._id,
                matchedAt: new Date()
              }
            }
          ),
          balloon_model.updateOne(
            { _id: balloon2._id },
            {
              $set: {
                status: 'paired',
                pairedUser: balloon1.sender,
                pairedBalloon: balloon1._id,
                matchedAt: new Date()
              }
            }
          ),
          user_model.updateOne(
            { _id: balloon1.sender },
            { $set: { 'balloon.received': balloon2._id } }
          ),
          user_model.updateOne(
            { _id: balloon2.sender },
            { $set: { 'balloon.received': balloon1._id } }
          ),
          sendNotificationUser(balloon1.sender.toString(), balloonReceivedNotification()),
          sendNotificationUser(balloon2.sender.toString(), balloonReceivedNotification())
        ]);

        sendSocketNotificationToUser(balloon1.sender.toString(), SOCKET_ENDPONTS.match_balloon, { received_balloon: balloon2 });
        sendSocketNotificationToUser(balloon2.sender.toString(), SOCKET_ENDPONTS.match_balloon, { received_balloon: balloon1 });

        trackEvent(balloon1.sender.toString(), mixpanelEvents.balloon_pair);
      })());

      break;
    }
  }

  await Promise.all(dbUpdates);

  console.log(`Matching cycle complete. Formed ${matchedBalloonIds.size / 2} pairs.`);
}

export async function unPairBalloons() {
  // MODERATION: only un-pair balloons whose moderation_status is active.
  // Quarantined balloons are handled by the moderation service, not the
  // standard lifecycle sweep — we don't want to flip a quarantined balloon
  // back to 'pending' and accidentally re-introduce it to circulation.
  const balloons = await balloon_model.find({
    status: { $in: ['paired', 'accepted'] },
    version: { $ne: 2 },
    moderation_status: 'active'
  });

  const expirationTime = 1000 * 60 * 60 * 24 * 1; // 1 day

  for (const balloon of balloons) {
    if (!balloon.matchedAt || balloon.matchedAt < new Date(Date.now() - expirationTime)) {
      await Promise.all([
        balloon_model.updateOne(
          { _id: balloon._id },
          {
            $addToSet: { cancelledBalloons: balloon.pairedBalloon },
            $set: {
              status: 'pending',
              pairedUser: null,
              pairedBalloon: null,
              matchedAt: null
            }
          }
        ),
        user_model.updateOne(
          { _id: balloon.sender },
          { $set: { 'balloon.received': null } }
        ),
        sendNotificationUser(
          balloon.sender.toString(),
          balloonMatchExpiredNotification()
        )
      ]);

      sendSocketNotificationToUser(
        balloon.sender.toString(),
        SOCKET_ENDPONTS.balloon_match_expired,
        {}
      );

      trackEvent(balloon.sender.toString(), mixpanelEvents.balloon_unpaired);

      console.log(`⏳ [V1] Balloon ${balloon._id} expired and reset.`);
    }
  }
}


export async function removeExpiredBalloons() {
  const expirationDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 3); // 3 days

  // MODERATION: include quarantined balloons in expiry sweeps so they get
  // cleaned up too — but only if they're past the normal expiry window.
  // Removed (mod-action) balloons are handled by the moderation service.
  const balloons = await balloon_model.find({
    lastActivityAt: { $lt: expirationDate },
    version: { $ne: 2 },
    moderation_status: { $ne: 'removed' }   // 'removed' is mod-owned territory
  });

  await Promise.all(
    balloons.map(async (balloon) => {
      await Promise.all([
        deleteBalloonS3(balloon as any as Balloon),
        balloon_model.findByIdAndDelete(balloon._id),
        user_model.updateOne(
          { _id: balloon.sender },
          { $set: { 'balloon.sent': null, 'balloon.received': null } }
        ),
        sendNotificationUser(
          balloon.sender.toString(),
          balloonExpiredNotification()
        )
      ]);

      sendSocketNotificationToUser(
        balloon.sender.toString(),
        SOCKET_ENDPONTS.balloon_expired,
        {}
      );

      if (balloon.pairedBalloon) {
        const otherBalloon = await balloon_model.findById(balloon.pairedBalloon);
        if (otherBalloon) {
          await Promise.all([
            user_model.updateOne(
              { _id: otherBalloon.sender },
              { $set: { 'balloon.received': null } }
            ),
            balloon_model.updateOne(
              { _id: otherBalloon._id },
              { $set: { status: 'pending' } }
            ),
            sendNotificationUser(
              otherBalloon.sender.toString(),
              otherBalloonExpiredNotification()
            )
          ]);

          console.log(`🔄 [V1] Paired balloon ${otherBalloon._id} set to pending`);
        }
      }

      trackEvent(balloon.sender.toString(), mixpanelEvents.balloon_expired);
      console.log(`⏳ [V1] Balloon ${balloon._id} expired`);
    })
  );
}

export async function acceptBalloonCleanUp(params: { balloon: Balloon, otherBalloon: Balloon } & {
  otherBalloon: Balloon
}): Promise<void> {
  try {
    // MODERATION: new inbox items inherit clean moderation state. The schema
    // defaults would also handle this, but being explicit prevents drift if
    // someone later changes the defaults.
    const inboxItem1: InboxItem = {
      _id: new ObjectId().toString(),
      drawing: params.balloon.drawingJsonUrl,
      image: params.balloon.img,
      thumbnail: params.balloon.thumbnail,
      date: new Date().toString(),
      sender: params.balloon.sender,
      followers: [params.balloon.sender, params.otherBalloon.sender],
      original_followers: [params.balloon.sender, params.otherBalloon.sender],
      seen_by: [],
      comments_seen_by: [],
      comments: [],
      aspect_ratio: params.balloon.aspect_ratio,
      status: 'active',
      reports_count: 0
    };

    const inboxItem2: InboxItem = {
      _id: new ObjectId().toString(),
      drawing: params.otherBalloon.drawingJsonUrl,
      image: params.otherBalloon.img,
      thumbnail: params.otherBalloon.thumbnail,
      date: new Date().toString(),
      sender: params.otherBalloon.sender,
      followers: [params.otherBalloon.sender, params.balloon.sender],
      original_followers: [params.otherBalloon.sender, params.balloon.sender],
      seen_by: [],
      comments_seen_by: [],
      comments: [],
      aspect_ratio: params.otherBalloon.aspect_ratio,
      status: 'active',
      reports_count: 0
    };

    await Promise.all([
      inbox_model.create(inboxItem1),
      inbox_model.create(inboxItem2),
      user_model.updateOne(
        { _id: params.balloon.sender },
        {
          $push: {
            inbox: {
              $each: [inboxItem1._id, inboxItem2._id]
            }
          }
        }
      ),
      user_model.updateOne(
        { _id: params.otherBalloon.sender },
        {
          $push: {
            inbox: {
              $each: [inboxItem1._id, inboxItem2._id]
            }
          }
        }
      ),
      balloon_model.findByIdAndDelete(params.balloon._id),
      balloon_model.findByIdAndDelete(params.otherBalloon._id),
      user_model.updateOne(
        { _id: params.balloon.sender },
        { $set: { balloon: {} } }
      ),
      user_model.updateOne(
        { _id: params.otherBalloon.sender },
        { $set: { balloon: {} } }
      )

    ])
    ;

    trackEvent(params.balloon.sender, mixpanelEvents.balloon_match);


  } catch (e) {
    throw new Error('Failed to accept balloon' + e);
  }
}

export async function deleteBalloonS3(balloon: Balloon): Promise<void> {
  await Promise.all([s3Creator.deleteBlob(balloon.img, CONTAINER.drawings),
    s3Creator.deleteBlob(balloon.thumbnail, CONTAINER.drawings),
    s3Creator.deleteBlob(balloon.drawingJsonUrl, CONTAINER.drawings)]);
}

export async function refuseBalloon(params: AcceptBalloonParams): Promise<Balloon[] | null> {
  try {
    const [otherBalloon, balloon] = await Promise.all([
      balloon_model.findOne({ sender: params.user_id }),
      balloon_model.findOneAndUpdate(
        { _id: params.balloon_id },
        { $set: { status: 'rejected', lastActivityAt: new Date() } },
        { new: true }
      )
    ]);
    trackEvent(params.user_id, mixpanelEvents.balloon_refuse);

    return [otherBalloon as unknown as Balloon, balloon as unknown as Balloon];
  } catch (e) {
    throw new Error('Failed to accept balloon');
  }
}

export async function cancelBalloon(params: CancelBalloonParams): Promise<Balloon | null> {
  try {
    const balloon = await balloon_model.findByIdAndDelete(params.balloon_id);

    const updates: Promise<any>[] = [];

    trackEvent(params.user_id, mixpanelEvents.balloon_cancel);


    if (balloon) {
      const [otherBalloon] = await Promise.all([
        balloon_model.findOne({ pairedUser: params.user_id }),
        deleteBalloonS3(balloon as any as Balloon)
      ]);

      if (otherBalloon) {
        updates.push(
          user_model.updateOne(
            { _id: otherBalloon.sender },
            { $set: { 'balloon.received': null } }
          ),
          balloon_model.updateOne(
            { _id: otherBalloon._id },
            { $set: { status: 'pending' } }
          )
        );
      }

      updates.push(
        user_model.updateOne(
          { _id: params.user_id },
          { $set: { balloon: {} } }
        )
      );

      await Promise.all(updates);

      return otherBalloon as unknown as Balloon;
    } else {
      await user_model.updateOne(
        { _id: params.user_id },
        { $set: { balloon: {} } }
      );
      return null;
    }
  } catch (e) {
    throw new Error('Failed to cancel balloon');
  }
}

export async function acceptBalloon(params: AcceptBalloonParams): Promise<Balloon[] | null> {
  try {
    // MODERATION: refuse to accept a quarantined balloon. Narrow race window
    // (routing already filters), but worth the cheap guard.
    const target = await balloon_model.findById(params.balloon_id).select('moderation_status').lean() as any;
    if (target && target.moderation_status !== 'active') {
      return null;
    }

    const [otherBalloon, balloon] = await Promise.all([
      balloon_model.findOne({ sender: params.user_id }),
      balloon_model.findOneAndUpdate(
        { _id: params.balloon_id },
        { $set: { status: 'accepted', lastActivityAt: new Date() } },
        { new: true }
      )
    ]);
    trackEvent(params.user_id, mixpanelEvents.balloon_accept);
    return [otherBalloon as unknown as Balloon, balloon as unknown as Balloon];
  } catch (e) {
    throw new Error('Failed to accept balloon');
  }
}

export async function rejectBalloonCleanUp(params: { balloon: Balloon; otherBalloon: Balloon }): Promise<void> {
  try {
    await Promise.all([
      balloon_model.updateOne(
        { _id: params.balloon._id },
        {
          $addToSet: { cancelledBalloons: params.otherBalloon._id },
          $set: {
            status: 'pending',
            pairedUser: null,
            pairedBalloon: null,
            matchedAt: null
          }
        }
      ),
      balloon_model.updateOne(
        { _id: params.otherBalloon._id },
        {
          $addToSet: { cancelledBalloons: params.balloon._id },
          $set: {
            status: 'pending',
            pairedUser: null,
            pairedBalloon: null,
            matchedAt: null
          }
        }
      ),
      user_model.updateOne(
        { _id: params.balloon.sender },
        { $set: { 'balloon.received': null } }
      ),
      user_model.updateOne(
        { _id: params.otherBalloon.sender },
        { $set: { 'balloon.received': null } }
      )
    ]);
  } catch (e) {
    throw new Error('Failed to reject balloon');
  }
}


export async function v2AcceptBalloonCleanUp(balloon: any, acceptorId: string): Promise<InboxItem> {
  try {
    // MODERATION: new inbox item is born clean. If the balloon was quarantined
    // we shouldn't be here at all (acceptBalloon guards against it), so this
    // is just defensive default-setting.
    const inboxItem: InboxItem = {
      _id: new ObjectId().toString(),
      drawing: balloon.drawingJsonUrl,
      image: balloon.img,
      thumbnail: balloon.thumbnail,
      date: new Date().toString(),
      sender: balloon.sender,
      followers: [balloon.sender.toString(), acceptorId],
      original_followers: [balloon.sender.toString(), acceptorId],
      seen_by: [],
      comments_seen_by: [],
      comments: [],
      aspect_ratio: balloon.aspect_ratio,
      status: 'active',
      reports_count: 0
    };

    await Promise.all([
      inbox_model.create(inboxItem),
      user_model.updateOne(
        { _id: balloon.sender },
        { $push: { inbox: inboxItem._id }, $set: { 'balloon.sent': null } }
      ),
      user_model.updateOne(
        { _id: acceptorId },
        { $push: { inbox: inboxItem._id } }
      ),
      balloon_model.findByIdAndDelete(balloon._id)
    ]);

    trackEvent(balloon.sender.toString(), mixpanelEvents.balloon_match);
    trackEvent(acceptorId, mixpanelEvents.balloon_match);

    activeBalloonSkips.delete(balloon._id.toString());
    activeBalloonHolders.delete(balloon._id.toString());
    activeBalloonTimeouts.delete(balloon._id.toString());

    return inboxItem;

  } catch (e) {
    throw new Error('Failed to run V2 balloon cleanup: ' + e);
  }
}

export async function triageWaitingRoom(userId: string, socket: any) {
  // MODERATION: refuse to surface waiting-room balloons to a user whose
  // RECEIVE_BALLOON capability is blocked. Could also be a quick early return
  // — cleaner than fetching balloons and then realizing we can't deliver.
  const user = await user_model.findById(userId).select('balloon mates restriction');
  if (!user || user.balloon?.disabled === true) return;

  const blockedCaps = user.restriction?.blocked_capabilities || [];
  if (blockedCaps.includes('RECEIVE_BALLOON')) return;

  const cooldownDate = new Date(Date.now() - BALLOON_COOLDOWN_MS);
  const lastReceived = user.balloon?.last_received_at;
  if (lastReceived && new Date(lastReceived) > cooldownDate) return;

  const mateIds = user.mates?.map(m => new mongoose.Types.ObjectId(m._id)) || [];
  const excludedSenders = [new mongoose.Types.ObjectId(userId), ...mateIds];

  const activeBalloons = Array.from(activeBalloonHolders.keys()).map(id => new mongoose.Types.ObjectId(id));

  // MODERATION: waiting room respects moderation_status. A quarantined balloon
  // sitting in the waiting room queue never gets handed out.
  const waitingBalloon = await balloon_model.findOne({
    _id: { $nin: activeBalloons },
    status: 'pending',
    moderation_status: 'active',
    version: 2,
    sender: { $nin: excludedSenders },
    rejected_by: { $ne: new mongoose.Types.ObjectId(userId) }
  }).sort({ createdAt: 1 });


  if (!waitingBalloon) return;

  const balloonId = waitingBalloon._id.toString();

  activeBalloonHolders.set(balloonId, userId);
  socket.emit(SOCKET_ENDPONTS.receive_new_balloon, {
    balloon: waitingBalloon
  });

  const timeout = setTimeout(async () => {
    activeBalloonTimeouts.delete(balloonId);
    activeBalloonHolders.delete(balloonId);

    const currentBalloon = await balloon_model.findById(balloonId);
    // MODERATION: re-check moderation_status before recirculating.
    if (
      currentBalloon &&
      currentBalloon.status === 'pending' &&
      currentBalloon.moderation_status === 'active'
    ) {
      socket.emit(SOCKET_ENDPONTS.balloon_missed, { balloonId });

      routeBalloonToOnlineUser(
        currentBalloon.sender.toString(),
        balloonId,
        userSocketMap,
        0,
        currentBalloon
      );
    }
  }, HOT_POTATO_TIMEOUT_MS);

  activeBalloonTimeouts.set(balloonId, timeout);
}