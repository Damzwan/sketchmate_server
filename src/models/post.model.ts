import mongoose, { Schema } from 'mongoose';
import {
  PostDocument,
  PostCommentDocument,
  PostReactionDocument,
  PostViewDocument
} from '../types/mongoose.types';

const { ObjectId } = Schema.Types;

const moderationSubSchema = new Schema({
  quarantined_at: { type: Date },
  removed_at: { type: Date },
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
  enable_comments: { type: Boolean, default: true },
  enable_remix: { type: Boolean, default: true },

  // --- ENGAGEMENT METRICS ---
  comment_count: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
  total_reactions: { type: Number, default: 0 },

  // Set when this post's drawing also won a weekly competition. Denormalised
  // on purpose: the feed renders the badge without a join.
  competition_win: {
    type: new Schema({
      week_key: { type: String, required: true },
      category_label: { type: String, required: true },
      theme: { type: String }
    }, { _id: false }),
    required: false
  },

  // Lineage: which post this drawing was started from. `author_id` is
  // denormalised alongside the id so the credit row costs no second lookup on
  // the origin post — and so the credit survives the origin being deleted.
  remix_of: {
    type: new Schema({
      post_id: { type: ObjectId, ref: 'posts', required: true },
      author_id: { type: ObjectId, ref: 'users', required: true }
    }, { _id: false }),
    required: false
  },

  // Peers who drew on this canvas in a shared room. Verified and capped at
  // publish time — see `resolveCollaborators` in the post router.
  collaborators: [{ type: ObjectId, ref: 'users' }],

  // Shoutouts the artist picked in the composer. Same verification and cap as
  // collaborators; removable by the tagged user, which is why they are stored
  // as their own path rather than folded in with collaborators.
  mentions: [{ type: ObjectId, ref: 'users' }],

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

// --- LINEAGE INDEX ---
// Read path: "what has been remixed from this post", newest first. Sparse
// because the overwhelming majority of posts have no origin.
postSchema.index({ 'remix_of.post_id': 1, status: 1, createdAt: -1 }, { sparse: true });

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
  // Censored twin — see services/profanity.service.
  message_filtered: { type: String, required: false },

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

/**
 * Per-viewer view ledger. The `views` counter on a post is global and tells us
 * nothing about whether YOU already saw it — which is why the feed used to
 * serve the same posts on every open.
 *
 * Deliberately a *soft* signal: `seen_count` lets the feed show a post a couple
 * of times before suppressing it, rather than burning each post after a single
 * impression (which would starve the feed while the catalogue is small).
 *
 * The TTL is on `last_seen_at`, which the upsert refreshes — so a post you keep
 * being shown stays suppressed, while one that has dropped out of rotation
 * becomes eligible again after the window. Nothing is suppressed forever.
 */
const POST_VIEW_TTL_DAYS = 30;

const postViewSchema = new Schema<PostViewDocument>({
  post_id: { type: ObjectId, ref: 'posts', required: true },
  user_id: { type: ObjectId, ref: 'users', required: true },
  seen_count: { type: Number, default: 1 },
  last_seen_at: { type: Date, default: Date.now }
});

postViewSchema.index({ user_id: 1, post_id: 1 }, { unique: true });
// Read path: "what has this user seen recently", newest first.
postViewSchema.index({ user_id: 1, last_seen_at: -1 });
postViewSchema.index({ last_seen_at: 1 }, { expireAfterSeconds: POST_VIEW_TTL_DAYS * 24 * 60 * 60 });

export const post_view_model = mongoose.model<PostViewDocument>('post_views', postViewSchema);