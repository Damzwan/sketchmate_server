import {
  AcceptBalloonParams,
  Balloon,
  CancelBalloonParams,
  ChangeUserNameParams,
  Comment,
  CommentParams,
  CreateBalloonPostParams,
  CreateSavedParams,
  CreateStickerParams,
  DeleteEmblemParams,
  DeleteSavedParams,
  DeleteStickerParams,
  GetInboxItemsParams,
  GetInboxRes,
  GetUserParams,
  GetUserRes,
  InboxItem,
  MatchParams,
  Mate,
  OnLoginEventParams,
  RegisterNotificationParams,
  RemoveFromInboxParams,
  Res,
  Saved,
  SeeInboxParams,
  SendMateRequestParams,
  SendParams,
  SOCKET_ENDPONTS,
  UnMatchParams,
  UnRegisterNotificationParams,
  UpdateUserParams,
  UploadProfileImgParams,
  User
} from './types/types';
import { CONTAINER, S3Creator } from './s3';
import mongoose, { Schema, Types } from 'mongoose';
import { user_model } from './models/user.model';
import { createThumbnail, imgToEmblem, removeBackground } from './helper';
import { ObjectId } from 'mongodb';
import { inbox_model } from './models/inbox.model';
import * as fs from 'fs';
import { minimum_supported_version } from './main';
import { balloon_model } from './models/balloon.model';
import { sendNotificationUser } from './notifications';
import {
  balloonExpiredNotification,
  balloonMatchExpiredNotification,
  balloonReceivedNotification,
  otherBalloonExpiredNotification
} from './config/notification.config';
import { sendSocketNotificationToUser } from './api/socket';
import { mixpanelEvents, trackEvent } from './mixpanel';

let s3Creator: S3Creator;

export async function connectDb(): Promise<void> {
  try {
    const url = process.env.mongo;
    if (!url) throw Error('No url available');
    await mongoose.connect(url, { dbName: 'prod' });
    console.log('Connected to database 👻');
    s3Creator = new S3Creator();
  } catch (e) {
    console.log(e);
  }
}

export async function createUser(auth_id: string): Promise<Res<User>> {
  try {
    const user = await user_model.create({
      auth_id,
      inbox: [],
      stickers: [],
      emblems: [],
      saved: [],
      name: 'Anonymous',
      img: s3Creator.getRandomStockProfileImg(),
      mates: [],
      mate_requests_sent: [],
      mate_requests_received: [],
      notifications: []
    });
    if (user._id) trackEvent(user._id, mixpanelEvents.create_account);

    return user;
  } catch (e) {
    console.log(e);
  }
}

export async function getUser(params: GetUserParams): Promise<Res<GetUserRes>> {
  try {
    if (!params._id && !params.auth_id) return undefined;
    let user: any;

    // // normal case, login through auth user id
    user = await user_model.findOne({ auth_id: params.auth_id }).lean();
    if (user) return { user, new_account: false, minimum_supported_version };

    // we sync an old account with its auth_id
    if (params._id) {
      user = await user_model.findById(params._id).lean();
      if (user) {
        user.auth_id = params.auth_id;
        await user_model.updateOne({ _id: user._id }, user); // set auth_id of user
        return { user, new_account: false, minimum_supported_version };
      }
    }

    user = await createUser(params.auth_id);
    return { user, new_account: true, minimum_supported_version };

  } catch (e) {
    throw new Error('User not found');
  }
}

export async function getUserByID(user_id: Schema.Types.ObjectId): Promise<Res<User>> {
  try {
    return await user_model.findById(user_id).lean();
  } catch (e) {
    throw new Error('User not found');
  }
}

export async function getUserMates(params: { user_id: string }): Promise<Res<Mate[]>> {
  try {
    const user = await user_model.findOne({ _id: params.user_id }, { mates: 1 }).lean();
    if (!user) throw new Error('User not found');
    return user.mates;
  } catch (e) {
    console.log(e);
  }
}

