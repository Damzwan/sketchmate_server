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
    required: true
  },
  is_invite: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true,
  // Optimization for lean queries and toObject conversions
  toObject: { virtuals: true },
  toJSON: { virtuals: true }
});

MessageSchema.index({ conversation_id: 1, createdAt: -1 });

export const message_model = mongoose.model<MessageDocument>(
  'messages',
  MessageSchema
);