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
import {
  UserDocument,
  InboxDocument,
  BalloonDocument,
  InboxCommentDocument
} from './types/mongoose.types';
import { CONTAINER, S3Creator } from './s3';
import mongoose, { Types } from 'mongoose';
import { user_model } from './models/user.model';
import { createThumbnail, escapeRegExp, imgToEmblem, removeBackground } from './helper';
import { inbox_model } from './models/inbox.model';
import * as fs from 'fs';
import { minimum_online_version, minimum_supported_version } from './main';
import { balloon_model } from './models/balloon.model';
import { mixpanelEvents, trackEvent } from './mixpanel';
import { PUBLIC_USER_FIELDS } from './types/projections';

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
      stickers: [],
      emblems: [],
      saved: [],
      name: 'Anonymous',
      img: s3Creator.getRandomStockProfileImg(),
      migration_version: 1,
      subscriptions: [],
      mates: [], // @deprecated
      inbox: [], // @deprecated
      mate_requests_sent: [], // @deprecated
      mate_requests_received: [] // @deprecated
    });

    if (user._id) trackEvent(user._id.toString(), mixpanelEvents.create_account);

    return {
      ...user.toObject(),
      _id: user._id.toString()
    } as unknown as User;
  } catch (e) {
    console.log(e);
  }
}

export async function getUser(params: GetUserParams): Promise<Res<GetUserRes>> {
  try {
    if (!params._id && !params.auth_id) return undefined;
    let user: UserDocument | null = null;

    user = await user_model.findOne({ auth_id: params.auth_id }).lean() as UserDocument | null;

    if (user) {
      return {
        user: { ...user, _id: user._id.toString() } as unknown as User,
        new_account: false,
        minimum_supported_version,
        minimum_online_version

      };
    }


    if (params._id) {
      user = await user_model.findById(params._id).lean() as UserDocument | null;
      if (user) {
        await user_model.updateOne({ _id: user._id }, { $set: { auth_id: params.auth_id } });
        return {
          user: { ...user, _id: user._id.toString(), auth_id: params.auth_id } as unknown as User,
          new_account: false,
          minimum_supported_version,
          minimum_online_version
        };
      }
    }


    const newUser = await createUser(params.auth_id);
    return { user: newUser!, new_account: true, minimum_supported_version, minimum_online_version };

  } catch (e) {
    throw new Error('User not found');
  }
}

export async function getInboxItems(params: GetInboxItemsParams): Promise<GetInboxRes> {
  try {
    const docs = await inbox_model
      .find({
        _id: { $in: params._ids }
      })
      .lean() as InboxDocument[];

    const inboxItems: InboxItem[] = docs.map(doc => ({
      ...doc,
      _id: doc._id.toString(),
      sender: doc.sender.toString(),
      date: doc.date.toISOString(),
      reply: doc.reply ? (doc.reply as any) : undefined // Maintain current reply logic
    })) as unknown as InboxItem[];

    const uniqueUserIds = Array.from(new Set(inboxItems.reduce((acc: string[], curr) => acc.concat(curr.original_followers), [])));
    const userInfo = await getPartialUsers(uniqueUserIds);

    return { inboxItems, userInfo };
  } catch (e) {
    throw new Error('Inbox item not found');
  }
}

export async function comment(params: CommentParams) {
  try {
    const commentId = new Types.ObjectId();
    const commentData: InboxCommentDocument = {
      date: new Date(),
      message: params.message,
      sender: params.sender
    };

    await inbox_model.updateOne(
      { _id: params.inbox_id },
      {
        $set: {
          comments_seen_by: [new Types.ObjectId(params.sender)]
        },
        $push: {
          comments: commentData
        }
      }
    );

    trackEvent(params.sender, mixpanelEvents.drawing_comment);

    return {
      ...commentData,
      _id: commentId.toString(),
      date: commentData.date.toISOString()
    } as Comment;
  } catch (e) {
    console.log(e);
    throw new Error('Cannot place comment');
  }
}

