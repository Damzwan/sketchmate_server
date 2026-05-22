import { FeedPost, HydratedPostComment } from '../../types/types';
import { LeanPost, UserDocument } from '../../types/mongoose.types';
import { user_model } from '../../models/user.model';
import { post_reaction_model } from '../../models/post.model';
import { Types } from 'mongoose';

export interface HydrationOverrides {
  /** Skip the author lookup — caller already has it (e.g. publish route, profile route). */
  author?: { _id: string; name: string; img: string };
  /** Skip the reaction lookup — useful for freshly-created posts. */
  user_reaction?: string | null;
  /** Comments already fetched by caller (feed includes latest 2, publish has none). */
  comments?: HydratedPostComment[];
}

/**
 * Reshape a raw LeanPost into the FeedPost shape the frontend renders.
 * Pure transform — no DB calls. Use `hydratePost` if you need lookups.
 */
export function shapeFeedPost(
  post: LeanPost,
  author: { _id: string; name: string; img: string },
  user_reaction: string | null,
  comments: HydratedPostComment[]
): FeedPost {
  return {
    _id: post._id.toString(),
    author_id: post.author_id.toString(),
    drawing_url: post.drawing_url,
    image_url: post.image_url,
    thumbnail_url: post.thumbnail_url,
    aspect_ratio: post.aspect_ratio,
    description: post.description || '',
    enable_remix: post.enable_remix || true,
    enable_comments: post.enable_comments || true,
    status: post.status || 'active',
    comment_count: post.comment_count || 0,
    reports_count: post.reports_count || 0,
    views: post.views || 0,
    total_reactions: post.total_reactions || 0,
    author,
    user_reaction,
    reaction_counts:
      post.reaction_counts instanceof Map
        ? Object.fromEntries(post.reaction_counts)
        : post.reaction_counts || {},
    comments,
    createdAt:
      post.createdAt instanceof Date
        ? post.createdAt.toISOString()
        : new Date(post.createdAt).toISOString(),
    updatedAt:
      post.updatedAt instanceof Date
        ? post.updatedAt.toISOString()
        : new Date(post.updatedAt).toISOString()
  };
}

/**
 * Hydrate a single post, falling back to DB lookups when overrides aren't
 * provided. The publish route always provides everything (skipping DB calls);
 * the feed route batches its own lookups and passes them in via overrides.
 */
export async function hydratePost(
  post: LeanPost,
  viewerId: string,
  overrides: HydrationOverrides = {}
): Promise<FeedPost> {
  const authorIdStr = post.author_id.toString();
  const postIdStr = post._id.toString();

  // Author
  let author = overrides.author;
  if (!author) {
    const authorDoc = (await user_model
      .findById(authorIdStr)
      .select('_id name img')
      .lean()) as unknown as UserDocument | null;

    author = authorDoc
      ? { _id: authorDoc._id.toString(), name: authorDoc.name, img: authorDoc.img }
      : { _id: authorIdStr, name: 'Unknown', img: '' };
  }

  // Reaction
  let user_reaction = overrides.user_reaction ?? null;
  if (overrides.user_reaction === undefined) {
    const reaction = (await post_reaction_model
      .findOne({ user_id: new Types.ObjectId(viewerId), post_id: post._id })
      .lean()) as any;
    user_reaction = reaction?.reaction_type ?? null;
  }

  const comments = overrides.comments ?? [];

  return shapeFeedPost(post, author, user_reaction, comments);
}