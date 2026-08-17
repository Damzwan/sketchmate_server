import { Types } from 'mongoose';
import { saved_post_model } from '../../models/saved-post.model';
import { post_model } from '../../models/post.model';
import { LeanPost } from '../../types/mongoose.types';

/**
 * Bookmark a post. Idempotent — saving something already saved reports success
 * and leaves the original save date alone, so re-tapping the button can't
 * silently reorder someone's list.
 */
export async function savePost(user_id: string, post_id: string) {
  const result = await saved_post_model.updateOne(
    { user_id: new Types.ObjectId(user_id), post_id: new Types.ObjectId(post_id) },
    { $setOnInsert: { user_id: new Types.ObjectId(user_id), post_id: new Types.ObjectId(post_id) } },
    { upsert: true }
  );

  return { saved: true, created: (result.upsertedCount ?? 0) > 0 };
}

/** Remove a bookmark. Also idempotent: unsaving what isn't saved is a success. */
export async function unsavePost(user_id: string, post_id: string) {
  const result = await saved_post_model.deleteOne({
    user_id: new Types.ObjectId(user_id),
    post_id: new Types.ObjectId(post_id)
  });

  return { saved: false, removed: result.deletedCount > 0 };
}

/**
 * Which of these posts the viewer has saved. One query for a whole feed page,
 * and none at all for an empty page — so hydration can call it unconditionally.
 */
export async function fetchSavedPostIds(
  viewer_id: string,
  post_ids: (Types.ObjectId | string)[]
): Promise<Set<string>> {
  if (post_ids.length === 0) return new Set();

  const rows = await saved_post_model
    .find({
      user_id: new Types.ObjectId(viewer_id),
      post_id: { $in: post_ids.map(id => new Types.ObjectId(id)) }
    })
    .select('post_id')
    .lean() as unknown as { post_id: Types.ObjectId }[];

  return new Set(rows.map(row => row.post_id.toString()));
}

/**
 * A page of the viewer's saved posts, newest save first.
 *
 * CURSOR-paginated, not offset-paginated, and that is load-bearing here rather
 * than a preference: the saved page's main action is UNSAVING, so the list
 * shrinks under the reader mid-scroll. With `skip((page-1)*limit)` every removal
 * shifts the whole tail up one, and the next page silently jumps over an item
 * for each one removed. A cursor is anchored to a row, so it survives that.
 *
 * `before` is the previous page's last BOOKMARK date, not the post's own date —
 * this list is ordered by when you saved, not when the drawing was made.
 *
 * Two steps rather than a populate: the bookmark rows are what gets paginated,
 * but the POSTS are what has to be filtered — a post that was deleted or pulled
 * by moderation must not surface. So the cursor and `hasMore` are derived from
 * the bookmark rows, which lets a page come back partly empty from that filter
 * without the caller concluding it has reached the end.
 */
export async function listSavedPosts(
  user_id: string,
  limit: number,
  before?: Date
): Promise<{ posts: LeanPost[]; nextCursor: string | null; hasMore: boolean }> {
  const rows = await saved_post_model
    .find({
      user_id: new Types.ObjectId(user_id),
      ...(before && { createdAt: { $lt: before } })
    })
    .sort({ createdAt: -1 })
    // One extra row purely to answer "is there a next page" without a count().
    .limit(limit + 1)
    .select('post_id createdAt')
    .lean() as unknown as { post_id: Types.ObjectId; createdAt: Date }[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  if (page.length === 0) return { posts: [], nextCursor: null, hasMore: false };

  const nextCursor = hasMore
    ? page[page.length - 1].createdAt.toISOString()
    : null;

  const postIds = page.map(row => row.post_id);
  const posts = await post_model
    .find({ _id: { $in: postIds }, status: 'active' })
    .lean() as unknown as LeanPost[];

  // Restore save order — the `$in` above comes back in whatever order the index
  // likes, and dead ids simply drop out.
  const byId = new Map(posts.map(post => [post._id.toString(), post]));
  const ordered = postIds
    .map(id => byId.get(id.toString()))
    .filter((post): post is LeanPost => !!post);

  return { posts: ordered, nextCursor, hasMore };
}

/** Drop every bookmark pointing at a post. Called when the post itself goes. */
export async function purgeSavesForPost(post_id: Types.ObjectId | string) {
  return await saved_post_model.deleteMany({ post_id: new Types.ObjectId(post_id) });
}
