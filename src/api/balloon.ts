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
import { getUserByID, s3Creator } from '../mongodb';
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

  // 1. Fetch balloon first so we know who permanently rejected it
  const currentBalloon = balloonData || await balloon_model.findById(balloonId);
  if (!currentBalloon || currentBalloon.status !== 'pending') {
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

    // High-speed check: must be logged in, eligible, and not a friend/busy
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

  // 4. THE AGGREGATION: Find an eligible user from our meticulously filtered list
  const eligibleUser = await user_model.aggregate([
    {
      $match: {
        _id: { $in: filteredCandidates.map(id => new mongoose.Types.ObjectId(id)) },
        'balloon.disabled': { $ne: true },
        $or: [
          { 'balloon.last_received_at': { $lte: cooldownDate } },
          { 'balloon.last_received_at': null },
          { 'balloon.last_received_at': { $exists: false } }
        ]
      }
    },
    { $sample: { size: 1 } } // Pick one random eligible patient
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

    // Use findByIdAndUpdate to push the miss to the database immediately
    const updatedBalloon = await balloon_model.findByIdAndUpdate(
      balloonId,
      { $addToSet: { rejected_by: matchedUserId } },
      { new: true }
    );

    if (updatedBalloon && updatedBalloon.status === 'pending') {
      if (userSocketMap[matchedUserId]) {
        userSocketMap[matchedUserId].forEach((s: any) => s.emit(SOCKET_ENDPONTS.balloon_missed, { balloonId }));
      }
      trackEvent(matchedUserId, mixpanelEvents.balloon_v2_miss);

      if (!activeBalloonSkips.has(balloonId)) activeBalloonSkips.set(balloonId, new Set());
      activeBalloonSkips.get(balloonId)!.add(matchedUserId);

      // Recurse with the newly updated balloon document
      routeBalloonToOnlineUser(senderId, balloonId, userSocketMap, attempts + 1, updatedBalloon);
    }
  }, HOT_POTATO_TIMEOUT_MS);

  activeBalloonTimeouts.set(balloonId, timeout);
  return true;
}

export async function pairBalloons() {
  const pendingBalloons = await balloon_model
    .find({ status: 'pending', version: { $ne: 2 } })

    .sort({ createdAt: 1 });

  for (let i = 0; i < pendingBalloons.length; i++) {
    const balloon1 = pendingBalloons[i];

    const user1 = await getUserByID(balloon1.sender);
    if (!user1) {
      await balloon_model.findByIdAndDelete(balloon1._id);
      continue;
    }

    let matched = false;

    for (let j = i + 1; j < pendingBalloons.length; j++) {
      const balloon2 = pendingBalloons[j];

      const user2 = await getUserByID(balloon2.sender);
      if (!user2) {
        await balloon_model.findByIdAndDelete(balloon2._id);
        continue;
      }

      if (
        balloon1.cancelledBalloons?.includes(balloon2._id) ||
        balloon2.cancelledBalloons?.includes(balloon1._id)
      ) {
        continue; // skip cancelled pair
      }


      // skip if they are already mates
      if (
        user1.mates.some(m => m._id.toString() === user2._id.toString()) ||
        user2.mates.some(m => m._id.toString() === user1._id.toString())
      ) {
        continue;
      }

      // ✅ match found
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
        sendNotificationUser(
          balloon1.sender.toString(),
          balloonReceivedNotification()
        ),
        sendNotificationUser(
          balloon2.sender.toString(),
          balloonReceivedNotification()
        )
      ]);

      sendSocketNotificationToUser(
        balloon1.sender.toString(),
        SOCKET_ENDPONTS.match_balloon,
        { received_balloon: balloon2 }
      );
      sendSocketNotificationToUser(
        balloon2.sender.toString(),
        SOCKET_ENDPONTS.match_balloon,
        { received_balloon: balloon1 }
      );

      trackEvent(balloon1.sender.toString(), mixpanelEvents.balloon_pair);

      // remove both from local array
      pendingBalloons.splice(j, 1); // remove balloon2 first
      pendingBalloons.splice(i, 1); // then balloon1
      i--; // adjust index because we removed the current one
      matched = true;
      break;
    }

    if (!matched) {
      console.log(`No match found for balloon: ${balloon1._id}`);
    }
  }

  console.log('Matching cycle complete.');
}

