import mongoose, { Schema } from 'mongoose';
import { Mate, NotificationSubscription, Saved, User } from '../types/types';

export const mateSchema = new Schema<Mate>({
  name: { type: String, required: true },
  img: { type: String, required: true }
});

const savedSchema = new Schema<Saved>({
  drawing: { type: String, required: true },
  img: { type: String, required: true }
});

export const notificationSchema = new Schema<NotificationSubscription>({
  token: { type: String, required: true },
  platform: { type: String, required: true },
  fingerprint: { type: String, required: true },
  model: { type: String, required: true },
  os: { type: String, required: true },
  logged_in: { type: Boolean, required: true },
});

const user_schema = new Schema({
  auth_id: { type: String, required: true },
  mates: [mateSchema],
  inbox: { type: [String], required: true },
  stickers: { type: [String], required: true },
  emblems: { type: [String], required: true },
  saved: { type: [savedSchema], required: true },
  subscriptions: { type: [notificationSchema], required: true },
  name: { type: String, required: true },
  img: { type: String, required: true },
  mate_requests_received: { type: [String], required: true },
  mate_requests_sent: { type: [String], required: true }
}) as mongoose.Schema<User>;

export const user_model = mongoose.model('users', user_schema);
