import { FeedPost, HydratedPostComment, PostCreditUser } from '../../types/types';
import { LeanPost, UserDocument } from '../../types/mongoose.types';
import { user_model } from '../../models/user.model';
import { post_comment_model, post_reaction_model } from '../../models/post.model';
import { Types } from 'mongoose';
import { PUBLIC_USER_FIELDS } from '../../types/projections';
import { fetchSavedPostIds } from './saved-post.service';

export interface HydrationOverrides {
  /** Skip the author lookup — caller already has it (e.g. publish route, profile route). */
  author?: { _id: string; name: string; img: string; customization?: any };
  /** Skip the reaction lookup — useful for freshly-created posts. */
  user_reaction?: string | null;
  /** Comments already fetched by caller (feed includes latest 2, publish has none). */
  comments?: HydratedPostComment[];
  /** Credited users, when the caller already looked them up. */
  credits?: PostCredits;
  /** Skip the bookmark lookup — caller already knows (the saved list does). */
  is_saved?: boolean;
}

/**
 * The hydrated users a post credits. One bag rather than a growing tail of
 * positional arguments — every kind of credit resolves from the same batched
 * user lookup, so they arrive together.
 */
export interface PostCredits {
  /** Origin author for `remix_of`. */
  remixAuthor?: PostCreditUser;
  /** Room peers, in the order they first drew. */
  collaborators?: PostCreditUser[];
  /** Shoutouts, in the order the artist picked them. */
  mentions?: PostCreditUser[];
}

/**
 * A credit for a user who no longer resolves — deleted account, or an id that
 * outlived its document. The row still renders: the association is a fact about
 * the drawing, and blanking it would silently rewrite history.
 */
function unknownCredit(id: string): PostCreditUser {
  return { _id: id, name: 'Unknown', img: '' };
}

/**
 * The credit fields of a FeedPost, reshaped from the bare ids on the document.
 * Split out of `shapeFeedPost` for the routes that assemble their response by
 * spreading the raw post — they still need this one part rebuilt.
 */
export function shapePostCredits(
  post: LeanPost,
  credits: PostCredits = {}
): Pick<FeedPost, 'remix_of' | 'collaborators' | 'mentions'> {
  return {
    ...(post.remix_of && {
      remix_of: {
        post_id: post.remix_of.post_id.toString(),
        author: credits.remixAuthor ?? unknownCredit(post.remix_of.author_id.toString())
      }
    }),
    ...(credits.collaborators?.length && { collaborators: credits.collaborators }),
    ...(credits.mentions?.length && { mentions: credits.mentions })
  };
}

/**
 * Reshape a raw LeanPost into the FeedPost shape the frontend renders.
 * Pure transform — no DB calls. Use `hydratePost` if you need lookups.
 */
