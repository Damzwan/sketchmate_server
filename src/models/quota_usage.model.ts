import mongoose, { Schema, Document, Types } from 'mongoose';

export interface QuotaUsageDocument extends Document {
  user_id: Types.ObjectId;
  date: Date;
  balloons_sent: number;
  posts_created: number;
  mates_made: number;
}

const QuotaUsageSchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  date: { type: Date, required: true }, // Will always be startOfUtcDay
  balloons_sent: { type: Number, default: 0 },
  posts_created: { type: Number, default: 0 },
  // New mates made ON this UTC day. Summed across a rolling 7-day window to gate
  // how many fresh friendships a free user can form per week — the total-mate
  // cap it replaced punished people for the friends they already had.
  mates_made: { type: Number, default: 0 }
});

QuotaUsageSchema.index({ user_id: 1, date: 1 }, { unique: true });

export const quota_usage_model = mongoose.model<QuotaUsageDocument>('QuotaUsage', QuotaUsageSchema);