export async function removeFromInbox(params: RemoveFromInboxParams) {
  try {
    trackEvent(params.user_id, mixpanelEvents.drawing_deleted);

    const inboxItem = await inbox_model.findByIdAndUpdate(
      params.inbox_id,
      { $pull: { followers: params.user_id } },
      { new: true }
    ).lean() as InboxDocument | null;

    // Legacy support for user document inbox array
    await user_model.findByIdAndUpdate(
      params.user_id,
      { $pull: { inbox: params.inbox_id } }
    );

    if (inboxItem && inboxItem.followers.length === 0) {
      await Promise.all([
        s3Creator.deleteBlob(inboxItem.thumbnail, CONTAINER.drawings),
        s3Creator.deleteBlob(inboxItem.image, CONTAINER.drawings),
        s3Creator.deleteBlob(inboxItem.drawing, CONTAINER.drawings),
        inbox_model.deleteOne({ _id: params.inbox_id })
      ]);
    }
  } catch (e) {
    throw new Error('Cannot remove');
  }
}

export async function getUserSubscription(params: { _id: string }): Promise<Res<User>> {
  try {
    const user = await user_model.findById(params._id, {
      subscriptions: 1,
      mates: 1,
      _id: 1,
      img: 1
    }).lean() as UserDocument | null;
    if (!user) return undefined;
    return { ...user, _id: user._id.toString() } as unknown as User;
  } catch (e) {
    throw new Error('User not found');
  }
}

export async function match(params: MatchParams) {
  try {
    if (params._id === params.mate_id) throw new Error('Cannot match to oneself');

    const [user, mate] = await Promise.all([
      user_model.findById(params._id).lean() as Promise<UserDocument | null>,
      user_model.findById(params.mate_id).lean() as Promise<UserDocument | null>
    ]);

    if (!user || !mate) throw new Error('One of the users not found');

    // Legacy mate logic
    if (user.mates.some(m => m._id.toString() == mate._id.toString()) || mate.mates.some(m => m._id.toString() == user._id.toString()))
      throw new Error('Already matched');

    const newMatesForUser = [...user.mates, { _id: params.mate_id, name: mate.name, img: mate.img }];
    const newMatesForMate = [...mate.mates, { _id: user._id.toString(), name: user.name, img: user.img }];

    const filteredReceivedUser = user.mate_requests_received.filter(m => m.toString() != mate._id.toString());
    const filteredSentUser = user.mate_requests_sent.filter(m => m.toString() != mate._id.toString());

    const filteredReceivedMate = mate.mate_requests_received.filter(m => m.toString() != user._id.toString());
    const filteredSentMate = mate.mate_requests_sent.filter(m => m.toString() != user._id.toString());

    await Promise.all([
      user_model.updateOne(
        { _id: params._id },
        {
          $set: {
            mates: newMatesForUser,
            mate_requests_received: filteredReceivedUser,
            mate_requests_sent: filteredSentUser
          }
        }
      ),
      user_model.updateOne(
        { _id: params.mate_id },
        {
          $set: {
            mates: newMatesForMate,
            mate_requests_received: filteredReceivedMate,
            mate_requests_sent: filteredSentMate
          }
        }
      )
    ]);

    trackEvent(params._id, mixpanelEvents.match);

    return {
      user: { ...user, _id: user._id.toString() } as unknown as User,
      mate: { ...mate, _id: mate._id.toString() } as unknown as User
    };
  } catch (e) {
    throw new Error('Cannot match with mate');
  }
}

