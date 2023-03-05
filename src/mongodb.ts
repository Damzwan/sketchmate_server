import {
  CreateUserRes,
  GetUserParams,
  InboxItem,
  MatchParams,
  Res,
  SendParams,
  SubscribeParams,
  UnMatchParams,
  User,
} from './types';
import { BlobCreator } from './blob';
import mongoose, { Model } from 'mongoose';
import { user_model } from './models/user';
import { PushSubscription } from 'web-push';

let userModel: Model<User>;
let blobCreator: BlobCreator;

export async function connectDb(): Promise<void> {
  try {
    const url = process.env.mongo;
    if (!url) throw Error('No url available');
    await mongoose.connect(url);
    console.log('Connected to database 👻');
    userModel = user_model;
    blobCreator = new BlobCreator();
  } catch (e) {
    console.log(e);
  }
}

export async function createUser(): Promise<Res<CreateUserRes>> {
  try {
    const res = await userModel.create({ inbox: [] });
    return { _id: res._id };
  } catch (e) {
    throw new Error('Something went wrong creating a user');
  }
}

export async function getUser(params: GetUserParams): Promise<Res<User>> {
  try {
    const user = await userModel.findById(params._id).lean();
    if (user) return user;
    else throw new Error();
  } catch (e) {
    throw new Error('User not found');
  }
}

export async function getDrawings(params: GetUserParams): Promise<Res<InboxItem[]>> {
  try {
    const user = await userModel.findById(params._id, { inbox: 1 }).lean();
    if (user) return user.inbox;
    else throw new Error();
  } catch (e) {
    throw new Error('User not found');
  }
}

export async function getUserSubscription(params: GetUserParams): Promise<Res<PushSubscription>> {
  try {
    const user = await userModel.findById(params._id, { subscription: 1 }).lean();
    if (user) return user.subscription;
    else throw new Error();
  } catch (e) {
    throw new Error('User not found');
  }
}

export async function connectWithMate(params: MatchParams): Promise<Res<void>> {
  try {
    if (params._id === params.mate) throw new Error();
    const [user, mate] = await Promise.all([
      userModel.findById(params._id).lean(),
      userModel.findById(params.mate).lean(),
    ]);
    if (!(user && mate && !user.mate && !mate.mate)) throw new Error();
    await Promise.all([
      userModel.updateOne({ _id: params._id }, { $set: { mate: params.mate } }),
      userModel.updateOne({ _id: params.mate }, { $set: { mate: params._id } }),
    ]);
  } catch (e) {
    throw new Error('Cannot match with mate');
  }
}

export async function send(params: SendParams): Promise<Res<InboxItem>> {
  try {
    const [blobUrl, imgUrl] = await Promise.all([
      blobCreator.upload(params.drawing),
      blobCreator.uploadImg(params.img),
    ]);
    const date = new Date();
    const inboxItem: InboxItem = { drawing: blobUrl, date: date, sender: params._id, img: imgUrl };

    await Promise.all([
      userModel.updateOne({ _id: params.mate }, { $push: { inbox: inboxItem } }),
      userModel.updateOne({ _id: params._id }, { $push: { inbox: inboxItem } }),
    ]);
    return inboxItem;
  } catch (e) {
    throw new Error('Failed sending to mate');
  }
}

export async function unMatch(params: UnMatchParams): Promise<Res<void>> {
  try {
    await Promise.all([
      userModel.updateOne({ _id: params._id }, { $unset: { mate: 1 }, $set: { inbox: [] } }),
      userModel.updateOne({ _id: params.mate }, { $unset: { mate: 1 }, $set: { inbox: [] } }),
    ]);
  } catch (e) {
    throw new Error('Failed to unmatch');
  }
}

export async function subscribe(params: SubscribeParams): Promise<Res<void>> {
  try {
    await userModel.updateOne({ _id: params._id }, { $set: { subscription: params.subscription } });
  } catch (e) {
    throw new Error('Failed to subscribe');
  }
}

export async function unsubscribe(params: GetUserParams): Promise<Res<void>> {
  try {
    await userModel.updateOne({ _id: params._id }, { $unset: { subscription: 1 } });
  } catch (e) {
    throw new Error('Failed to unsubscribe');
  }
}
