import mongoose, { Schema } from 'mongoose';
import { AsDocument } from '../types/mongoose.types';
import { BaseConversation } from '../types/types';

const conversation_schema = new Schema({
  participants: [{ type: Schema.Types.ObjectId, ref: 'users', required: true }],
  status: {
    type: String,
    enum: ['active', 'pending', 'temporary', 'blocked', 'mate_pending', 'expired'],
    default: 'active',
    index: true
  },
  initiator_id: { type: Schema.Types.ObjectId, ref: 'users' },
  last_message: { type: Schema.Types.ObjectId, ref: 'messages' },
  unread_counts: { type: Map, of: Number, default: {} },
  trial_expires_at: { type: Date },
  cooldown_until: { type: Date }, // For the 48h re-match lock
  deleted_at: { type: Date }      // For the 30-day auto-delete (TTL)
}, { timestamps: true });

// INDEXES
// Optimized for finding user-specific chat types (Online Status/Lobby)
conversation_schema.index({ participants: 1, status: 1 });
// Optimized for the Chat Overview list
conversation_schema.index({ participants: 1, updatedAt: -1 });
// TTL INDEX: Auto-delete document when deleted_at timestamp is reached
conversation_schema.index({ deleted_at: 1 }, { expireAfterSeconds: 0 });

export const conversation_model = mongoose.model<AsDocument<BaseConversation, 'participants' | 'initiator_id' | 'last_message'>>(
  'conversations',
  conversation_schema
);