export async function storeMessage(params: SendParams): Promise<Res<InboxItem>> {
  try {
    const [blobUrl, imgUrl, thumbnailUrl] = await Promise.all([
      s3Creator.upload(params.drawing),
      s3Creator.uploadImg(params.img),
      s3Creator.uploadImg(await createThumbnail(params.img))
    ]);

    const date = new Date();
    const inboxItemId = new Types.ObjectId();

    const inboxItemData: Partial<InboxDocument> = {
      _id: inboxItemId,
      drawing: blobUrl,
      image: imgUrl,
      thumbnail: thumbnailUrl,
      date: date,
      sender: new Types.ObjectId(params._id),
      followers: params.followers,
      aspect_ratio: params.aspect_ratio,
      original_followers: params.followers,
      seen_by: [new Types.ObjectId(params._id)],
      comments_seen_by: [new Types.ObjectId(params._id)],
      comments: []
    };

    await Promise.all([
      inbox_model.create(inboxItemData),
      ...params.followers.map(follower => user_model.updateOne({ _id: follower }, { $push: { inbox: inboxItemId.toString() } }))
    ]);

    trackEvent(params._id, mixpanelEvents.drawing_sent);

    return {
      ...inboxItemData,
      _id: inboxItemId.toString(),
      sender: params._id,
      date: date.toISOString()
    } as unknown as InboxItem;
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
    await user_model.updateOne(
      { _id: params.user_id },
      {
        $pull: {
          subscriptions: { fingerprint: params.subscription.fingerprint }
        }
      }
    );
    await user_model.updateOne(
      { _id: params.user_id },
      {
        $push: { subscriptions: params.subscription }
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
          subscriptions: { fingerprint: params.fingerprint }
        }
      }
    );
  } catch (e) {
    throw new Error('Failed to unsubscribe');
  }
}

export async function onLoginEvent(params: OnLoginEventParams): Promise<any> {
  try {
    trackEvent(params.user_id, mixpanelEvents.login);

    const user = await user_model.findOneAndUpdate(
      { _id: params.user_id, 'subscriptions.fingerprint': params.fingerprint },
      { $set: { 'subscriptions.$.logged_in': params.loggedIn } },
      { new: true }
    ).lean() as UserDocument | null;

    return user ? { ...user, _id: user._id.toString() } : null;
  } catch (e) {
    throw new Error('Failed to update subscriptions');
  }
}

export async function changeUserName(params: ChangeUserNameParams): Promise<Res<void>> {
  try {
    const user = await user_model.findById(params._id).lean() as UserDocument | null;
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

    const user = await user_model.findById(params._id).lean() as UserDocument | null;
    if (!user) {
      fs.promises.unlink(params.img.filepath).catch(console.error);
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
    const user = await user_model.findById(user_id).lean() as UserDocument | null;
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
      $pull: { stickers: params.sticker_url }
    });
  } catch (e) {
    throw new Error('Failed to delete sticker');
  }
}

export async function deleteEmblem(params: DeleteEmblemParams): Promise<void> {
  try {
    await s3Creator.deleteBlob(params.emblem_url, CONTAINER.stickers);
    await user_model.findByIdAndUpdate(params.user_id, {
      $pull: { emblems: params.emblem_url }
    });
  } catch (e) {
    throw new Error('Failed to delete emblem');
  }
}

