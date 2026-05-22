import mongoose, { Schema } from 'mongoose';
import { Mate, NotificationSubscription, Saved } from '../types/types';
import { UserDocument } from '../types/mongoose.types';

const customizationSchema = new Schema({
  themeId: { type: String, default: 'classic' },
  fontId: { type: String, default: 'sketch' },
  fontEffectId: { type: String, default: '' },
  decorationId: { type: String, default: 'none' },
  effectId: { type: String, default: 'none' },
  titleId: { type: String, default: '' },
  signaturePath: { type: String, default: '' },
  signatureViewBox: { type: String, default: '' }
}, {
  _id: false,
  minimize: false
});

const statsSchema = new Schema({
  posts: { type: Number, default: 0 },
  followers: { type: Number, default: 0 },
  following: { type: Number, default: 0 },
  mates: { type: Number, default: 0 }
}, { _id: false });

// ---------------------------------------------------------------------------
// MODERATION SUB-SCHEMAS (Cleaned up - completely dropping database tracking)
// ---------------------------------------------------------------------------
const restrictionSchema = new Schema({
  level: { type: Number, default: 0 },                // 0..3 (matches modern STRIKE_LADDER)
  reason: { type: String },                           // last triggering ReportReason
  applied_at: { type: Date },
  expires_at: { type: Date }                          // null = until manual review
}, { _id: false });

const strikeSummarySchema = new Schema({
  active_strikes: { type: Number, default: 0 },       // non-decayed upheld reports
  total_strikes: { type: Number, default: 0 },        // lifetime, for analytics
  last_strike_at: { type: Date }
}, { _id: false });

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

const user_schema = new Schema<UserDocument>({
  auth_id: { type: String, required: true },
  name: { type: String, required: true },
  img: { type: String, required: true },
  description: { type: String, required: false },

  stats: { type: statsSchema, default: () => ({}) },
  customization: { type: customizationSchema, default: () => ({}) },

  restriction: { type: restrictionSchema, default: () => ({}) },
  strike_summary: { type: strikeSummarySchema, default: () => ({}) },

  mate_requests_received: { type: [String], default: [] },
  mate_requests_sent: { type: [String], default: [] },
  mates: [mateSchema],
  inbox: { type: [String], default: [] },

  balloon: {
    sent: { type: Schema.Types.ObjectId, ref: 'balloon', default: null },
    received: { type: Schema.Types.ObjectId, ref: 'balloon', default: null },
    disabled: { type: Boolean, default: false },
    last_received_at: { type: Date, default: null }
  },

  date_of_birth: { type: Date, required: false },
  last_seen_version: { type: String, required: false },
  subscriptions: { type: [notificationSchema], default: [] },

  stickers: { type: [String], default: [] },
  emblems: { type: [String], default: [] },
  saved: { type: [savedSchema], default: [] },
  last_name_change: { type: Date, default: null },
  subscription_tier: { type: String, default: 'free' },
  migration_version: { type: Number, default: 0 },
  is_admin: { type: Boolean, required: false }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

user_schema.index({ auth_id: 1 });
user_schema.index({ 'balloon.sent': 1 });
user_schema.index({ 'balloon.received': 1 });
user_schema.index({ name: 'text' });
user_schema.index({ migration_version: 1 });
user_schema.index({ 'restriction.level': 1, 'restriction.expires_at': 1 });
user_schema.index({ 'strike_summary.active_strikes': -1 });

export const user_model = mongoose.model<UserDocument>('users', user_schema);