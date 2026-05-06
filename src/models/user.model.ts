import mongoose, { Schema } from 'mongoose';
import { BasePost, Mate, NotificationSubscription, Saved, User } from '../types/types';
import { AsDocument } from '../types/mongoose.types';

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
  logged_in: { type: Boolean, required: true }
});

const user_schema = new Schema<AsDocument<User, 'friends' | 'blocked_users' | 'followers' | 'following'>>({
  auth_id: { type: String, required: true },
  name: { type: String, required: true },
  img: { type: String, required: true },
  description: { type: String, required: false },

  friends: [{ type: Schema.Types.ObjectId, ref: 'users', default: [] }],

  blocked_users: [{ type: Schema.Types.ObjectId, ref: 'users', default: [] }],

  following: [{ type: Schema.Types.ObjectId, ref: 'users', default: [] }],
  followers: [{ type: Schema.Types.ObjectId, ref: 'users', default: [] }],

  mate_requests_received: { type: [String], required: true },
  mate_requests_sent: { type: [String], required: true },

  balloon: {
    sent: { type: Schema.Types.ObjectId, default: null },
    received: { type: Schema.Types.ObjectId, default: null },
    disabled: { type: Boolean, default: false },
    last_received_at: { type: Date, default: null }
  },

  date_of_birth: { type: Date, required: false },
  last_seen_version: { type: String, required: false },

  subscriptions: { type: [notificationSchema], required: true },


  // --- Legacy
  inbox: { type: [String], required: true },
  mates: [mateSchema], // Keep your existing mateSchema here for compatibility

  // to change
  stickers: { type: [String], required: true },
  emblems: { type: [String], required: true },
  saved: { type: [savedSchema], required: true },

}, { timestamps: true });

export const user_model = mongoose.model<AsDocument<User, 'friends' | 'blocked_users' | 'followers' | 'following'>>(
  'users',
  user_schema
);
