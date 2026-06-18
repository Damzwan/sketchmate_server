import mongoose, { Schema } from 'mongoose';
import { SavedDrawingDocument } from '../types/mongoose.types';

const savedDrawingSchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: 'users', required: true, index: true },
  drawing: { type: String, required: true },
  img: { type: String, required: true }
}, {
  timestamps: true
});

export const saved_drawing_model = mongoose.model<SavedDrawingDocument>('saved_drawings', savedDrawingSchema);