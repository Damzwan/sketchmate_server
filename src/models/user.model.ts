import mongoose, { Schema } from 'mongoose';
import { Mate, NotificationSubscription, Saved, User } from '../types/types';
import { AsDocument } from '../types/mongoose.types';

/**
 * CUSTOMIZATION SCHEMA
 * Defined without defaults to allow for dynamic "Classic" fallbacks.
 * This object remains empty or undefined for users who haven't used the Studio.
 */
const customizationSchema = new Schema({
  // Selection IDs
  titleId: String,
  fontFamily: String,
  fontEffect: String,
  cardBg: String,

  // Custom Raw Values
  cardBgColor: String,
  nameColor: String,
  descColor: String,
  avatarBorderColor: String,
  cardBorderColor: String,

  // Signature Data
  signatureColor: String,
  signaturePath: String,
  signatureViewBox: String,

  // Inventory tracking for Pro/Individual purchases
  unlocked_items: { type: [String], default: [] }
}, {
  _id: false,
  minimize: true // Ensures empty objects are not saved to the DB
});

/**
 * LEGACY / SUPPORTING SCHEMAS
 */
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

/**
 * MAIN USER SCHEMA
 */
const user_schema = new Schema<AsDocument<User, 'friends' | 'blocked_users' | 'followers' | 'following'>>({
  auth_id: { type: String, required: true, index: true },
  name: { type: String, required: true },
  img: { type: String, required: true },
  description: { type: String, required: false },

  // The Customization Engine (Lean Implementation)
  customization: {
    type: customizationSchema,
    required: false
  },

  // Social Graphs
  friends: [{ type: Schema.Types.ObjectId, ref: 'users', default: [] }],
  blocked_users: [{ type: Schema.Types.ObjectId, ref: 'users', default: [] }],
  following: [{ type: Schema.Types.ObjectId, ref: 'users', default: [] }],
  followers: [{ type: Schema.Types.ObjectId, ref: 'users', default: [] }],

  // Communication & Interaction
  mate_requests_received: { type: [String], default: [] },
  mate_requests_sent: { type: [String], default: [] },

  balloon: {
    sent: { type: Schema.Types.ObjectId, default: null },
    received: { type: Schema.Types.ObjectId, default: null },
    disabled: { type: Boolean, default: false },
    last_received_at: { type: Date, default: null }
  },

  // Account Metadata
  date_of_birth: { type: Date, required: false },
  last_seen_version: { type: String, required: false },
  subscriptions: { type: [notificationSchema], default: [] },

  // Inventory & Assets
  inbox: { type: [String], default: [] },
  mates: [mateSchema],
  stickers: { type: [String], default: [] },
  emblems: { type: [String], default: [] },
  saved: { type: [savedSchema], default: [] },
  last_name_change: { type: Date, default: null },
  subscription_tier: { type: String, default: 'free' },

}, { timestamps: true });

// Indexing for high-performance search
user_schema.index({ name: 'text' });

export const user_model = mongoose.model<AsDocument<User, 'friends' | 'blocked_users' | 'followers' | 'following'>>(
  'users',
  user_schema
);