export async function getLastImgFromUser(params: { friend_id: string, user_id: string }): Promise<Res<{
  img: string,
  _id: string
}>> {
  try {
    const inbox = await inbox_model
      .findOne(
        {
          sender: params.friend_id,
          original_followers: { $in: [params.user_id] }
        },
        { thumbnail: 1, original_followers: 1 }
      )
      .sort({ _id: -1 })
      .lean();

    if (!inbox) return undefined;
    return { img: inbox.thumbnail, _id: inbox._id };
  } catch (e) {
    console.log(e);
  }
}

export async function getInboxItems(params: GetInboxItemsParams): Promise<GetInboxRes> {
  try {
    const inboxItems = await inbox_model
      .find({
        _id: { $in: params._ids }
      })
      .lean() as any as InboxItem[]; // TODO fix
    const uniqueUserIds = Array.from(new Set(inboxItems.reduce((acc: string[], curr) => acc.concat(curr.original_followers), [])));

    const userInfo = await getPartialUsers(uniqueUserIds);

    return { inboxItems, userInfo };
  } catch (e) {
    throw new Error('Inbox item not found');
  }
}

export async function comment(params: CommentParams) {
  try {
    const comment: Comment = {
      date: new Date(),
      _id: new ObjectId().toString(),
      message: params.message,
      sender: params.sender
    };
    await inbox_model.updateOne(
      {
        _id: params.inbox_id
      },
      {
        $set: {
          comments_seen_by: [params.sender]
        },
        $push: {
          comments: comment
        }
      }
    );
    trackEvent(params.sender, mixpanelEvents.drawing_comment);
    return comment;
  } catch (e) {
    console.log(e);
    throw new Error('Cannot place comment');
  }
}

export async function removeFromInbox(params: RemoveFromInboxParams) {
  try {
    trackEvent(params.user_id, mixpanelEvents.drawing_deleted);
    const [inboxItem] = await Promise.all([
      inbox_model.findByIdAndUpdate(
        params.inbox_id,
        { $pull: { followers: params.user_id } }, // Use $pull with a query for _id
        { new: true }
      ),
      user_model.findByIdAndUpdate(
        params.user_id,
        {
          $pull: {
            inbox: params.inbox_id
          }
        }
      )
    ]);

    if (inboxItem?.followers.length === 0) {
      await Promise.all([s3Creator.deleteBlob(inboxItem.thumbnail, CONTAINER.drawings), s3Creator.deleteBlob(inboxItem.image, CONTAINER.drawings), s3Creator.deleteBlob(inboxItem.drawing, CONTAINER.drawings), inbox_model.deleteOne({ _id: params.inbox_id })]);
    }
  } catch (e) {
    throw new Error('Cannot remove');
  }
}


export async function getUserSubscription(params: { _id: string }): Promise<Res<User>> {
  try {
    return await user_model.findById(params._id, { subscriptions: 1, mate: 1, _id: 1, img: 1 }).lean() as Res<User>;
  } catch (e) {
    throw new Error('User not found');
  }
}

export async function match(params: MatchParams) {
  try {
    if (params._id === params.mate_id) throw new Error('Cannot match to oneself');
    const [user, mate] = await Promise.all([
      user_model.findById(params._id).lean(),
      user_model.findById(params.mate_id).lean()
    ]);
    if (!user || !mate) throw new Error('One of the users not found');
    if (user.mates.some(m => m._id.toString() == mate._id.toString()) || mate.mates.some(m => m._id.toString() == user._id.toString()))
      throw new Error('Already matched');

    user.mates.push({
      _id: params.mate_id,
      name: mate.name,
      img: mate.img
    });

    user.mate_requests_received = user.mate_requests_received.filter(m => m.toString() != mate._id.toString());
    user.mate_requests_sent = user.mate_requests_sent.filter(m => m.toString() != mate._id.toString());


    mate.mates.push({
      _id: user._id,
      name: user.name,
      img: user.img
    });

    mate.mate_requests_received = mate.mate_requests_received.filter(m => m.toString() != user._id.toString());
    mate.mate_requests_sent = mate.mate_requests_sent.filter(m => m.toString() != user._id.toString());


    await Promise.all([
      user_model.updateOne(
        { _id: params._id },
        {
          $set: {
            mates: user.mates,
            mate_requests_received: user.mate_requests_received,
            mate_requests_sent: user.mate_requests_sent
          }
        }
      ),
      user_model.updateOne(
        { _id: params.mate_id },
        {
          $set: {
            mates: mate.mates,
            mate_requests_received: mate.mate_requests_received,
            mate_requests_sent: mate.mate_requests_sent

          }
        }
      )
    ]);
    trackEvent(params._id, mixpanelEvents.match);

    return { user: user, mate: mate };
  } catch (e) {
    throw new Error('Cannot match with mate');
  }
}

