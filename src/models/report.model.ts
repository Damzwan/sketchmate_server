import mongoose, { Schema } from 'mongoose';

const report_schema = new Schema({
  reporter_id: { type: String, required: true },
  target_id: { type: String, required: true },
  target_type: { type: String, enum: ['post', 'comment'], required: true },
  reason: { type: String, required: true }
}, { timestamps: true });

export const report_model = mongoose.model('reports', report_schema);