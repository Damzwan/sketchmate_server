import mongoose, { Schema } from 'mongoose';
import { InboxDocument, InboxCommentDocument } from '../types/mongoose.types';

const { ObjectId } = Schema.Types;

const moderationSubSchema = new Schema({
  quarantined_at: { type: Date },
  removed_at: { type: Date },
  last_report_at: { type: Date },
  last_report_reason: { type: String }
}, { _id: false });

/**
 * COMMENT SCHEMA (Nested)
 */
const comment_schema = new Schema<any>({
  sender: { type: String, required: true },
  message: { type: String, required: true },
  date: { type: Date, required: true },

  // Inbox comments are reportable but lightweight — no separate collection,
  // so the moderation state lives inline. Status doubles as a flag for the
  // frontend ("[removed by moderation]") and a filter for queries.
  status: {
    type: String,
    enum: ['active', 'removed'],
    default: 'active'
  },
  reports_count: { type: Number, default: 0 }
}, { _id: true });


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
    comments: { type: [comment_schema], required: false },
    comments_migrated: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ['active', 'under_review', 'removed'],
      default: 'active'
    },
    reports_count: { type: Number, default: 0 },
    moderation: { type: moderationSubSchema, default: () => ({}) }
  },
  {
    collection: 'inbox',
    timestamps: false
  }
);

// --- INDEXES ---
// Existing queries filter by `followers` (recipient lookup). Status filter
// should be applied client-side or via a compound index when fetching inbox.
inbox_schema.index({ followers: 1, date: -1 });          // primary read path
inbox_schema.index({ status: 1, 'moderation.quarantined_at': 1 });  // mod queue

export const inbox_model = mongoose.model<InboxDocument>('inbox', inbox_schema);