import mongoose, { Schema } from 'mongoose';
import {
    PostDocument,
    PostCommentDocument,
    PostReactionDocument
} from '../types/mongoose.types';

const { ObjectId } = Schema.Types;

/**
 * POST MODEL
 */
const postSchema = new Schema<PostDocument>({
    author_id: { type: ObjectId, ref: 'users', required: true },
    drawing_url: { type: String, required: true },
    image_url: { type: String, required: true },
    thumbnail_url: { type: String, required: true },
    aspect_ratio: { type: Number, required: true },
    description: { type: String, required: false },
    reaction_counts: { type: Map, of: Number, default: {} },
    comment_count: { type: Number, default: 0 },
    reports_count: { type: Number, default: 0 },
    status: {
        type: String,
        enum: ['active', 'under_review', 'removed'],
        default: 'active'
    }
}, { timestamps: true });

// --- FEED OPTIMIZED INDEXES ---
// 1. Used for viewing a specific user's profile OR fetching posts from your Following list
postSchema.index({ author_id: 1, status: 1, createdAt: -1 });
// 2. Used for the Global Fallback feed
postSchema.index({ status: 1, createdAt: -1 });

export const post_model = mongoose.model<PostDocument>('posts', postSchema);


/**
 * POST REACTION MODEL
 */
const reactionSchema = new Schema<PostReactionDocument>({
    post_id: { type: ObjectId, ref: 'posts', required: true },
    user_id: { type: ObjectId, ref: 'users', required: true },
    reaction_type: { type: String, required: true }
}, { timestamps: true });

// --- REACTION INDEX ---
// Ensures a user can only have ONE reaction per post at the database level, and makes lookups instant
reactionSchema.index({ post_id: 1, user_id: 1 }, { unique: true });

export const post_reaction_model = mongoose.model<PostReactionDocument>('post_reactions', reactionSchema);


/**
 * POST COMMENT MODEL
 */
const commentSchema = new Schema<PostCommentDocument>({
    post_id: { type: ObjectId, ref: 'posts', required: true },
    author_id: { type: ObjectId, ref: 'users', required: true },
    message: { type: String, required: true }
}, { timestamps: true });

// --- COMMENT INDEXES ---
// 1. For hydrating the feed (grabbing the absolute newest comment)
commentSchema.index({ post_id: 1, createdAt: -1 });
// 2. For paginating through comments on the full view
commentSchema.index({ post_id: 1, createdAt: 1 });

export const post_comment_model = mongoose.model<PostCommentDocument>('post_comments', commentSchema);