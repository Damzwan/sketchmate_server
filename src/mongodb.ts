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
  GetUserParams,
  InboxItem,
  MatchParams,
  RemoveFromInboxParams,
  Res,
  Saved,
  SendParams,
  SubscribeParams,
  UnMatchParams,
  UploadProfileImgParams,
  User,
} from './types/types';
import { BlobCreator, CONTAINER } from './blob';
import mongoose from 'mongoose';
import { user_model } from './models/user.model';
import {
  compressImg,
  createThumbnail,
  dataUrlToBuffer,
  imgToEmblem,
  removeBackground,
  STICKER_SIZE,
  trimTransparentBackground,
} from './helper';
import { ObjectId } from 'mongodb';
import { inbox_model } from './models/inbox.model';
import * as fs from 'fs';
import axios from 'axios';

let blobCreator: BlobCreator;
const stock_img = 'https://sketchmate.blob.core.windows.net/account/aku.jpg';

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

export async function createUser(): Promise<Res<User>> {
  try {
    return await user_model.create({
      inbox: [],
      stickers: [],
      emblems: [],
      saved: [],
      name: 'anonymous',
      img: stock_img,
    });
  } catch (e) {
    throw new Error('Something went wrong creating a user');
  }
}

export async function getUser(params: GetUserParams): Promise<Res<User>> {
  try {
    return user_model.findById(params._id).lean();
  } catch (e) {
    throw new Error('User not found');
  }
}

export async function getInboxItems(params: GetInboxItemsParams): Promise<Res<InboxItem>> {
  try {
    return await inbox_model
      .find({
        _id: { $in: params._ids },
      })
      .lean();
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
      sender: params.sender,
    };
    await inbox_model.updateOne(
      {
        _id: params.inbox_id,
      },
      {
        $push: {
          comments: comment,
        },
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
      inbox_model.findByIdAndUpdate(params.inbox_id, { $pull: { followers: params.user_id } }, { new: true }),
      user_model.findByIdAndUpdate(params.user_id, {
        $pull: {
          inbox: params.inbox_id,
        },
      }),
    ]);

    if (inboxItem?.followers.length === 0) await inbox_model.deleteOne({ _id: params.inbox_id });
  } catch (e) {
    throw new Error('Cannot remove');
  }
}

export async function getUserSubscription(params: GetUserParams): Promise<Res<User>> {
  try {
    return await user_model.findById(params._id, { subscription: 1, mate: 1, _id: 1, img: 1 }).lean();
  } catch (e) {
    throw new Error('User not found');
  }
}

export async function match(params: MatchParams) {
  try {
    if (params._id === params.mate_id) throw new Error();
    const [user, mate] = await Promise.all([
      user_model.findById(params._id).lean(),
      user_model.findById(params.mate_id).lean(),
    ]);
    if (!(user && mate && !user.mate && !mate.mate)) throw new Error();

    user.mate = {
      _id: params.mate_id,
      name: mate.name,
      img: mate.img,
    };
    mate.mate = {
      _id: user._id,
      name: user.name,
      img: user.img,
    };
    await Promise.all([
      user_model.updateOne(
        { _id: params._id },
        {
          $set: {
            mate: user.mate,
          },
        }
      ),
      user_model.updateOne(
        { _id: params.mate_id },
        {
          $set: {
            mate: mate.mate,
          },
        }
      ),
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
      blobCreator.uploadImg(await createThumbnail(params.img)),
    ]);

    const date = new Date();
    const inboxItem: InboxItem = {
      _id: new ObjectId().toString(),
      drawing: blobUrl,
      image: imgUrl,
      thumbnail: thumbnailUrl,
      date: date,
      sender: params._id,
      followers: [params.mate_id, params._id],
      comments: [],
    };

    await Promise.all([
      inbox_model.create(inboxItem),
      user_model.updateOne({ _id: params.mate_id }, { $push: { inbox: inboxItem._id } }),
      user_model.updateOne({ _id: params._id }, { $push: { inbox: inboxItem._id } }),
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
      user_model.updateOne({ _id: params._id }, { $unset: { mate: 1 }, $set: { inbox: [] } }),
      user_model.updateOne({ _id: params.mate_id }, { $unset: { mate: 1 }, $set: { inbox: [] } }),
    ]);
  } catch (e) {
    throw new Error('Failed to unmatch');
  }
}

export async function subscribe(params: SubscribeParams): Promise<Res<void>> {
  try {
    await user_model.updateOne({ _id: params._id }, { $set: { subscription: params.subscription } });
  } catch (e) {
    throw new Error('Failed to subscribe');
  }
}

export async function unsubscribe(params: GetUserParams): Promise<Res<void>> {
  try {
    await user_model.updateOne({ _id: params._id }, { $unset: { subscription: 1 } });
  } catch (e) {
    throw new Error('Failed to unsubscribe');
  }
}

export async function changeUserName(params: ChangeUserNameParams): Promise<Res<void>> {
  try {
    const userUpdate = { $set: { name: params.name } };
    const mateUpdate = { $set: { 'mate.name': params.name } };

    await Promise.all([
      user_model.updateOne({ _id: params._id }, userUpdate),
      params.mate_id ? user_model.updateOne({ _id: params.mate_id }, mateUpdate) : null,
    ]);
  } catch (e) {
    throw new Error('Failed to change name');
  }
}

export async function uploadProfileImg(params: UploadProfileImgParams): Promise<Res<string>> {
  try {
    const url = await blobCreator.uploadFile(params.img.filepath, params.img.mimetype, CONTAINER.account);
    const userUpdate = { $set: { img: url } };
    const mateUpdate = { $set: { 'mate.img': url } };

    await Promise.all([
      user_model.updateOne({ _id: params._id }, userUpdate),
      params.mate_id ? user_model.updateOne({ _id: params.mate_id }, mateUpdate) : null,
    ]);

    if (params.previousImage) blobCreator.deleteBlob(params.previousImage, CONTAINER.account);
    fs.promises.unlink(params.img.filepath);
    return url;
  } catch (e) {
    throw new Error('Failed to change name');
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
      blobCreator.uploadFile(params.img.filepath, 'image/webp', CONTAINER.stickers),
    ]);
    const saved: Saved = {
      img: img_url!,
      drawing: drawing_url!,
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
        stickers: params.sticker_url,
      },
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
        emblems: params.emblem_url,
      },
    });
  } catch (e) {
    throw new Error('Failed to delete emblem');
  }
}

export async function deleteSaved(params: DeleteSavedParams): Promise<void> {
  try {
    const saved: Saved = {
      img: params.img_url,
      drawing: params.drawing_url,
    };
    await Promise.all([
      blobCreator.deleteBlob(params.img_url, CONTAINER.stickers),
      blobCreator.deleteBlob(params.drawing_url, CONTAINER.stickers),
      await user_model.findByIdAndUpdate(params.user_id, {
        $pull: {
          saved: saved,
        },
      }),
    ]);
  } catch (e) {
    throw new Error('Failed to delete sticker');
  }
}
