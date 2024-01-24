import {
  ChangeUserNameParams,
  Comment,
  CommentParams,
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
  UploadProfileImgParams,
  User
} from './types/types';
import { BlobCreator, CONTAINER } from './blob';
import mongoose, { Types } from 'mongoose';
import { user_model } from './models/user.model';
import { createThumbnail, getRandomStockAvatar, imgToEmblem, removeBackground } from './helper';
import { ObjectId } from 'mongodb';
import { inbox_model } from './models/inbox.model';
import * as fs from 'fs';
import { minimum_supported_version } from './main';

let blobCreator: BlobCreator;

export async function connectDb(): Promise<void> {
  try {
    const url = process.env.mongo;
    if (!url) throw Error('No url available');
    await mongoose.connect(url, { dbName: 'test' });
    console.log('Connected to database 👻');
    blobCreator = new BlobCreator();
  } catch (e) {
    console.log(e);
  }
}

export async function createUser(auth_id: string): Promise<Res<User>> {
  try {
    return await user_model.create({
      auth_id,
      inbox: [],
      stickers: [],
      emblems: [],
      saved: [],
      name: 'Anonymous',
      img: getRandomStockAvatar(),
      mates: [],
      mate_requests_sent: [],
      mate_requests_received: [],
      notifications: []
    });
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
      .lean() as InboxItem[];
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
    return comment;
  } catch (e) {
    console.log(e);
    throw new Error('Cannot place comment');
  }
}

export async function removeFromInbox(params: RemoveFromInboxParams) {
  try {
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
      await Promise.all([blobCreator.deleteBlob(inboxItem.thumbnail, CONTAINER.drawings), blobCreator.deleteBlob(inboxItem.image, CONTAINER.drawings), blobCreator.deleteBlob(inboxItem.drawing, CONTAINER.drawings), inbox_model.deleteOne({ _id: params.inbox_id })]);
    }
  } catch (e) {
    throw new Error('Cannot remove');
  }
}


export async function getUserSubscription(params: { _id: string }): Promise<Res<User>> {
  try {
    return await user_model.findById(params._id, { subscriptions: 1, mate: 1, _id: 1, img: 1 }).lean();
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
    return { user: user, mate: mate };
  } catch (e) {
    throw new Error('Cannot match with mate');
  }
}

export async function storeMessage(params: SendParams): Promise<Res<InboxItem>> {
  try {
    // const imgBuffer = dataUrlToBuffer(params.img);

    const [blobUrl, imgUrl, thumbnailUrl] = await Promise.all([
      blobCreator.upload(params.drawing),
      blobCreator.uploadImg(params.img),
      blobCreator.uploadImg(await createThumbnail(params.img))
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
  } catch (e) {
    throw new Error('Failed to unmatch');
  }
}


export async function subscribe(params: RegisterNotificationParams): Promise<Res<void>> {
  try {
    await user_model.updateOne(
      { _id: params.user_id },
      {
        $addToSet: {
          subscriptions: {
            $each: [params.subscription],
            $sort: { fingerprint: 1 }  // Ensure consistent ordering for uniqueness checks
          }
        }
      }
    );
  } catch (e) {
    throw new Error('Failed to subscribe');
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

export async function uploadProfileImg(params: UploadProfileImgParams): Promise<Res<string>> {
  try {
    const url = await blobCreator.uploadFile(params.img.filepath, params.img.mimetype, CONTAINER.account);

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
      blobCreator.deleteBlob(params.previousImage, CONTAINER.account);
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

    if (user && !user.img.includes('stock')) blobCreator.deleteBlob(user.img, CONTAINER.account);
  } catch (e) {
    console.log(e);
  }
}

export async function createSticker(params: CreateStickerParams): Promise<Res<string>> {
  try {
    const url = await blobCreator.uploadFile(params.img.filepath, 'image/webp', CONTAINER.stickers);
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
    const url = await blobCreator.uploadImg(img, CONTAINER.stickers);
    await user_model.updateOne({ _id: params._id }, { $push: { emblems: url } });
    return url;
  } catch (e) {
    throw new Error('Failed to create sticker');
  }
}

export async function createSaved(params: CreateSavedParams): Promise<Res<Saved>> {
  try {
    const [drawing_url, img_url] = await Promise.all([
      blobCreator.uploadFile(params.drawing.filepath, 'application/json', CONTAINER.stickers),
      blobCreator.uploadFile(params.img.filepath, 'image/webp', CONTAINER.stickers)
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
    await blobCreator.deleteBlob(params.sticker_url, CONTAINER.stickers);
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
    await blobCreator.deleteBlob(params.emblem_url, CONTAINER.stickers);
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
      blobCreator.deleteBlob(params.img_url, CONTAINER.stickers),
      blobCreator.deleteBlob(params.drawing_url, CONTAINER.stickers),
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


