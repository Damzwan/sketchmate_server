import { FeedPost, HydratedPostComment } from '../../types/types';
import { LeanPost, UserDocument } from '../../types/mongoose.types';
import { user_model } from '../../models/user.model';
import { post_comment_model, post_reaction_model } from '../../models/post.model';
import { Types } from 'mongoose';
import { PUBLIC_USER_FIELDS } from '../../types/projections';

export interface HydrationOverrides {
  /** Skip the author lookup — caller already has it (e.g. publish route, profile route). */
  author?: { _id: string; name: string; img: string; customization?: any };
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
    enable_remix: post.enable_remix ?? true,
    enable_comments: post.enable_comments ?? true,
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

/** Number of comment previews attached to each feed post. */
const FEED_COMMENT_PREVIEW = 2;

/**
 * Batch-hydrate a page of posts for the feed: authors, the viewer's own
 * reactions, and the latest few comments per post — in a fixed number of
 * queries regardless of page size.
 *
 * Lives here rather than inline in the route because all three feed tabs
 * (for-you / mates / latest) select posts differently but present them
 * identically.
 */
export async function hydrateFeedPosts(
  posts: LeanPost[],
  viewerId: string
): Promise<FeedPost[]> {
  if (posts.length === 0) return [];

  const postIds = posts.map(p => new Types.ObjectId(p._id));
  const viewerObjectId = new Types.ObjectId(viewerId);

  const [latestCommentsNested, userReactions] = await Promise.all([
    Promise.all(
      postIds.map(id =>
        post_comment_model
          .find({ post_id: id, status: { $nin: ['under_review', 'removed'] } })
          .sort({ createdAt: -1 })
          .limit(FEED_COMMENT_PREVIEW)
          .lean()
      )
    ),
    post_reaction_model.find({ user_id: viewerObjectId, post_id: { $in: postIds } }).lean()
  ]);

  const validComments = latestCommentsNested.flat().filter(Boolean) as any[];

  const authorIds = [
    ...new Set([
      ...posts.map(p => p.author_id.toString()),
      ...validComments.map(c => c.author_id.toString())
    ])
  ].map(id => new Types.ObjectId(id));

  const users = (await user_model
    .find({ _id: { $in: authorIds } })
    .select('_id name img customization')
    .lean()) as unknown as UserDocument[];

  const userMap = users.reduce((acc, user) => {
    acc[user._id.toString()] = user;
    return acc;
  }, {} as Record<string, UserDocument>);

  const userReactionMap = userReactions.reduce((acc, rx: any) => {
    acc[rx.post_id.toString()] = rx.reaction_type;
    return acc;
  }, {} as Record<string, string>);

  const toAuthor = (id: string) => {
    const doc = userMap[id];
    return doc
      ? {
          _id: doc._id.toString(),
          name: doc.name,
          img: doc.img,
          customization: doc.customization
        }
      : { _id: id, name: 'Unknown', img: '' };
  };

  const commentsByPostId = validComments.reduce((acc: Record<string, HydratedPostComment[]>, comment) => {
    const pid = comment.post_id.toString();
    if (!acc[pid]) acc[pid] = [];
    acc[pid].push({
      _id: comment._id.toString(),
      post_id: pid,
      message: comment.message,
      createdAt: new Date(comment.createdAt).toISOString(),
      updatedAt: new Date(comment.updatedAt).toISOString(),
      author: toAuthor(comment.author_id.toString())
    });
    return acc;
  }, {} as Record<string, HydratedPostComment[]>);

  return posts.map(post => {
    const postIdStr = post._id.toString();
    // Sort the previews chronologically so the card reads naturally.
    const comments = (commentsByPostId[postIdStr] || []).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    return shapeFeedPost(
      post,
      toAuthor(post.author_id.toString()),
      userReactionMap[postIdStr] || null,
      comments
    );
  });
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
      .select(PUBLIC_USER_FIELDS)
      .lean()) as unknown as UserDocument | null;

    author = authorDoc
      ? {
          _id: authorDoc._id.toString(),
          name: authorDoc.name,
          img: authorDoc.img,
          customization: authorDoc.customization
        }
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