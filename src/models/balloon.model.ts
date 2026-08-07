import mongoose, { Schema } from 'mongoose';
import { BalloonDocument } from '../types/mongoose.types';

const { ObjectId } = Schema.Types;

const moderationSubSchema = new Schema({
  quarantined_at: { type: Date },
  removed_at:     { type: Date },
  last_report_at: { type: Date },
  last_report_reason: { type: String }
}, { _id: false });

const balloon_schema = new Schema<BalloonDocument>(
  {
    sender: { type: ObjectId, ref: 'users', required: true },
    message: { type: String, default: '' },
    // Censored twin — see services/profanity.service.
    message_filtered: { type: String, required: false },
    drawingJsonUrl: { type: String, required: true },
    img: { type: String, required: true },
    thumbnail: { type: String, required: true },
    aspect_ratio: { type: Number, required: true },

    // LIFECYCLE status — pending, paired with another balloon, or accepted by a recipient
    status: {
      type: String,
      enum: ['pending', 'paired', 'accepted'],
      default: 'pending'
    },

    // --- MODERATION ---
    // Separate from lifecycle status. Balloons get auto-hidden on the first
    // report (REPORTABLE.balloon.auto_hide = true), so this field changes
    // independently of the matching lifecycle.
    //
    // The routing layer (routeBalloonToOnlineUser, etc.) should refuse to
    // surface any balloon where moderation_status !== 'active'.
    moderation_status: {
      type: String,
      enum: ['active', 'under_review', 'removed'],
      default: 'active'
    },
    reports_count: { type: Number, default: 0 },
    moderation: { type: moderationSubSchema, default: () => ({}) },

    createdAt: { type: Date, default: Date.now },
    matchedAt: { type: Date, default: Date.now, required: false },
    lastActivityAt: { type: Date, default: Date.now },

    pairedUser: { type: ObjectId, ref: 'users', default: null, required: false },
    pairedBalloon: { type: ObjectId, ref: 'balloon', default: null, required: false },

    cancelledBalloons: [
      { type: ObjectId, ref: 'balloon', default: [] }
    ],
    version: { type: Number, default: 1 },
    rejected_by: [{ type: ObjectId, ref: 'users' }]
  },
  { collection: 'balloon' }
);

balloon_schema.index({ status: 1, lastActivityAt: -1 });
balloon_schema.index({ sender: 1 });

// --- MOD QUEUE INDEX ---
// Balloons hit auto-quarantine first, so the under_review queue is the busiest.
balloon_schema.index({ moderation_status: 1, 'moderation.quarantined_at': 1 });

export const balloon_model = mongoose.model<BalloonDocument>('balloon', balloon_schema);