export async function deleteSaved(params: DeleteSavedParams): Promise<void> {
  try {
    const saved: Saved = { img: params.img_url, drawing: params.drawing_url };
    await Promise.all([
      s3Creator.deleteBlob(params.img_url, CONTAINER.stickers),
      s3Creator.deleteBlob(params.drawing_url, CONTAINER.stickers),
      user_model.findByIdAndUpdate(params.user_id, {
        $pull: { saved: saved }
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
        seen_by: new Types.ObjectId(params.user_id),
        comments_seen_by: new Types.ObjectId(params.user_id)
      }
    });
  } catch (e) {
    throw new Error(e as any);
  }
}

// @deprecated
export async function createBalloon(params: CreateBalloonPostParams): Promise<Res<Balloon>> {
  const alreadyExistingBalloon = await balloon_model.findOne({ sender: new Types.ObjectId(params.sender) });

  if (alreadyExistingBalloon) {
    throw new Error('Balloon already exists');
  }

  const [drawingJsonUrl, img, thumbnail] = await Promise.all([
    s3Creator.upload(params.drawing),
    s3Creator.uploadImg(params.img),
    s3Creator.uploadImg(await createThumbnail(params.img))
  ]);

  const balloonId = new Types.ObjectId();
  const balloonToCreate: Partial<BalloonDocument> = {
    _id: balloonId,
    status: 'pending',
    createdAt: new Date(),
    lastActivityAt: new Date(),
    drawingJsonUrl,
    img,
    thumbnail,
    aspect_ratio: params.aspect_ratio,
    sender: new Types.ObjectId(params.sender),
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

    return {
      ...balloonToCreate,
      _id: balloonId.toString(),
      sender: params.sender,
      createdAt: balloonToCreate.createdAt!.toISOString(),
      lastActivityAt: balloonToCreate.lastActivityAt!.toISOString()
    } as unknown as Balloon;
  } catch (e) {
    throw new Error(`Failed to create balloon: ${(e as Error).message}`);
  }
}

export async function getBalloon(balloonId: string): Promise<Balloon | null> {
  try {
    const doc = await balloon_model.findById(balloonId).lean() as BalloonDocument | null;
    if (!doc) return null;
    return {
      ...doc,
      _id: doc._id.toString(),
      sender: doc.sender.toString(),
      createdAt: doc.createdAt.toISOString(),
      lastActivityAt: doc.lastActivityAt.toISOString()
    } as unknown as Balloon;
  } catch (error) {
    throw new Error(`Failed to get balloon: ${(error as Error).message}`);
  }
}

export async function sendMateRequest(params: SendMateRequestParams): Promise<void> {
  try {
    await Promise.all([
      user_model.updateOne(
        { _id: params.sender },
        { $addToSet: { mate_requests_sent: new Types.ObjectId(params.receiver) } }
      ),
      user_model.updateOne(
        { _id: params.receiver },
        { $addToSet: { mate_requests_received: new Types.ObjectId(params.sender) } }
      )
    ]);
  } catch (e) {
    console.error('Error sending mate request:', e);
    throw new Error('Failed to send mate request');
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
    const docs = await user_model
      .find({
        _id: { $in: user_ids }
      }, { _id: 1, img: 1, name: 1, last_seen_version: 1 })
      .lean() as any[];

    return docs.map(doc => ({
      _id: doc._id.toString(),
      name: doc.name,
      img: doc.img,
      last_seen_version: doc.last_seen_version
    })) as Mate[];
  } catch (e: any) {
    throw new Error(e);
  }
}

export async function getPartialUser(user_id: string): Promise<Mate | null> {
  try {
    const doc = await user_model
      .findById(user_id, { _id: 1, img: 1, name: 1 })
      .lean() as UserDocument | null;

    if (!doc) return null;

    return {
      _id: doc._id.toString(),
      name: doc.name,
      img: doc.img
    } as Mate;
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
    const safeSearchTerm = escapeRegExp(mateName);

    const docs = await user_model
      .find({
        _id: { $ne: userId },
        name: { $regex: safeSearchTerm, $options: 'i' }
      })
      .select(PUBLIC_USER_FIELDS)
      .limit(limit)
      .lean() as any[];

    return docs.map(doc => ({
      ...doc,
      _id: doc._id.toString(),
    })) as Mate[];
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
    // SECURE & BACKWARDS COMPATIBLE: Exclude only quarantined/removed items.
    // Legacy items without a status field will be safely included.
    const query: any = {
      followers: params.user_id,
      status: { $nin: ['under_review', 'removed'] }
    };

    if (params.lastDate) {
      query.date = { $lt: params.lastDate };
    }

    const docs = await inbox_model
      .find(query)
      .sort({ date: -1 })
      .limit(params.limit)
      .lean() as InboxDocument[];

    const inboxItems: InboxItem[] = docs.map((doc: any) => {
      if (doc.comments && Array.isArray(doc.comments)) {
        doc.comments = doc.comments.filter((c: any) =>
          c.status !== 'under_review' && c.status !== 'removed'
        );
      }

      return {
        ...doc,
        _id: doc._id.toString(),
        sender: doc.sender.toString(),
        date: doc.date.toISOString()
      };
    }) as unknown as InboxItem[];

    const uniqueUserIds = Array.from(new Set(
      inboxItems.reduce((acc: string[], curr) => acc.concat(curr.original_followers), [])
    ));

    const userInfo = await getPartialUsers(uniqueUserIds);

    return { inboxItems, userInfo };
  } catch (e) {
    throw new Error('Failed to fetch inbox batch');
  }
}