export async function storeMessage(params: SendParams): Promise<Res<InboxItem>> {
  try {
    // const imgBuffer = dataUrlToBuffer(params.img);

    const [blobUrl, imgUrl, thumbnailUrl] = await Promise.all([
      s3Creator.upload(params.drawing),
      s3Creator.uploadImg(params.img),
      s3Creator.uploadImg(await createThumbnail(params.img))
    ]);

    const date = new Date();
    const inboxItem: InboxItem = {
      _id: new ObjectId().toString(),
      drawing: blobUrl,
      image: imgUrl,
      thumbnail: thumbnailUrl,
      date: date,
      sender: params._id,
      followers: params.followers,
      original_followers: params.followers,
      seen_by: [params._id],
      comments_seen_by: [params._id],
      comments: [],
      aspect_ratio: params.aspect_ratio
    };

    await Promise.all([
      inbox_model.create(inboxItem),
      ...params.followers.map(follower => user_model.updateOne({ _id: follower }, { $push: { inbox: inboxItem._id } }))
    ]);
    trackEvent(params._id, mixpanelEvents.drawing_sent);
    return inboxItem;
  } catch (e) {
    console.log(e);
    throw new Error('Failed sending to mate');
  }
}

export async function unMatch(params: UnMatchParams): Promise<Res<void>> {
  try {
    await Promise.all([
      user_model.updateOne(
        { _id: params._id },
        { $pull: { mates: { _id: params.mate_id } } }
      ),
      user_model.updateOne(
        { _id: params.mate_id },
        { $pull: { mates: { _id: params._id } } }
      )
    ]);
    trackEvent(params._id, mixpanelEvents.unMatch);
  } catch (e) {
    throw new Error('Failed to unmatch');
  }
}

export async function subscribe(params: RegisterNotificationParams): Promise<Res<void>> {
  try {
    // TODO we should be able to combine these but somehow not working...
    await user_model.updateOne(
      { _id: params.user_id },
      {
        $pull: {
          subscriptions: { fingerprint: params.subscription.fingerprint }  // Target the specific subscription to remove
        }
      }
    );
    await user_model.updateOne(
      { _id: params.user_id },
      {
        $push: { subscriptions: params.subscription } // Add the new subscription
      }
    );
  } catch (e) {
    throw new Error('Failed to subscribe: ' + e);
  }
}


export async function unsubscribe(params: UnRegisterNotificationParams): Promise<Res<void>> {
  try {
    await user_model.updateOne(
      { _id: params.user_id },
      {
        $pull: {
          subscriptions: { fingerprint: params.fingerprint }  // Target the specific subscription to remove
        }
      }
    );
  } catch (e) {
    throw new Error('Failed to unsubscribe');
  }
}


export async function onLoginEvent(params: OnLoginEventParams): Promise<Res<void>> {
  try {
    trackEvent(params.user_id, mixpanelEvents.login);
    await user_model.updateOne(
      { _id: params.user_id, 'subscriptions.fingerprint': params.fingerprint },
      {
        $set: {
          'subscriptions.$.logged_in': params.loggedIn
        }
      }
    );
  } catch (e) {
    throw new Error('Failed to update subscriptions');
  }
}