export function shapeFeedPost(
  post: LeanPost,
  author: { _id: string; name: string; img: string },
  user_reaction: string | null,
  comments: HydratedPostComment[],
  credits: PostCredits = {},
  is_saved = false
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
    is_saved,
    reaction_counts:
      post.reaction_counts instanceof Map
        ? Object.fromEntries(post.reaction_counts)
        : post.reaction_counts || {},
    comments,
    competition_win: (post as any).competition_win,
    ...shapePostCredits(post, credits),
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
 * `collaborators` and `mentions` are declared on `PostDocument`, but the schema
 * paths are arrays of refs and mongoose's own `Document` typing widens them on
 * the lean shape — so they are read through one narrow accessor rather than
 * being cast at each call site.
 */
function creditList(
  post: LeanPost,
  key: 'collaborators' | 'mentions'
): Types.ObjectId[] {
  return (post[key] as Types.ObjectId[] | undefined) || [];
}

/** Every user id a post credits, across all credit kinds. */
function creditedUserIds(post: LeanPost): string[] {
  return [
    ...(post.remix_of ? [post.remix_of.author_id.toString()] : []),
    ...creditList(post, 'collaborators').map(id => id.toString()),
    ...creditList(post, 'mentions').map(id => id.toString())
  ];
}

/**
 * Look up the credited users for a page of posts, keyed by post id so the
 * result drops straight into `shapeFeedPost`'s `credits` argument.
 *
 * One query for the whole page, and none at all when nothing on it carries a
 * credit — which is the common case, so callers can use this unconditionally.
 */
export async function fetchRemixCredits(
  posts: LeanPost[]
): Promise<Record<string, PostCredits>> {
  const userIds = [...new Set(posts.flatMap(creditedUserIds))];
  if (userIds.length === 0) return {};

  const users = (await user_model
    .find({ _id: { $in: userIds.map(id => new Types.ObjectId(id)) } })
    .select('_id name img')
    .lean()) as unknown as UserDocument[];

  const byUserId = users.reduce((acc, user) => {
    acc[user._id.toString()] = {
      _id: user._id.toString(),
      name: user.name,
      img: user.img
    };
    return acc;
  }, {} as Record<string, PostCreditUser>);

  const toCredit = (id: string) => byUserId[id] ?? unknownCredit(id);

  return posts.reduce((acc, post) => {
    if (creditedUserIds(post).length === 0) return acc;
    acc[post._id.toString()] = {
      ...(post.remix_of && { remixAuthor: toCredit(post.remix_of.author_id.toString()) }),
      ...(creditList(post, 'collaborators').length && {
        collaborators: creditList(post, 'collaborators').map(id => toCredit(id.toString()))
      }),
      ...(creditList(post, 'mentions').length && {
        mentions: creditList(post, 'mentions').map(id => toCredit(id.toString()))
      })
    };
    return acc;
  }, {} as Record<string, PostCredits>);
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

  const [latestCommentsNested, userReactions, savedIds] = await Promise.all([
    Promise.all(
      postIds.map(id =>
        post_comment_model
          .find({ post_id: id, status: { $nin: ['under_review', 'removed'] } })
          .sort({ createdAt: -1 })
          .limit(FEED_COMMENT_PREVIEW)
          .lean()
      )
    ),
    post_reaction_model.find({ user_id: viewerObjectId, post_id: { $in: postIds } }).lean(),
    fetchSavedPostIds(viewerId, postIds)
  ]);

  const validComments = latestCommentsNested.flat().filter(Boolean) as any[];

  const authorIds = [
    ...new Set([
      ...posts.map(p => p.author_id.toString()),
      ...validComments.map(c => c.author_id.toString()),
      // Credited users ride the same lookup rather than adding a query — they
      // are usually already in this set anyway (people remix within the same
      // feed page they were just scrolling, and draw with their mates).
      ...posts.flatMap(creditedUserIds)
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
      : unknownCredit(id);
  };

  const toCredit = (id: string): PostCreditUser => {
    const doc = userMap[id];
    return doc
      ? { _id: doc._id.toString(), name: doc.name, img: doc.img }
      : unknownCredit(id);
  };

  const commentsByPostId = validComments.reduce((acc: Record<string, HydratedPostComment[]>, comment) => {
    const pid = comment.post_id.toString();
    if (!acc[pid]) acc[pid] = [];
    acc[pid].push({
      _id: comment._id.toString(),
      post_id: pid,
      message: comment.message,
      ...(comment.message_filtered && { message_filtered: comment.message_filtered }),
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
      comments,
      {
        ...(post.remix_of && {
          remixAuthor: toCredit(post.remix_of.author_id.toString())
        }),
        ...(creditList(post, 'collaborators').length && {
          collaborators: creditList(post, 'collaborators').map(id => toCredit(id.toString()))
        }),
        ...(creditList(post, 'mentions').length && {
          mentions: creditList(post, 'mentions').map(id => toCredit(id.toString()))
        })
      },
      savedIds.has(postIdStr)
    );
  });
}

/**
 * Hydrate a page of posts for a GRID — the profile gallery, the saved list.
 *
 * The cheap sibling of `hydrateFeedPosts`. A grid renders a thumbnail and
 * nothing else, so the expensive half of feed hydration is pure waste here:
 * `hydrateFeedPosts` fires one comment query PER POST (20 round trips for a
 * page of 20) and ships two hydrated comments per card that no grid tile draws
 * and every low-end device still has to parse and hold.
 *
 * Tapping a tile opens the photoswiper, which fetches the real comment thread
 * itself (`prefetchComments`) — so the previews were never the source of what
 * the user ends up reading either.
 *
 * Fixed query count: authors + viewer reactions + credits, plus whatever the
 * caller already resolved.
 */
export async function hydrateGridPosts(
  posts: LeanPost[],
  viewerId: string,
  options: { savedIds?: Set<string>; allSaved?: boolean } = {}
): Promise<FeedPost[]> {
  if (posts.length === 0) return [];

  const postIds = posts.map(p => new Types.ObjectId(p._id));

  const [userReactions, credits] = await Promise.all([
    post_reaction_model
      .find({ user_id: new Types.ObjectId(viewerId), post_id: { $in: postIds } })
      .lean(),
    fetchRemixCredits(posts)
  ]);

  // Credited users ride the same lookup as the authors rather than adding a
  // query — same trick as the feed path.
  const userIds = [
    ...new Set([
      ...posts.map(p => p.author_id.toString()),
      ...posts.flatMap(creditedUserIds)
    ])
  ].map(id => new Types.ObjectId(id));

  const users = (await user_model
    .find({ _id: { $in: userIds } })
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

  return posts.map(post => {
    const postIdStr = post._id.toString();
    const authorDoc = userMap[post.author_id.toString()];
    const author = authorDoc
      ? {
          _id: authorDoc._id.toString(),
          name: authorDoc.name,
          img: authorDoc.img,
          customization: authorDoc.customization
        }
      : unknownCredit(post.author_id.toString());

    return shapeFeedPost(
      post,
      author,
      userReactionMap[postIdStr] || null,
      // Deliberately empty — see the note above.
      [],
      credits[postIdStr],
      options.allSaved ?? options.savedIds?.has(postIdStr) ?? false
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
      : unknownCredit(authorIdStr);
  }

  // Credits. One extra query, and only on posts that actually carry one — the
  // feed path never reaches this branch (it batches its own).
  let credits = overrides.credits;
  if (!credits && creditedUserIds(post).length > 0) {
    credits = (await fetchRemixCredits([post]))[postIdStr] ?? {};
  }

  // Reaction
  let user_reaction = overrides.user_reaction ?? null;
  if (overrides.user_reaction === undefined) {
    const reaction = (await post_reaction_model
      .findOne({ user_id: new Types.ObjectId(viewerId), post_id: post._id })
      .lean()) as any;
    user_reaction = reaction?.reaction_type ?? null;
  }

  // Bookmark. Same override shape as the reaction above — the saved-posts list
  // already knows the answer for every row it returns.
  let is_saved = overrides.is_saved;
  if (is_saved === undefined) {
    is_saved = (await fetchSavedPostIds(viewerId, [post._id])).has(postIdStr);
  }

  const comments = overrides.comments ?? [];

  return shapeFeedPost(post, author, user_reaction, comments, credits, is_saved);
}