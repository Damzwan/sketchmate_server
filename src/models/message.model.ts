import mongoose, { Schema } from 'mongoose';
import { MessageDocument } from '../types/mongoose.types';

const MessageSchema = new Schema<MessageDocument>({
  conversation_id: {
    type: Schema.Types.ObjectId,
    ref: 'conversations',
    required: true,
    index: true
  },
  sender_id: {
    type: Schema.Types.ObjectId,
    ref: 'users',
    required: true
  },
  content: {
    type: String,
    default: ''
  },
  // Censored twin of `content`, written once at send time and only when the
  // text actually matched. Recipients with the profanity filter on render this
  // instead; the original is never rewritten. See services/profanity.service.
  content_filtered: {
    type: String,
    required: false
  },
  // Moderation writes 'removed' here (moderation.service removeContent /
  // quarantineContent). Without the path declared, mongoose's strict mode
  // silently DROPPED that $set — a removed DM stayed visible.
  moderation_status: {
    type: String,
    enum: ['active', 'under_review', 'removed'],
    default: 'active'
  },
  is_invite: {
    type: Boolean,
    default: false
  },
  shared_post_id: {
    type: Schema.Types.ObjectId,
    ref: 'posts',
    default: null,
    index: true
  },
  shared_inbox_item_id: {
    type: Schema.Types.ObjectId,
    ref: 'inbox',
    default: null,
    index: true
  },
  type: {
    type: String,
    enum: ['user', 'system'],
    default: 'user'
  },
  system_kind: {
    type: String,
    enum: ['balloon_match'],
    required: false
  },
  system_payload: {
    type: Schema.Types.Mixed,
    required: false
  }

}, {
  timestamps: true,
  toObject: { virtuals: true },
  toJSON: { virtuals: true }
});

MessageSchema.index({ conversation_id: 1, createdAt: -1 });

export const message_model = mongoose.model<MessageDocument>(
  'messages',
  MessageSchema
);