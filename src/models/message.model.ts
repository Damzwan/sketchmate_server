import mongoose, { Schema } from 'mongoose';
import { AsDocument } from '../types/mongoose.types';
import { BaseMessage } from '../types/types';

const MessageSchema = new Schema({
  conversation_id: { type: Schema.Types.ObjectId, ref: 'conversations', required: true },
  sender_id: { type: Schema.Types.ObjectId, ref: 'users', required: true },
  content: { type: String, required: true },
  is_invite: { type: Boolean, default: false }
}, { timestamps: true });

MessageSchema.index({ conversation_id: 1, createdAt: -1 });
export const message_model = mongoose.model<AsDocument<BaseMessage, 'conversation_id' | 'sender_id'>>(
  'messages',
  MessageSchema
);