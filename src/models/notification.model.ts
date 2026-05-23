import { Schema, model } from 'mongoose';
import { NotificationDocument } from '../types/mongoose.types';

const notification_actor_schema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    img: { type: String, required: true }
  },
  { _id: false }
);

const notification_target_preview_schema = new Schema(
  {
    thumbnail: { type: String },
    text: { type: String }
  },
  { _id: false }
);

const notification_schema = new Schema<NotificationDocument>(
  {
    recipient_id: {
      type: Schema.Types.ObjectId,
      ref: 'user',
      required: true
    },
    type: {
      type: String,
      required: true,
      enum: [
        'post_reaction',
        'post_comment',
        'inbox_drawing',
        'inbox_comment',
        'dm_message',
        'follow',
        'moderation_strike',
        'moderation_lifted',
        'announcement'
      ]
    },

    aggregation_key: { type: String },

    actors: { type: [notification_actor_schema], default: [] },
    actor_count: { type: Number, default: 0 },

    target_type: {
      type: String,
      enum: ['post', 'inbox_item', 'comment', 'user', 'system']
    },
    target_id: { type: Schema.Types.ObjectId },
    target_preview: { type: notification_target_preview_schema },

    read: { type: Boolean, default: false },
    seen: { type: Boolean, default: false },

    payload: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

// Feed query — paginated by updatedAt so aggregated entries bubble back up
notification_schema.index({ recipient_id: 1, updatedAt: -1 });

// Bell badge — counts unseen
notification_schema.index({ recipient_id: 1, seen: 1 });

// Aggregation lookup — sparse because most entries don't aggregate
notification_schema.index(
  { recipient_id: 1, aggregation_key: 1, createdAt: -1 },
  { sparse: true }
);

// Auto-cleanup after 90 days — adjust or remove if you want indefinite retention
notification_schema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const notification_model = model<NotificationDocument>(
  'notification',
  notification_schema
);