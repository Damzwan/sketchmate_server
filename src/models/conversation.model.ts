import mongoose, { Schema } from 'mongoose';
import { AsDocument } from '../types/mongoose.types';
import { BaseConversation } from '../types/types';


const conversation_schema = new Schema({
  participants: [{ type: Schema.Types.ObjectId, ref: 'users', required: true, index: true }],
  status: { type: String, enum: ['active', 'pending', 'blocked'], default: 'active' },
  initiator_id: { type: Schema.Types.ObjectId, ref: 'users' },
  last_message: { type: Schema.Types.ObjectId, ref: 'messages' },
  unread_counts: { type: Map, of: Number, default: {} }
}, { timestamps: true });

export const conversation_model = mongoose.model<AsDocument<BaseConversation, 'participants' | 'initiator_id' | 'last_message'>>(
  'conversations',
  conversation_schema
);