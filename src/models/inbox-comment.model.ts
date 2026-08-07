import mongoose, { Schema } from 'mongoose';
import { InboxCommentDocumentV2 } from '../types/mongoose.types';

const { ObjectId } = Schema.Types;

const inbox_comment_schema = new Schema<InboxCommentDocumentV2>({
  inbox_id: { type: ObjectId, ref: 'inbox', required: true },
  sender:   { type: ObjectId, required: true },
  message:  { type: String, required: true },
  // Censored twin — see services/profanity.service.
  message_filtered: { type: String, required: false },
  date:     { type: Date, required: true, default: Date.now },
  status:   { type: String, enum: ['active', 'removed'], default: 'active' },
  reports_count: { type: Number, default: 0 }
}, { collection: 'inbox_comments', timestamps: false });

// powers both the cursor pagination and the gallery preview aggregate
inbox_comment_schema.index({ inbox_id: 1, status: 1, date: -1 });

export const inbox_comment_model =
  mongoose.model<InboxCommentDocumentV2>('inbox_comments', inbox_comment_schema);