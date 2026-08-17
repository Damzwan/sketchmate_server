import mongoose, { Schema } from 'mongoose';
import { SavedPostDocument } from '../types/mongoose.types';

const { ObjectId } = Schema.Types;

/**
 * A viewer's private bookmark on a post. Deliberately its own collection rather
 * than an array on the post or the user: the list is per-VIEWER and unbounded,
 * and the hot read ("is this post saved by me") has to answer for a whole feed
 * page at once — both of which are index lookups here and array scans anywhere
 * else.
 *
 * Nothing about it is public. There is no counter on the post and no
 * notification to the author: a save is a reading-list entry, not a reaction.
 */
const savedPostSchema = new Schema<SavedPostDocument>({
  user_id: { type: ObjectId, ref: 'users', required: true },
  post_id: { type: ObjectId, ref: 'posts', required: true }
}, { timestamps: true });

// Saving twice is the same as saving once. The unique index is what makes the
// save route idempotent without a read-then-write race.
savedPostSchema.index({ user_id: 1, post_id: 1 }, { unique: true });

// Read path: "my saved posts, newest save first".
savedPostSchema.index({ user_id: 1, createdAt: -1 });

// Read path: cleanup when a post is deleted.
savedPostSchema.index({ post_id: 1 });

export const saved_post_model = mongoose.model<SavedPostDocument>('saved_posts', savedPostSchema);