export async function unPairBalloons() {
  // --- MODIFICATION: Exclude v2 balloons entirely ---
  const balloons = await balloon_model.find({
    status: { $in: ['paired', 'accepted'] },
    version: { $ne: 2 }
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

  // --- MODIFICATION: Exclude v2 balloons entirely ---
  const balloons = await balloon_model.find({
    lastActivityAt: { $lt: expirationDate },
    version: { $ne: 2 }
  });

  await Promise.all(
    balloons.map(async (balloon) => {
      // Remove the balloon
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

      // Handle paired balloon
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
    const inboxItem1: InboxItem = {
      _id: new ObjectId().toString(),
      drawing: params.balloon.drawingJsonUrl,
      image: params.balloon.img,
      thumbnail: params.balloon.thumbnail,
      date: new Date(),
      sender: params.balloon.sender,
      followers: [params.balloon.sender, params.otherBalloon.sender],
      original_followers: [params.balloon.sender, params.otherBalloon.sender],
      seen_by: [],
      comments_seen_by: [],
      comments: [],
      aspect_ratio: params.balloon.aspect_ratio
    };

    const inboxItem2: InboxItem = {
      _id: new ObjectId().toString(),
      drawing: params.otherBalloon.drawingJsonUrl,
      image: params.otherBalloon.img,
      thumbnail: params.otherBalloon.thumbnail,
      date: new Date(),
      sender: params.otherBalloon.sender,
      followers: [params.otherBalloon.sender, params.balloon.sender],
      original_followers: [params.otherBalloon.sender, params.balloon.sender],
      seen_by: [],
      comments_seen_by: [],
      comments: [],
      aspect_ratio: params.otherBalloon.aspect_ratio
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

    // Always prepare updates array
    const updates: Promise<any>[] = [];

    trackEvent(params.user_id, mixpanelEvents.balloon_cancel);

    if (balloon) {
      // fetch other balloon in parallel with S3 deletion
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

      // clean up user's balloon reference
      updates.push(
        user_model.updateOne(
          { _id: params.user_id },
          { $set: { balloon: {} } }
        )
      );

      await Promise.all(updates);

      return otherBalloon as unknown as Balloon;
    } else {
      // balloon already deleted, still cleanup user reference
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
    // 1. Synthesize the single shared Inbox Item
    const inboxItem: InboxItem = {
      _id: new ObjectId().toString(),
      drawing: balloon.drawingJsonUrl,
      image: balloon.img,
      thumbnail: balloon.thumbnail,
      date: new Date(),
      sender: balloon.sender, // The original creator
      followers: [balloon.sender.toString(), acceptorId],
      original_followers: [balloon.sender.toString(), acceptorId],
      seen_by: [],
      comments_seen_by: [],
      comments: [],
      aspect_ratio: balloon.aspect_ratio
    };

    // 2. Perform the database transplant
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
      // We delete the balloon since it has fully transformed into an Inbox Item
      balloon_model.findByIdAndDelete(balloon._id)
    ]);

    // Optional: Track the successful operation for your analytics
    trackEvent(balloon.sender.toString(), mixpanelEvents.balloon_match);
    trackEvent(acceptorId, mixpanelEvents.balloon_match);

    return inboxItem;

  } catch (e) {
    throw new Error('Failed to run V2 balloon cleanup: ' + e);
  }
}

export async function triageWaitingRoom(userId: string, socket: any) {
  // 1. Fetch user with mates
  const user = await user_model.findById(userId).select('balloon mates');
  if (!user || user.balloon?.disabled === true) return;

  const cooldownDate = new Date(Date.now() - BALLOON_COOLDOWN_MS);
  const lastReceived = user.balloon?.last_received_at;
  if (lastReceived && new Date(lastReceived) > cooldownDate) return;

  // 2. Prepare exclusion lists
  const mateIds = user.mates?.map(m => new mongoose.Types.ObjectId(m._id)) || [];
  const excludedSenders = [new mongoose.Types.ObjectId(userId), ...mateIds];

  // NEW: Get IDs of balloons currently being held by online users
  const activeBalloons = Array.from(activeBalloonHolders.keys()).map(id => new mongoose.Types.ObjectId(id));

  // 3. Find the oldest pending v2 balloon that is NOT in circulation and NOT from a friend
  const waitingBalloon = await balloon_model.findOne({
    _id: { $nin: activeBalloons },
    status: 'pending',
    version: 2,
    sender: { $nin: excludedSenders },
    rejected_by: { $ne: new mongoose.Types.ObjectId(userId) }
  }).sort({ createdAt: 1 });


  if (!waitingBalloon) return;

  const balloonId = waitingBalloon._id.toString();

  // 4. Lock the balloon to this user
  activeBalloonHolders.set(balloonId, userId);
  socket.emit(SOCKET_ENDPONTS.receive_new_balloon, {
    balloon: waitingBalloon
  });

  // 5. Start the Hot Potato timer
// Inside triageWaitingRoom timeout
  const timeout = setTimeout(async () => {
    activeBalloonTimeouts.delete(balloonId);
    activeBalloonHolders.delete(balloonId);

    const currentBalloon = await balloon_model.findById(balloonId);
    if (currentBalloon && currentBalloon.status === 'pending') {
      socket.emit(SOCKET_ENDPONTS.balloon_missed, { balloonId });

      // Throw back with the current userId (the one who just logged in) in the skip list
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