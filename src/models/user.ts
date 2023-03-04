import mongoose, { Schema } from 'mongoose';
import { InboxItem, User } from '../types';
import { ObjectId } from 'mongodb';
import { PushSubscription } from 'web-push';

const inbox_schema = new Schema<InboxItem>(
  {
    drawing: { type: String, required: true },
    date: { type: Date, required: true },
    sender: { type: ObjectId, required: true },
    img: { type: String, required: true },
  },
  { _id: false }
);

const push_subscription = new Schema<PushSubscription>(
  {
    endpoint: { type: String, required: true },
    keys: {
      auth: { type: String, required: true },
      p256dh: { type: String, required: true },
    },
  },
  { _id: false }
);

const user_schema = new Schema({
  mate: { type: ObjectId, required: false },
  inbox: { type: [inbox_schema], required: true },
  subscription: { type: push_subscription },
}) as mongoose.Schema<User>;

export const user_model = mongoose.model('users', user_schema);
