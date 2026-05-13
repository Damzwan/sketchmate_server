import mongoose, { Schema } from 'mongoose';
import { BalloonDocument } from '../types/mongoose.types';

const { ObjectId } = Schema.Types;

const balloon_schema = new Schema<BalloonDocument>(
  {
    sender: { type: ObjectId, ref: 'users', required: true },
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
    matchedAt: { type: Date, default: Date.now, required: false }, // @deprecated
    lastActivityAt: { type: Date, default: Date.now },

    pairedUser: { type: ObjectId, ref: 'users', default: null, required: false }, // @deprecated
    pairedBalloon: { type: ObjectId, ref: 'balloon', default: null, required: false }, // @deprecated

    cancelledBalloons: [
      { type: ObjectId, ref: 'balloon', default: [] }
    ],
    version: { type: Number, default: 1 },
    rejected_by: [{ type: ObjectId, ref: 'users' }]
  },
  { collection: 'balloon' }
);

// Indexing for the "Hot Potato" matching or general search
balloon_schema.index({ status: 1, lastActivityAt: -1 });
balloon_schema.index({ sender: 1 });

export const balloon_model = mongoose.model<BalloonDocument>('balloon', balloon_schema);