import mongoose, { Schema } from 'mongoose';
import {  BasePost, BasePostComment, BasePostReaction } from '../types/types';
import { AsDocument } from '../types/mongoose.types';


const { ObjectId } = Schema.Types;

export const post_model = mongoose.model<AsDocument<BasePost, 'author_id'>>(
  'posts',
  new Schema({
    author_id: { type: ObjectId, ref: 'users', required: true, index: true },
    drawing_url: { type: String, required: true },
    image_url: { type: String, required: true },
    thumbnail_url: { type: String, required: true },
    aspect_ratio: { type: Number, required: true },
    description: { type: String, required: false },
    reaction_counts: { type: Map, of: Number, default: {} },
    comment_count: { type: Number, default: 0 },
    reports_count: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'under_review', 'removed'], default: 'active' }
  }, { timestamps: true })
);

export const post_reaction_model = mongoose.model<AsDocument<BasePostReaction, 'post_id' | 'user_id'>>(
  'post_reactions',
  new Schema({
    post_id: { type: ObjectId, ref: 'posts', required: true, index: true },
    user_id: { type: ObjectId, ref: 'users', required: true, index: true },
    reaction_type: { type: String, required: true }
  }, { timestamps: true })
);

export const post_comment_model = mongoose.model<AsDocument<BasePostComment, 'post_id' | 'author_id'>>(
  'post_comments',
  new Schema({
    post_id: { type: ObjectId, ref: 'posts', required: true, index: true },
    author_id: { type: ObjectId, ref: 'users', required: true },
    message: { type: String, required: true }
  }, { timestamps: true })
);