import {
  Balloon,
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
  UnMatchParams,
  UnRegisterNotificationParams,
  UpdateUserParams,
  UploadProfileImgParams,
  User
} from './types/types';
import { CONTAINER, S3Creator } from './s3';
import mongoose, { Schema } from 'mongoose';
import { user_model } from './models/user.model';
import { createThumbnail, imgToEmblem, removeBackground } from './helper';
import { ObjectId } from 'mongodb';
import { inbox_model } from './models/inbox.model';
import * as fs from 'fs';
import { minimum_supported_version } from './main';
import { balloon_model } from './models/balloon.model';
import { mixpanelEvents, trackEvent } from './mixpanel';

export let s3Creator: S3Creator;

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
      aspect_ratio: params.aspect_ratio,
      original_followers: params.followers,
      seen_by: [params._id],
      comments_seen_by: [params._id],
      comments: []
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
    const user = await user_model.findById(params._id).lean();
    if (!user) return;

    await user_model.updateOne({ _id: params._id }, { $set: { name: params.name } });

    if (user.mates && user.mates.length > 0) {
      const mateIds = user.mates.map(m => m._id);

      await user_model.updateMany(
        { _id: { $in: mateIds }, 'mates._id': params._id },
        { $set: { 'mates.$.name': params.name } }
      );
    }
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

    const user = await user_model.findById(params._id).lean();
    if (!user) {
      fs.promises.unlink(params.img.filepath).catch(console.error); // Clean up if user is missing!
      return;
    }

    await user_model.updateOne({ _id: params._id }, { $set: { img: url } });

    if (user.mates && user.mates.length > 0) {
      const mateIds = user.mates.map(m => m._id);

      await user_model.updateMany(
        { _id: { $in: mateIds }, 'mates._id': params._id },
        { $set: { 'mates.$.img': url } }
      );
    }

    if (params.previousImage && !params.previousImage.includes('stock')) {
      s3Creator.deleteBlob(params.previousImage, CONTAINER.account).catch(console.error);
    }
    fs.promises.unlink(params.img.filepath).catch(console.error);

    return url;
  } catch (e) {
    if (params.img?.filepath) fs.promises.unlink(params.img.filepath).catch(console.error);
    throw new Error('Failed to change profile image');
  }
}

export async function deleteProfileImg(user_id: string, stock_img: string) {
  try {
    const user = await user_model.findById(user_id).lean();
    if (!user) return;

    await user_model.updateOne({ _id: user_id }, { $set: { img: stock_img } });

    if (user.mates && user.mates.length > 0) {
      const mateIds = user.mates.map(m => m._id);

      await user_model.updateMany(
        { _id: { $in: mateIds }, 'mates._id': user_id },
        { $set: { 'mates.$.img': stock_img } }
      );
    }

    if (user.img && !user.img.includes('stock')) {
      s3Creator.deleteBlob(user.img, CONTAINER.account).catch(console.error);
    }
  } catch (e) {
    console.error('Failed to delete profile image:', e);
  }
}

export async function createSticker(params: CreateStickerParams): Promise<Res<string>> {
  try {
    const url = await s3Creator.uploadFile(params.img.filepath, 'image/webp', CONTAINER.stickers);
    const new_url: string = await removeBackground(url!);

    await user_model.updateOne({ _id: params._id }, { $push: { stickers: new_url } });

    fs.promises.unlink(params.img.filepath).catch(console.error);

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

    fs.promises.unlink(params.img.filepath).catch(console.error);

    return url;
  } catch (e) {
    throw new Error('Failed to create emblem');
  }
}

export async function createSaved(params: CreateSavedParams): Promise<Res<Saved>> {
  try {
    const [drawing_url, img_url] = await Promise.all([
      s3Creator.uploadFile(params.drawing.filepath, 'application/json', CONTAINER.stickers),
      s3Creator.uploadFile(params.img.filepath, 'image/webp', CONTAINER.stickers)
    ]);
    const saved: Saved = { img: img_url!, drawing: drawing_url! };
    await user_model.updateOne({ _id: params._id }, { $push: { saved: saved } });

    Promise.all([
      fs.promises.unlink(params.drawing.filepath).catch(console.error),
      fs.promises.unlink(params.img.filepath).catch(console.error)
    ]);

    return saved;
  } catch (e) {
    throw new Error('Failed to create saved');
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
    cancelledBalloons: [],
    version: params.version,
    rejected_by: []
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
    return await balloon_model.findById(balloonId).lean<Balloon | null>();
  } catch (error) {
    throw new Error(`Failed to get balloon: ${(error as Error).message}`);
  }
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

export async function getPartialUser(user_id: string): Promise<Res<Mate>> {
  try {
    return await user_model.findById(user_id, { _id: 1, img: 1, name: 1 }).lean();
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

export async function getInboxItemsV2(params: {
  user_id: string,
  limit: number,
  lastDate?: Date
}): Promise<GetInboxRes> {
  try {
    const query: any = { followers: params.user_id };

    if (params.lastDate) {
      query.date = { $lt: params.lastDate };
    }

    const inboxItems = await inbox_model
      .find(query)
      .sort({ date: -1 }) // Newest first
      .limit(params.limit)
      .lean() as any as InboxItem[];

    const uniqueUserIds = Array.from(new Set(
      inboxItems.reduce((acc: string[], curr) => acc.concat(curr.original_followers), [])
    ));

    const userInfo = await getPartialUsers(uniqueUserIds);

    return { inboxItems, userInfo };
  } catch (e) {
    throw new Error('Failed to fetch inbox batch');
  }
}

