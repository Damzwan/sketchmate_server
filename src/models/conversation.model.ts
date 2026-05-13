import mongoose, { Schema } from 'mongoose';
import { ConversationDocument } from '../types/mongoose.types';

const { ObjectId } = Schema.Types;

const conversation_schema = new Schema<ConversationDocument>({
  participants: [{
    type: ObjectId,
    ref: 'users',
    required: true
  }],
  last_message: {
    type: ObjectId,
    ref: 'messages'
  },
  unread_counts: {
    type: Map,
    of: Number,
    default: {}
  },
  deleted_at: { type: Date }
}, { timestamps: true });

conversation_schema.index({ 'participants.0': 1, 'participants.1': 1 }, { unique: true });
conversation_schema.index({ participants: 1, updatedAt: -1 });

// TTL cleanup
conversation_schema.index({ deleted_at: 1 }, { expireAfterSeconds: 0 });

export const conversation_model = mongoose.model<ConversationDocument>(
  'conversations',
  conversation_schema
);