export async function changeUserName(params: ChangeUserNameParams): Promise<Res<void>> {
  try {
    const user = await user_model.findById(params._id);
    if (!user) return;

    const updates: any[] = [
      {
        updateOne: {
          filter: { _id: params._id },
          update: { $set: { name: params.name } }
        }
      }
    ];

    for (const mate of user.mates) {
      const mateDocument = await user_model.findById(mate._id);
      if (!mateDocument) continue;
      const mateIndex = mateDocument.mates.findIndex(friend => friend._id.toString() === params._id);

      if (mateIndex !== -1) {
        updates.push({
          updateOne: {
            filter: { _id: mate._id },
            update: { $set: { 'mates.$[elem].name': params.name } },
            arrayFilters: [{ 'elem._id': new Types.ObjectId(params._id) }]
          }
        });
      }
    }

    await user_model.bulkWrite(updates);

  } catch (e) {
    throw new Error('Failed to change name');
  }
}

export async function updateUser(params: UpdateUserParams): Promise<Res<void>> {
  try {
    const { _id, ...updates } = params;

    if (!_id) throw new Error('User _id is required');

    await user_model.updateOne({ _id }, { $set: updates });

  } catch (e) {
    throw new Error('Failed to update user: ' + (e as Error).message);
  }
}


export async function uploadProfileImg(params: UploadProfileImgParams): Promise<Res<string>> {
  try {
    const url = await s3Creator.uploadFile(params.img.filepath, params.img.mimetype, CONTAINER.account);

    const user = await user_model.findById(params._id);
    if (!user) return;

    const updates: any[] = [
      {
        updateOne: {
          filter: { _id: params._id },
          update: { $set: { img: url } }
        }
      }
    ];

    for (const mate of user.mates) {
      const mateDocument = await user_model.findById(mate._id);
      if (!mateDocument) continue;
      const mateIndex = mateDocument.mates.findIndex(friend => friend._id.toString() === params._id);

      if (mateIndex !== -1) {
        updates.push({
          updateOne: {
            filter: { _id: mate._id },
            update: { $set: { 'mates.$[elem].img': url } },
            arrayFilters: [{ 'elem._id': new Types.ObjectId(params._id) }]
          }
        });
      }
    }

    await user_model.bulkWrite(updates);

    if (params.previousImage && !params.previousImage.includes('stock'))
      s3Creator.deleteBlob(params.previousImage, CONTAINER.account);
    fs.promises.unlink(params.img.filepath);
    return url;
  } catch (e) {
    throw new Error('Failed to change name');
  }
}

export async function deleteProfileImg(user_id: string, stock_img: string) {
  try {
    const user = await user_model.findById(user_id);
    if (!user) return;

    const updates: any[] = [
      {
        updateOne: {
          filter: { _id: user_id },
          update: { $set: { img: stock_img } }
        }
      }
    ];

    for (const mate of user.mates) {
      const mateDocument = await user_model.findById(mate._id);
      if (!mateDocument) continue;
      const mateIndex = mateDocument.mates.findIndex(friend => friend._id.toString() === user_id);

      if (mateIndex !== -1) {
        updates.push({
          updateOne: {
            filter: { _id: mate._id },
            update: { $set: { 'mates.$[elem].img': stock_img } },
            arrayFilters: [{ 'elem._id': new Types.ObjectId(user_id) }]
          }
        });
      }
    }

    await user_model.bulkWrite(updates);

    if (user && !user.img.includes('stock')) s3Creator.deleteBlob(user.img, CONTAINER.account);
  } catch (e) {
    console.log(e);
  }
}

export async function createSticker(params: CreateStickerParams): Promise<Res<string>> {
  try {
    const url = await s3Creator.uploadFile(params.img.filepath, 'image/webp', CONTAINER.stickers);
    const new_url: string = await removeBackground(url!);

    await user_model.updateOne({ _id: params._id }, { $push: { stickers: new_url } });
    return new_url;
  } catch (e) {
    throw new Error('Failed to create sticker');
  }
}

