import mongoose, { Schema } from 'mongoose';
import {
    PostDocument,
    PostCommentDocument,
    PostReactionDocument
} from '../types/mongoose.types';

const { ObjectId } = Schema.Types;

const moderationSubSchema = new Schema({
    quarantined_at: { type: Date },
    removed_at:     { type: Date },
    last_report_at: { type: Date },
    last_report_reason: { type: String }
}, { _id: false });

const postSchema = new Schema<PostDocument>({
    author_id: { type: ObjectId, ref: 'users', required: true },
    drawing_url: { type: String, required: true },
    image_url: { type: String, required: true },
    thumbnail_url: { type: String, required: true },
    aspect_ratio: { type: Number, required: true },
    description: { type: String, required: false },
    reaction_counts: { type: Map, of: Number, default: {} },

    // --- ENGAGEMENT METRICS ---
    comment_count: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    total_reactions: { type: Number, default: 0 },

    // --- MODERATION ---
    reports_count: { type: Number, default: 0 },
    status: {
        type: String,
        enum: ['active', 'under_review', 'removed'],
        default: 'active'
    },
    moderation: { type: moderationSubSchema, default: () => ({}) }
}, { timestamps: true });

// --- FEED OPTIMIZED INDEXES ---
postSchema.index({ author_id: 1, status: 1, createdAt: -1 });
postSchema.index({ status: 1, createdAt: -1 });

// --- POPULARITY ALGORITHM INDEX ---
// Drives the "Popular" segment of the global feed
postSchema.index({ status: 1, views: -1, total_reactions: -1, createdAt: -1 });

// --- MOD QUEUE INDEX ---
postSchema.index({ status: 1, 'moderation.quarantined_at': 1 });

export const post_model = mongoose.model<PostDocument>('posts', postSchema);

const reactionSchema = new Schema<PostReactionDocument>({
    post_id: { type: ObjectId, ref: 'posts', required: true },
    user_id: { type: ObjectId, ref: 'users', required: true },
    reaction_type: { type: String, required: true }
}, { timestamps: true });

reactionSchema.index({ post_id: 1, user_id: 1 }, { unique: true });

export const post_reaction_model = mongoose.model<PostReactionDocument>('post_reactions', reactionSchema);

const commentSchema = new Schema<PostCommentDocument>({
    post_id: { type: ObjectId, ref: 'posts', required: true },
    author_id: { type: ObjectId, ref: 'users', required: true },
    message: { type: String, required: true },

    status: {
        type: String,
        enum: ['active', 'under_review', 'removed'],
        default: 'active'
    },
    reports_count: { type: Number, default: 0 }
}, { timestamps: true });

commentSchema.index({ post_id: 1, createdAt: -1 });
commentSchema.index({ post_id: 1, createdAt: 1 });
commentSchema.index({ status: 1, 'createdAt': -1 });

export const post_comment_model = mongoose.model<PostCommentDocument>('post_comments', commentSchema);