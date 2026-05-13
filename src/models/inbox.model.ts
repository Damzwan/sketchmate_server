import mongoose, { Schema } from 'mongoose';
import { InboxDocument, InboxCommentDocument } from '../types/mongoose.types';

const { ObjectId } = Schema.Types;

/**
 * COMMENT SCHEMA (Nested)
 */
const comment_schema = new Schema<InboxCommentDocument>({
  sender: { type: String, required: true },
  message: { type: String, required: true },
  date: { type: Date, required: true }
}, { _id: true }); // Keeping _id for nested comments is usually helpful for replies/reactions

/**
 * INBOX SCHEMA
 */
const inbox_schema = new Schema<InboxDocument>(
  {
    drawing: { type: String, required: true },
    followers: { type: [String], required: true },
    original_followers: { type: [String], required: true },
    seen_by: { type: [{ type: ObjectId, ref: 'users' }], required: true },
    comments_seen_by: { type: [{ type: ObjectId, ref: 'users' }], required: true },
    date: { type: Date, required: true },
    sender: { type: ObjectId, ref: 'users', required: true },
    image: { type: String, required: true },
    thumbnail: { type: String, required: true },
    aspect_ratio: { type: Number, required: false },
    reply: { type: ObjectId, ref: 'inbox', required: false },
    comments: { type: [comment_schema], required: false }
  },
  {
    collection: 'inbox',
    timestamps: false
  }
);

export const inbox_model = mongoose.model<InboxDocument>('inbox', inbox_schema);