export async function createEmblem(params: CreateStickerParams): Promise<Res<string>> {
  try {
    const img = await imgToEmblem(params.img.filepath);
    const url = await s3Creator.uploadImg(img, CONTAINER.stickers);
    await user_model.updateOne({ _id: params._id }, { $push: { emblems: url } });
    return url;
  } catch (e) {
    throw new Error('Failed to create sticker');
  }
}

export async function createSaved(params: CreateSavedParams): Promise<Res<Saved>> {
  try {
    const [drawing_url, img_url] = await Promise.all([
      s3Creator.uploadFile(params.drawing.filepath, 'application/json', CONTAINER.stickers),
      s3Creator.uploadFile(params.img.filepath, 'image/webp', CONTAINER.stickers)
    ]);
    const saved: Saved = {
      img: img_url!,
      drawing: drawing_url!
    };
    await user_model.updateOne({ _id: params._id }, { $push: { saved: saved } });
    return saved;
  } catch (e) {
    throw new Error('Failed to create sticker');
  }
}

export async function deleteSticker(params: DeleteStickerParams): Promise<void> {
  try {
    await s3Creator.deleteBlob(params.sticker_url, CONTAINER.stickers);
    await user_model.findByIdAndUpdate(params.user_id, {
      $pull: {
        stickers: params.sticker_url
      }
    });
  } catch (e) {
    throw new Error('Failed to delete sticker');
  }
}

export async function deleteEmblem(params: DeleteEmblemParams): Promise<void> {
  try {
    await s3Creator.deleteBlob(params.emblem_url, CONTAINER.stickers);
    await user_model.findByIdAndUpdate(params.user_id, {
      $pull: {
        emblems: params.emblem_url
      }
    });
  } catch (e) {
    throw new Error('Failed to delete emblem');
  }
}

export async function deleteSaved(params: DeleteSavedParams): Promise<void> {
  try {
    const saved: Saved = {
      img: params.img_url,
      drawing: params.drawing_url
    };
    await Promise.all([
      s3Creator.deleteBlob(params.img_url, CONTAINER.stickers),
      s3Creator.deleteBlob(params.drawing_url, CONTAINER.stickers),
      await user_model.findByIdAndUpdate(params.user_id, {
        $pull: {
          saved: saved
        }
      })
    ]);
  } catch (e) {
    throw new Error('Failed to delete sticker');
  }
}

export async function seeInbox(params: SeeInboxParams) {
  try {
    await inbox_model.findByIdAndUpdate(params.inbox_id, {
      $addToSet: {
        seen_by: params.user_id,
        comments_seen_by: params.user_id
      }
    });
  } catch (e) {
    throw new Error(e as any);
  }
}

export async function createBalloon(params: CreateBalloonPostParams): Promise<Res<Balloon>> {
  const alreadyExistingBalloon = await balloon_model.findOne({ sender: params.sender });

  if (alreadyExistingBalloon) {
    throw new Error('Balloon already exists');
  }

  const [drawingJsonUrl, img, thumbnail] = await Promise.all([
    s3Creator.upload(params.drawing),
    s3Creator.uploadImg(params.img),
    s3Creator.uploadImg(await createThumbnail(params.img))
  ]);

  const balloonId = new ObjectId().toString();
  const balloonToCreate: Balloon = {
    _id: balloonId,
    status: 'pending',
    createdAt: new Date(),
    lastActivityAt: new Date(),
    drawingJsonUrl,
    img,
    thumbnail,
    aspect_ratio: params.aspect_ratio,
    sender: params.sender,
    message: params.message,
    cancelledBalloons: []
  };

  try {
    await Promise.all([
      balloon_model.create(balloonToCreate),
      user_model.updateOne(
        { _id: params.sender },
        { $set: { 'balloon.sent': balloonId } }
      )
    ]);


    trackEvent(params.sender, mixpanelEvents.balloon_create);

    return balloonToCreate;
  } catch (e) {
    throw new Error(`Failed to create balloon: ${(e as Error).message}`);
  }
}

