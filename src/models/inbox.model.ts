import mongoose, { Schema } from 'mongoose';
import { Comment, InboxItem } from '../types/types';
import { ObjectId } from 'mongodb';

const comment_schema = new Schema<Comment>({
  sender: { type: String, required: true },
  message: { type: String, required: true },
  date: { type: Date, required: true },
});

const inbox_schema = new Schema<InboxItem>(
  {
    drawing: { type: String, required: true },
    followers: { type: [String], required: true },
    date: { type: Date, required: true },
    sender: { type: String, required: true },
    image: { type: String, required: true },
    thumbnail: { type: String, required: true },
    reply: { type: Schema.Types.ObjectId, ref: 'InboxItem', required: false },
    comments: { type: [comment_schema], required: false },
  },
  { collection: 'inbox' }
);

export const inbox_model = mongoose.model('inbox', inbox_schema);
