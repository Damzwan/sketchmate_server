import mongoose, { Schema } from 'mongoose';
import { Balloon } from '../types/types';

const balloon_schema = new Schema<Omit<Balloon, 'sender'> & {
  sender: Schema.Types.ObjectId,
}>(
  {
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    message: { type: String, default: '' },
    drawingJsonUrl: { type: String, required: true },
    img: { type: String, required: true },
    thumbnail: { type: String, required: true },
    aspect_ratio: { type: Number, required: true },
    status: {
      type: String,
      enum: ['pending', 'paired', 'accepted'],
      default: 'pending'
    },
    createdAt: { type: Date, default: Date.now },
    matchedAt: { type: Date, default: Date.now, required: false },
    pairedUser: { type: Schema.Types.ObjectId, default: null, required: false },
    pairedBalloon: { type: Schema.Types.ObjectId, default: null, required: false },
    cancelledBalloons: [
      { type: Schema.Types.ObjectId, ref: 'balloon', default: [] }
    ]
  },
  { collection: 'balloon' }
);

export const balloon_model = mongoose.model('balloon', balloon_schema);