export async function getBalloon(balloonId: string): Promise<Balloon | null> {
  try {
    return await balloon_model.findById(balloonId);
  } catch (e) {
    throw new Error(`Failed to get balloon: ${(e as Error).message}`);
  }
}

export async function pairBalloons() {
  const pendingBalloons = await balloon_model
    .find({ status: 'pending' })
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
  const balloons = await balloon_model.find({
    status: { $in: ['paired', 'accepted'] }
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

      console.log(`⏳ Balloon ${balloon._id} expired and reset.`);
    }
  }
}

export async function removeExpiredBalloons() {
  const expirationDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 3); // 3 days

  const balloons = await balloon_model.find({
    lastActivityAt: { $lt: expirationDate }
  });

  await Promise.all(
    balloons.map(async (balloon) => {
      // Remove the balloon
      await Promise.all([
        deleteBalloonS3(balloon as any as Balloon),
        balloon_model.findByIdAndDelete(balloon._id),
        user_model.updateOne(
          { _id: balloon.sender },
          { $set: { 'balloon.sent': null } }
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

          console.log(`🔄 Paired balloon ${otherBalloon._id} set to pending`);
        }
      }

      trackEvent(balloon.sender.toString(), mixpanelEvents.balloon_expired);
      console.log(`⏳ Balloon ${balloon._id} expired`);
    })
  );
}


export async function sendMateRequest(params: SendMateRequestParams): Promise<void> {
  try {
    await Promise.all([
      user_model.updateOne(
        { _id: params.sender },
        { $addToSet: { mate_requests_sent: { $each: [params.receiver] } } }
      ),
      user_model.updateOne(
        { _id: params.receiver },
        { $addToSet: { mate_requests_received: { $each: [params.sender] } } }
      )
    ]);
  } catch (e) {
    console.error('Error sending mate request:', e); // Log error for debugging
    throw new Error('Failed to send mate request'); // Throw user-friendly error
  }
}

export async function cancelSendMateRequest(params: SendMateRequestParams): Promise<void> {
  try {
    await Promise.all([
      user_model.updateOne(
        { _id: params.sender },
        { $pull: { mate_requests_sent: params.receiver } }
      ),
      user_model.updateOne(
        { _id: params.receiver },
        { $pull: { mate_requests_received: params.sender } }
      )
    ]);
  } catch (e) {
    console.error('Error canceling mate request:', e);
    throw new Error('Failed to cancel mate request');
  }
}

// the sender is the one cancelling the friendship request
// the receiver is the one that originally send the request
export async function refuseSendMateRequest(params: SendMateRequestParams): Promise<void> {
  try {
    await Promise.all([
      user_model.updateOne(
        { _id: params.sender },
        { $pull: { mate_requests_received: params.receiver } }
      ),
      user_model.updateOne(
        { _id: params.receiver },
        { $pull: { mate_requests_sent: params.sender } }
      )
    ]);
  } catch (e) {
    console.error('Error canceling mate request:', e);
    throw new Error('Failed to cancel mate request');
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


export async function getPartialUsers(user_ids: string[]): Promise<Mate[]> {
  try {
    return await user_model
      .find({
        _id: { $in: user_ids }
      }, { _id: 1, img: 1, name: 1 })
      .lean();
  } catch (e: any) {
    throw new Error(e);
  }
}

export async function searchMate(
  mateName: string,
  userId: string,
  limit = 10
): Promise<Mate[]> {
  try {
    return await user_model
      .find(
        {
          _id: { $ne: userId },
          name: { $regex: `^${mateName}`, $options: 'i' }    // starts with search (case-insensitive)
        },
        { _id: 1, img: 1, name: 1 }
      )
      .limit(limit)
      .lean();
  } catch (e: any) {
    throw new Error(e.message || e);
  }
}

export async function addLastActivityToBalloons() {
  const now = new Date();

  const result = await balloon_model.updateMany(
    { lastActivityAt: { $exists: false } }, // only add if it doesn't exist
    { $set: { lastActivityAt: now } }
  );

  console.log(`✅ Updated ${result.modifiedCount} balloons with lastActivityAt`);
}



