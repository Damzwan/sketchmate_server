import mongoose, { Schema } from 'mongoose';
import { Mate, User } from '../types';
import { PushSubscription } from 'web-push';

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

const mateSchema = new Schema<Mate>({
  name: { type: String, required: true },
  img: { type: String, required: true },
});

const user_schema = new Schema({
  mate: mateSchema,
  inbox: { type: [String], required: true },
  subscription: { type: push_subscription },
  name: { type: String, required: true },
  img: { type: String, required: true },
}) as mongoose.Schema<User>;

export const user_model = mongoose.model('users', user_schema);
