import mongoose, { Schema, Types } from 'mongoose';
import { Comment, InboxItem } from '../types/types';
import { ObjectId } from 'mongodb';
import { mateSchema } from './user.model';

const comment_schema = new Schema<Comment>({
  sender: { type: String, required: true },
  message: { type: String, required: true },
  date: { type: Date, required: true },
});

const inbox_schema = new Schema<Omit<InboxItem, 'sender'> & { sender: ObjectId }>(
  {
    drawing: { type: String, required: true },
    followers: { type: [String], required: true },
    original_followers: { type: [String], required: true },
    seen_by: { type: [Types.ObjectId], required: true },
    comments_seen_by: { type: [Types.ObjectId], required: true },
    date: { type: Date, required: true },
    sender: { type: Types.ObjectId, required: true },
    image: { type: String, required: true },
    thumbnail: { type: String, required: true },
    aspect_ratio: { type: Number, required: true },
    reply: { type: Schema.Types.ObjectId, ref: 'InboxItem', required: false },
    comments: { type: [comment_schema], required: false },
  },
  { collection: 'inbox' }
);

export const inbox_model = mongoose.model('inbox', inbox_schema);
