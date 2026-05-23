import mongoose, { Schema, Document, Types } from 'mongoose';

export interface QuotaUsageDocument extends Document {
  user_id: Types.ObjectId;
  date: Date;
  balloons_sent: number;
  posts_created: number;
}

const QuotaUsageSchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  date: { type: Date, required: true }, // Will always be startOfUtcDay
  balloons_sent: { type: Number, default: 0 },
  posts_created: { type: Number, default: 0 }
});

QuotaUsageSchema.index({ user_id: 1, date: 1 }, { unique: true });

export const quota_usage_model = mongoose.model<QuotaUsageDocument>('QuotaUsage', QuotaUsageSchema);