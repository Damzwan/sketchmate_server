import mongoose, { Schema } from 'mongoose';
import { RelationshipDocument } from '../types/mongoose.types';

const { ObjectId } = Schema.Types;

const relationship_schema = new Schema<RelationshipDocument>({
  // Strictly inferred from RelationshipDocument
  users: [{
    type: ObjectId,
    ref: 'users',
    required: true
  }],

  chat_status: {
    type: String,
    enum: ['none', 'pending_invite', 'temporary', 'expired', 'pending_mate', 'mate', 'blocked'],
    default: 'none',
    index: true
  },

  conversation_id: { type: ObjectId, ref: 'conversations' },
  action_user_id: { type: ObjectId, ref: 'users' },

  follows: [{
    follower: { type: ObjectId, ref: 'users', required: true },
    followed: { type: ObjectId, ref: 'users', required: true }
  }],

  expires_at: { type: Date },
  cooldown_until: { type: Date },
  deleted_at: { type: Date }
}, { timestamps: true });

relationship_schema.index({ 'users.0': 1, 'users.1': 1 }, { unique: true });
relationship_schema.index({ users: 1, chat_status: 1 });
relationship_schema.index({ 'follows.follower': 1 });
relationship_schema.index({ 'follows.followed': 1 });

// 4. TTL Index
relationship_schema.index({ deleted_at: 1 }, { expireAfterSeconds: 0 });

export const relationship_model = mongoose.model<RelationshipDocument>(
  'relationships',
  relationship_schema
);