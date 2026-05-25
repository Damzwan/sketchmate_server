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

const engagementMetadataSchema = new Schema({
  last_thought_prompt_at: { type: Date, default: null },
  total_thought_prompts_shown: { type: Number, default: 0 },
  tasks_completed_since_last_prompt: { type: Number, default: 0 },
  feedback_opted_out: { type: Boolean, default: false }
}, { _id: false });

const statsSchema = new Schema({
  posts: { type: Number, default: 0 },
  followers: { type: Number, default: 0 },
  following: { type: Number, default: 0 },
  mates: { type: Number, default: 0 }
}, { _id: false });

// ---------------------------------------------------------------------------
// MODERATION SUB-SCHEMAS
// ---------------------------------------------------------------------------
const restrictionSchema = new Schema({
  level: { type: Number, default: 0 },
  reason: { type: String },
  applied_at: { type: Date },
  expires_at: { type: Date }
}, { _id: false });

const strikeSummarySchema = new Schema({
  active_strikes: { type: Number, default: 0 },
  total_strikes: { type: Number, default: 0 },
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
  logged_in: { type: Boolean, required: true },
  updated_at: { type: Date, required: false }
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
  engagement_metadata: { type: engagementMetadataSchema, default: () => ({}) },

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
  is_admin: { type: Boolean, required: false },
  inventory: { type: [String], default: [] }
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
user_schema.index(
  { _id: 1, 'subscriptions.fingerprint': 1 },
  { unique: false }
);
// Sparse index — only users who have purchased anything appear here. Used by
// the admin "give me users who own X" query and by analytics.
user_schema.index({ inventory: 1 }, { sparse: true });

export const user_model = mongoose.model<UserDocument>('users', user_schema);