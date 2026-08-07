import Router from 'koa-router';
import { Types } from 'mongoose';
import { s3Creator } from '../../mongodb';
import { post_comment_model, post_model, post_reaction_model, post_view_model } from '../../models/post.model';
import { requireAuth } from '../../middleware/auth';
import { user_model } from '../../models/user.model';
import { BasePostComment, FeedPost, HydratedPostComment } from '../../types/types';
import { CONTAINER } from '../../s3';
import {
  LeanPost,
  PostCommentDocument,
  PostDocument,
  PostReactionDocument,
  UserDocument
} from '../../types/mongoose.types';
import { relationship_model } from '../../models/relationship.model';
import { requireAdultAccount } from '../services/parental.service';
import { requireCapability } from '../../middleware/moderation.middleware';
import { Capability } from '../../types/moderation.policy';
import { PUBLIC_USER_FIELDS } from '../../types/projections';
import { hydrateFeedPosts, shapeFeedPost } from '../services/post.service';
import { quota_usage_model } from '../../models/quota_usage.model';
import { startOfUtcDay } from '../../config/quota.config';
import { dispatchNotification } from '../services/notification.service';
import { v4 as uuidv4 } from 'uuid';
import { mixpanelEvents, trackEvent } from '../../mixpanel';
import { releasePostQuota } from '../services/quota.service';
import { censorText } from '../services/profanity.service';

const postRouter = new Router();

// Families policy: the public feed is a stranger surface, off under 13 with no
// parental override. Gated here as well as in the client so a replayed request
// can't publish a child's drawing to it.
const PUBLIC_FEED_AGE_MESSAGE = 'Public posts and comments are available from age 13.';

postRouter.post('/upload-urls', requireAuth, requireCapability(Capability.CREATE_POST), requireAdultAccount(PUBLIC_FEED_AGE_MESSAGE), async (ctx) => {
  try {
    const userId = ctx.state.user._id.toString();
    const uniqueId = uuidv4();

    const [drawingUrls, imageUrls, thumbnailUrls] = await Promise.all([
      s3Creator.getPresignedUploadUrl('application/gzip', CONTAINER.drawings, `public-posts/${userId}/${uniqueId}.gz`),
      s3Creator.getPresignedUploadUrl('image/webp', CONTAINER.drawings, `public-posts/${userId}/${uniqueId}.webp`),
      s3Creator.getPresignedUploadUrl('image/webp', CONTAINER.drawings, `public-posts/${userId}/${uniqueId}-thumb.webp`)
    ]);

    ctx.body = {
      drawing: drawingUrls,
      image: imageUrls,
      thumbnail: thumbnailUrls
    };
  } catch (error) {
    console.error('S3 Presigned URL error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to generate upload URLs' };
  }
});

postRouter.post('/publish', requireAuth, requireCapability(Capability.CREATE_POST), requireAdultAccount(PUBLIC_FEED_AGE_MESSAGE), async (ctx) => {
  const {
    drawing_url,
    image_url,
    thumbnail_url,
    aspect_ratio,
    description,
    enable_comments,
    enable_remix
  } = ctx.request.body;
  const authorObjectId = new Types.ObjectId(ctx.state.user._id);

  try {
    const [postDoc, authorDoc] = await Promise.all([
      post_model.create({
        author_id: authorObjectId,
        drawing_url,
        image_url,
        thumbnail_url,
        aspect_ratio,
        description,
        enable_comments,
        enable_remix
      }) as Promise<PostDocument>,
      user_model
        .findById(authorObjectId)
        .select(PUBLIC_USER_FIELDS)
        .lean() as Promise<UserDocument | null>,
      user_model.updateOne(
        { _id: authorObjectId },
        { $inc: { 'stats.posts': 1 } }
      ),
      quota_usage_model.updateOne(
        { user_id: authorObjectId, date: startOfUtcDay() },
        { $inc: { posts_created: 1 } },
        { upsert: true }
      )
    ]);

    const leanPost = postDoc.toObject() as unknown as LeanPost;

    const author = authorDoc
      ? {
        _id: authorDoc._id.toString(),
        name: authorDoc.name,
        img: authorDoc.img,
        customization: authorDoc.customization
      }
      : { _id: ctx.state.user._id.toString(), name: 'Unknown', img: '' };

    const hydrated = shapeFeedPost(leanPost, author, null, []);

    trackEvent(author._id, mixpanelEvents.post_v2_publish, {
      post_id: leanPost._id.toString(),
      has_description: !!description,
      enable_comments: !!enable_comments,
      enable_remix: !!enable_remix,
      aspect_ratio
    });

    ctx.status = 201;
    ctx.body = { post: hydrated };
  } catch (error) {
    console.error('Publish error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to publish post' };
  }
});

/**
 * BATCHED VIEW TRACKING
 * The frontend sends an array of post IDs that were on screen for > 1.5 seconds.
 */
postRouter.post('/views', requireAuth, async (ctx) => {
  const { post_ids } = ctx.request.body;

  if (!Array.isArray(post_ids) || post_ids.length === 0) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid post_ids array' };
    return;
  }

  try {
    const oids = post_ids.slice(0, 50).map(id => new Types.ObjectId(id));
    const viewerId = new Types.ObjectId(ctx.state.user._id);

    await Promise.all([
      post_model.updateMany(
        { _id: { $in: oids }, status: 'active' },
        { $inc: { views: 1 } }
      ),
      // Per-viewer ledger, so the feed can stop re-serving what this user has
      // already been shown. Upsert bumps the count and refreshes the TTL clock.
      post_view_model.bulkWrite(
        oids.map(post_id => ({
          updateOne: {
            filter: { user_id: viewerId, post_id },
            update: {
              $inc: { seen_count: 1 },
              $set: { last_seen_at: new Date() }
            },
            upsert: true
          }
        })),
        { ordered: false }
      )
    ]);

    ctx.status = 200;
    ctx.body = { success: true };
  } catch (error) {
    console.error('Failed to log views:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to log views' };
  }
});

// ============================================================================
// FEED
// ============================================================================

type FeedTab = 'for_you' | 'mates' | 'latest';

const FEED_TABS: FeedTab[] = ['for_you', 'mates', 'latest'];

/**
 * How many impressions a post gets with one viewer before it drops out of
 * rotation. Two, not one — seeing something twice is normal and forgivable;
 * seeing it on every single app open is the complaint we're fixing.
 */
const SEEN_SUPPRESS_AT = 2;

/** A post seen once stays eligible, but ranks far below anything fresh. */
const SEEN_DEMOTE_FACTOR = 0.25;

/** Cap on how much of the view ledger a single request consults. */
const SEEN_LOOKBACK = 400;

/**
 * Scored discovery only considers posts from this window. Without it, an old
 * post with a big view count outranks everything new forever — which is half
 * of why the feed felt frozen.
 */
const DISCOVERY_WINDOW_DAYS = 30;

/**
 * Ceiling on the share of For You slots that mates + follows may take. They
 * have their own tab now, and without a cap a handful of chatty mates fill the
 * whole page and global discovery never runs at all.
 */
const CONNECTION_SHARE = 0.3;

/**
 * For You only pulls connection posts this fresh. Without it, a mate who last
 * posted months ago still occupies a slot forever: the tier was sorted newest
 * first but never bounded, so "newest" could still be ancient. The Mates tab
 * stays unbounded — that surface is explicitly "everything from my people".
 */
const CONNECTION_WINDOW_DAYS = 3;

/** Over-fetch multiplier for the scored pool, so jitter has room to shuffle. */
const DISCOVERY_OVERFETCH = 4;

interface Audience {
  mateIds: Types.ObjectId[];
  followIds: Types.ObjectId[];
  blockedIds: Types.ObjectId[];
}

/**
 * Split the viewer's relationships into tiers. Mates are the reciprocal,
 * high-signal bond; follows are one-way interest; blocked are excluded outright.
 */
async function loadAudience(user_id: string): Promise<Audience> {
  const relationships = await relationship_model
    .find({ users: new Types.ObjectId(user_id) })
    .lean();

  const mateIds: Types.ObjectId[] = [];
  const followIds: Types.ObjectId[] = [];
  const blockedIds: Types.ObjectId[] = [];
  const now = new Date();

  for (const rel of relationships) {
    const otherUser = rel.users.find(id => id.toString() !== user_id);
    if (!otherUser) continue;

    const otherUserIdStr = otherUser.toString();

    if (rel.chat_status === 'blocked') {
      blockedIds.push(otherUser as Types.ObjectId);
      continue;
    }

    const isActiveTemporary =
      rel.chat_status === 'temporary' && !!rel.expires_at && new Date(rel.expires_at) > now;
    if (rel.chat_status === 'mate' || isActiveTemporary) {
      mateIds.push(otherUser as Types.ObjectId);
      continue;
    }

    const userFollowsOther = rel.follows?.some(f =>
      f.follower.toString() === user_id &&
      f.followed.toString() === otherUserIdStr
    );
    if (userFollowsOther) {
      followIds.push(otherUser as Types.ObjectId);
    }
  }

  return { mateIds, followIds, blockedIds };
}

interface SeenState {
  /** Hit the impression ceiling — excluded from discovery. */
  suppressed: Types.ObjectId[];
  /** Seen once — still eligible, but demoted. Keyed by post id string. */
  demoted: Set<string>;
}

async function loadSeenState(user_id: string): Promise<SeenState> {
  const rows = (await post_view_model
    .find({ user_id: new Types.ObjectId(user_id) })
    .sort({ last_seen_at: -1 })
    .limit(SEEN_LOOKBACK)
    .select('post_id seen_count')
    .lean()) as any[];

  const suppressed: Types.ObjectId[] = [];
  const demoted = new Set<string>();

  for (const row of rows) {
    if ((row.seen_count || 0) >= SEEN_SUPPRESS_AT) suppressed.push(row.post_id);
    else demoted.add(row.post_id.toString());
  }

  return { suppressed, demoted };
}

/**
 * Time-decayed popularity, Hacker-News style. Replaces the old `views: -1`
 * sort, which was both static AND self-reinforcing: /views incremented the
 * counter on exactly the posts it had just shown, so being shown made a post
 * rank higher, which got it shown more. Nothing ever displaced the top.
 *
 * Dividing by age means a post has to keep earning its slot, and the +1 in the
 * numerator lets a brand-new post with zero engagement still enter the pool —
 * so "popular" and "new" blend on one axis instead of being interleaved by hand.
 */
function decayScoreStage(now: Date) {
  return [
    {
      $addFields: {
        _ageHours: { $divide: [{ $subtract: [now, '$createdAt'] }, 3600000] }
      }
    },
    {
      $addFields: {
        _score: {
          $divide: [
            {
              $add: [
                1,
                { $multiply: [{ $ifNull: ['$total_reactions', 0] }, 3] },
                { $multiply: [{ $ifNull: ['$comment_count', 0] }, 5] },
                { $multiply: [{ $ifNull: ['$views', 0] }, 0.2] }
              ]
            },
            { $pow: [{ $add: ['$_ageHours', 2] }, 1.5] }
          ]
        }
      }
    }
  ];
}

/**
 * Global discovery for the For You tab: score by decayed popularity, drop what
 * the viewer has already exhausted, demote what they've seen once, then jitter
 * the order so two visits in a row don't produce an identical page even when
 * the underlying data hasn't moved.
 */
async function selectDiscoveryPosts(
  excludedAuthorIds: Types.ObjectId[],
  seen: SeenState,
  slots: number
): Promise<LeanPost[]> {
  if (slots <= 0) return [];

  const now = new Date();
  const since = new Date(now.getTime() - DISCOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const candidates = (await post_model.aggregate([
    {
      $match: {
        author_id: { $nin: excludedAuthorIds },
        status: 'active',
        createdAt: { $gte: since },
        _id: { $nin: seen.suppressed }
      }
    },
    ...decayScoreStage(now),
    { $sort: { _score: -1 } },
    { $limit: slots * DISCOVERY_OVERFETCH }
  ])) as (LeanPost & { _score: number })[];

  const ranked = candidates
    .map(post => {
      const seenOnce = seen.demoted.has(post._id.toString());
      // Jitter is what actually breaks the "identical every open" feeling. The
      // band is wide enough to reshuffle near-equal posts, narrow enough that a
      // genuinely strong post doesn't get buried.
      const jitter = 0.75 + Math.random() * 0.5;
      return { post, weight: post._score * jitter * (seenOnce ? SEEN_DEMOTE_FACTOR : 1) };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, slots)
    .map(entry => entry.post);

  if (ranked.length >= slots) return ranked;

  // Pool ran dry — a young app, an aggressive suppression list, or both. Top up
  // with anything else recent rather than serving a half-empty feed. Suppressed
  // posts are eligible here: showing a repeat beats showing nothing.
  const haveIds = ranked.map(p => new Types.ObjectId(p._id));
  const filler = (await post_model
    .find({
      author_id: { $nin: excludedAuthorIds },
      status: 'active',
      _id: { $nin: haveIds }
    })
    .sort({ createdAt: -1 })
    .limit(slots - ranked.length)
    .lean()) as unknown as LeanPost[];

  return [...ranked, ...filler];
}

interface ConnectionOptions {
  excludeIds?: Types.ObjectId[];
  /** Drop anything older than this. Omitted on the Mates tab. */
  since?: Date;
  /**
   * When present, posts the viewer has exhausted are excluded outright and
   * posts seen once sink below unseen ones. Omitted on the Mates tab, which is
   * meant to be an honest chronological list.
   */
  seen?: SeenState;
}

/** Newest-first posts from the viewer's mates and follows. */
async function selectConnectionPosts(
  audience: Audience,
  slots: number,
  options: ConnectionOptions = {}
): Promise<LeanPost[]> {
  const { excludeIds = [], since, seen } = options;
  const authorIds = [...audience.mateIds, ...audience.followIds];
  if (slots <= 0 || authorIds.length === 0) return [];

  const baseFilter: Record<string, any> = { status: 'active' };
  if (since) baseFilter.createdAt = { $gte: since };

  // Suppressed posts are excluded in the query rather than trimmed afterwards,
  // so a mate whose only recent post is burned yields the slot to discovery
  // instead of returning it and re-showing it.
  const blockedPostIds = [...excludeIds, ...(seen?.suppressed ?? [])];

  // Over-fetch: some of what comes back is demoted, and the reorder below can
  // only push those down if there are unseen posts underneath them to swap with.
  const fetchLimit = seen ? slots * 2 : slots;

  // Mates outrank follows, so query the tiers separately rather than sorting a
  // combined result purely by date.
  const matePosts = (await post_model
    .find({
      ...baseFilter,
      author_id: { $in: audience.mateIds },
      _id: { $nin: blockedPostIds }
    })
    .sort({ createdAt: -1 })
    .limit(fetchLimit)
    .lean()) as unknown as LeanPost[];

  let combined = matePosts;

  if (matePosts.length < fetchLimit && audience.followIds.length > 0) {
    const followPosts = (await post_model
      .find({
        ...baseFilter,
        author_id: { $in: audience.followIds },
        _id: { $nin: [...blockedPostIds, ...matePosts.map(p => new Types.ObjectId(p._id))] }
      })
      .sort({ createdAt: -1 })
      .limit(fetchLimit - matePosts.length)
      .lean()) as unknown as LeanPost[];

    combined = [...matePosts, ...followPosts];
  }

  if (!seen) return combined.slice(0, slots);

  // Stable partition: unseen first, each group keeping its mate-then-follow,
  // newest-first order. A post seen once can still appear, but only once the
  // fresh material runs out.
  const unseen = combined.filter(p => !seen.demoted.has(p._id.toString()));
  const seenOnce = combined.filter(p => seen.demoted.has(p._id.toString()));

  return [...unseen, ...seenOnce].slice(0, slots);
}

/** Strict reverse-chronological. No ranking, no suppression — Latest is meant
 *  to be the honest, predictable surface, and it refreshes on its own as people
 *  post. */
async function selectLatestPosts(
  audience: Audience,
  viewerId: Types.ObjectId,
  feedLevel: 'mates' | 'open',
  slots: number
): Promise<LeanPost[]> {
  // 'mates' means the viewer asked not to see strangers — Latest honours that
  // rather than quietly widening their feed.
  if (feedLevel === 'mates') {
    return selectConnectionPosts(audience, slots);
  }

  return (await post_model
    .find({
      author_id: { $nin: [viewerId, ...audience.blockedIds] },
      status: 'active'
    })
    .sort({ createdAt: -1 })
    .limit(slots)
    .lean()) as unknown as LeanPost[];
}

postRouter.get('/feed', requireAuth, async (ctx) => {
  const limit = parseInt(ctx.query.limit as string) || 20;
  const requestedTab = ctx.query.tab as FeedTab;
  const tab: FeedTab = FEED_TABS.includes(requestedTab) ? requestedTab : 'for_you';

  const user_id = ctx.state.user._id.toString();
  const userIdObj = new Types.ObjectId(user_id);

  try {
    const feedLevel: 'off' | 'mates' | 'open' = ctx.state.user.feed_level || 'open';
    if (feedLevel === 'off') {
      ctx.body = { feed: [], tab };
      return;
    }

    const audience = await loadAudience(user_id);
    let feedPosts: LeanPost[] = [];

    if (tab === 'mates') {
      feedPosts = await selectConnectionPosts(audience, limit);
    } else if (tab === 'latest') {
      feedPosts = await selectLatestPosts(audience, userIdObj, feedLevel, limit);
    } else {
      // For You — connections first, capped so discovery always gets a share,
      // and bounded to recent posts so a quiet mate can't hold a slot forever.
      const seen = await loadSeenState(user_id);
      const connectionCap =
        feedLevel === 'open' ? Math.max(1, Math.round(limit * CONNECTION_SHARE)) : limit;

      feedPosts = await selectConnectionPosts(audience, connectionCap, {
        since: new Date(Date.now() - CONNECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000),
        seen
      });

      if (feedLevel === 'open') {
        if (feedPosts.length < limit) {
          const discovery = await selectDiscoveryPosts(
            [userIdObj, ...audience.mateIds, ...audience.followIds, ...audience.blockedIds],
            seen,
            limit - feedPosts.length
          );
          feedPosts.push(...discovery);
        }
      } else if (feedPosts.length < limit) {
        // Mates-only viewers have no discovery stage to absorb what the window
        // and the seen ledger just removed, so top up with older / already-seen
        // connection posts rather than handing them a near-empty page.
        const topUp = await selectConnectionPosts(audience, limit - feedPosts.length, {
          excludeIds: feedPosts.map(p => new Types.ObjectId(p._id))
        });
        feedPosts.push(...topUp);
      }
    }

    if (feedPosts.length === 0) {
      ctx.body = { feed: [], tab };
      return;
    }

    const uniquePostsMap = new Map<string, LeanPost>();
    for (const post of feedPosts) {
      const key = post._id.toString();
      if (!uniquePostsMap.has(key)) uniquePostsMap.set(key, post);
    }

    const hydratedFeed = await hydrateFeedPosts(
      Array.from(uniquePostsMap.values()),
      user_id
    );

    ctx.body = { feed: hydratedFeed, tab };
  } catch (error) {
    console.error('Feed Error:', error);
    ctx.throw(500, 'Failed to fetch feed');
  }
});

postRouter.post('/:post_id/comment', requireAuth, requireCapability(Capability.COMMENT_ON_POST), requireAdultAccount(PUBLIC_FEED_AGE_MESSAGE), async (ctx) => {
  const { post_id } = ctx.params;
  const { message } = ctx.request.body;
  const author_id = ctx.state.user._id;

  if (!message?.trim()) {
    ctx.status = 400;
    ctx.body = { error: 'Comment message cannot be empty' };
    return;
  }

  try {
    const post = await post_model.findOne({ _id: new Types.ObjectId(post_id), status: 'active' });
    if (!post) {
      ctx.status = 404;
      ctx.body = { error: 'Post not found' };
      return;
    }

    const message_filtered = censorText(message);

    const newComment = await post_comment_model.create({
      post_id: new Types.ObjectId(post_id),
      author_id: new Types.ObjectId(author_id),
      message,
      ...(message_filtered && { message_filtered })
    }) as PostCommentDocument;

    await post_model.updateOne({ _id: new Types.ObjectId(post_id) }, { $inc: { comment_count: 1 } });

    if (post.author_id.toString() !== author_id.toString()) {
      dispatchNotification({
        recipient_id: post.author_id.toString(),
        type: 'post_comment',
        aggregation_mode: 'merge_count',
        actor: {
          _id: author_id.toString(),
          name: ctx.state.user.name,
          img: ctx.state.user.img
        },
        target_type: 'post',
        target_id: post_id,
        target_preview: {
          thumbnail: post.thumbnail_url,
          text: message.slice(0, 100)
        },
        channels: { in_app: true }
      }).catch(err => console.error('Notification dispatch failed:', err));
    }

    trackEvent(author_id.toString(), mixpanelEvents.post_v2_comment, {
      post_id,
      post_author_id: post.author_id.toString(),
      is_own_post: post.author_id.toString() === author_id.toString()
    });

    ctx.status = 201;
    ctx.body = { comment: newComment.toObject() };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to post comment' };
  }
});

/**
 * DELETE COMMENT
 * Validates that the requestor is either the comment author OR the post owner.
 */
postRouter.delete('/:post_id/comment/:comment_id', requireAuth, async (ctx) => {
  const { post_id, comment_id } = ctx.params;
  const user_id = ctx.state.user._id.toString();

  try {
    const comment = await post_comment_model.findById(comment_id) as PostCommentDocument | null;
    if (!comment) {
      ctx.status = 404;
      ctx.body = { error: 'Comment not found' };
      return;
    }

    const post = await post_model.findById(post_id) as PostDocument | null;
    if (!post) {
      ctx.status = 404;
      ctx.body = { error: 'Post not found' };
      return;
    }

    // Permission check: You can delete if you wrote the comment OR you own the post
    if (comment.author_id.toString() !== user_id && post.author_id.toString() !== user_id) {
      ctx.status = 403;
      ctx.body = { error: 'You are not authorized to delete this comment' };
      return;
    }

    await post_comment_model.deleteOne({ _id: comment._id });
    await post_model.updateOne({ _id: post._id }, { $inc: { comment_count: -1 } });

    trackEvent(user_id, mixpanelEvents.post_v2_comment_deleted, {
      post_id,
      comment_id,
      by_post_owner: post.author_id.toString() === user_id
    });

    ctx.status = 200;
    ctx.body = { message: 'Comment deleted successfully' };
  } catch (error) {
    console.error('Delete comment error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to delete comment' };
  }
});

postRouter.post('/:post_id/react', requireAuth, requireCapability(Capability.REACT_TO_POST), async (ctx) => {
  const { post_id } = ctx.params;
  const { reaction_type } = ctx.request.body;
  const user_id = ctx.state.user._id.toString();

  try {
    const post = await post_model.findOne({ _id: new Types.ObjectId(post_id), status: 'active' });
    if (!post) {
      ctx.status = 404;
      ctx.body = { error: 'Post not found' };
      return;
    }

    const existing = await post_reaction_model.findOne({
      post_id: new Types.ObjectId(post_id),
      user_id: new Types.ObjectId(user_id)
    }) as PostReactionDocument | null;

    const isRemoving = !reaction_type || (existing && existing.reaction_type === reaction_type);

    if (isRemoving) {
      if (existing) {
        await Promise.all([
          post_reaction_model.deleteOne({ _id: existing._id }),
          post_model.updateOne(
            { _id: new Types.ObjectId(post_id) },
            {
              $inc: {
                [`reaction_counts.${existing.reaction_type}`]: -1,
                total_reactions: -1
              }
            }
          )
        ]);
      }
      trackEvent(user_id, mixpanelEvents.post_v2_react_removed, {
        post_id,
        reaction_type: existing?.reaction_type ?? null
      });
      ctx.body = { current_reaction: null };
      return;
    }

    const isNewReaction = !existing;

    if (existing) {
      await Promise.all([
        post_reaction_model.updateOne({ _id: existing._id }, { reaction_type }),
        post_model.updateOne(
          { _id: new Types.ObjectId(post_id) },
          {
            $inc: {
              [`reaction_counts.${existing.reaction_type}`]: -1,
              [`reaction_counts.${reaction_type}`]: 1
            }
          }
        )
      ]);
    } else {
      await Promise.all([
        post_reaction_model.create({
          post_id: new Types.ObjectId(post_id),
          user_id: new Types.ObjectId(user_id),
          reaction_type
        }),
        post_model.updateOne(
          { _id: new Types.ObjectId(post_id) },
          {
            $inc: {
              [`reaction_counts.${reaction_type}`]: 1,
              total_reactions: 1
            }
          }
        )
      ]);
    }

    if (isNewReaction && post.author_id.toString() !== user_id) {
      dispatchNotification({
        recipient_id: post.author_id.toString(),
        type: 'post_reaction',
        actor: {
          _id: user_id,
          name: ctx.state.user.name,
          img: ctx.state.user.img
        },
        aggregation_key: `post_reaction:${post_id}`,
        target_type: 'post',
        target_id: post_id,
        target_preview: { thumbnail: post.thumbnail_url },
        channels: { in_app: true }
      }).catch(err => console.error('Notification dispatch failed:', err));
    }

    trackEvent(user_id, mixpanelEvents.post_v2_react, {
      post_id,
      reaction_type,
      post_author_id: post.author_id.toString(),
      is_own_post: post.author_id.toString() === user_id,
      changed_reaction: !isNewReaction
    });

    ctx.body = { current_reaction: reaction_type };
  } catch (error) {
    console.error('Reaction Error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to process reaction' };
  }
});

postRouter.delete('/:post_id', requireAuth, async (ctx) => {
  const { post_id } = ctx.params;
  const user_id = ctx.state.user._id.toString();

  try {
    const post = await post_model.findById(post_id) as PostDocument | null;

    if (!post) {
      ctx.status = 404;
      ctx.body = { error: 'Post not found' };
      return;
    }

    if (post.author_id.toString() !== user_id) {
      ctx.status = 403;
      ctx.body = { error: 'You are not authorized to delete this post' };
      return;
    }

    // Claim the deletion before applying any counters. This keeps duplicate
    // requests from decrementing the user's post count or quota more than once.
    const deletion = await post_model.deleteOne({
      _id: post._id,
      author_id: post.author_id
    });

    if (deletion.deletedCount === 0) {
      ctx.status = 404;
      ctx.body = { error: 'Post not found' };
      return;
    }

    const [, , , postQuota] = await Promise.all([
      post_comment_model.deleteMany({ post_id: post._id }),
      post_reaction_model.deleteMany({ post_id: post._id }),
      user_model.updateOne(
        { _id: post.author_id },
        { $inc: { 'stats.posts': -1 } }
      ),
      releasePostQuota(user_id, post.createdAt)
    ]);

    const extractKey = (url: string) => url.split('/').pop();

    const keysToDelete = [
      extractKey(post.drawing_url),
      extractKey(post.image_url),
      extractKey(post.thumbnail_url)
    ].filter(Boolean) as string[];

    if (keysToDelete.length > 0) {
      s3Creator.deleteObjects(keysToDelete, CONTAINER.drawings).catch(err =>
        console.error('S3 Batch Deletion Error:', err)
      );
    }

    trackEvent(user_id, mixpanelEvents.post_v2_delete, { post_id });

    ctx.status = 200;
    ctx.body = {
      message: 'Post and associated data deleted successfully',
      post_quota: postQuota
    };
  } catch (error) {
    console.error('Delete post error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to delete post' };
  }
});

postRouter.get('/:post_id/comments', requireAuth, async (ctx) => {
  const { post_id } = ctx.params;
  const limit = parseInt(ctx.query.limit as string) || 20;
  const beforeDate = ctx.query.beforeDate ? new Date(ctx.query.beforeDate as string) : undefined;

  try {
    const query: any = {
      post_id: new Types.ObjectId(post_id),
      status: { $nin: ['under_review', 'removed'] }
    };

    if (beforeDate) {
      query.createdAt = { $lte: beforeDate }; // <= includes boundary, frontend dedupes by _id
    }

    const comments = await post_comment_model.find(query)
      .sort({ createdAt: -1 }) // Get newest first
      .limit(limit + 1)
      .lean() as any[];

    const hasMore = comments.length > limit;
    const pageComments = comments.slice(0, limit).reverse(); // Reverse so UI maps top to bottom chronologically

    if (pageComments.length === 0) {
      ctx.body = { comments: [], hasMore: false };
      return;
    }

    const authorIds = [...new Set(pageComments.map(c => c.author_id.toString()))].map(id => new Types.ObjectId(id));

    const authors = await user_model.find({
      _id: { $in: authorIds }
    }).select(PUBLIC_USER_FIELDS).lean() as unknown as UserDocument[];

    const authorMap = authors.reduce((acc, author) => {
      acc[author._id.toString()] = author;
      return acc;
    }, {} as Record<string, UserDocument>);

    const hydratedComments: BasePostComment[] = pageComments.map(comment => {
      const author = authorMap[comment.author_id.toString()];
      return {
        ...comment,
        _id: comment._id.toString(),
        post_id: comment.post_id.toString(),
        createdAt: comment.createdAt instanceof Date ? comment.createdAt.toISOString() : comment.createdAt,
        author: author
          ? author
          : { _id: comment.author_id.toString(), name: 'Unknown', img: '' }
      };
    });

    ctx.status = 200;
    ctx.body = { comments: hydratedComments, hasMore };
  } catch (error) {
    console.error('Fetch comments error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch comments' };
  }
});

postRouter.get('/:id', async (ctx) => {
  const post = await post_model.findById(ctx.params.id)
    .populate('author_id', PUBLIC_USER_FIELDS)
    .lean();

  if (!post || post.status === 'removed') {
    ctx.status = 404;
    ctx.body = { error: 'Post not found' };
    return;
  }

  // Hydrate the latest 2 comments (same shape as the feed) so a post opened
  // straight from a comment notification shows the new comment immediately —
  // this used to return `comments: []`, so the just-posted comment appeared
  // missing until the user manually opened the comment drawer.
  const latest = await post_comment_model.find({
    post_id: post._id,
    status: { $nin: ['under_review', 'removed'] }
  })
    .sort({ createdAt: -1 })
    .limit(2)
    .lean();

  const commentAuthorIds = latest.map((c: any) => c.author_id.toString());
  const authors = commentAuthorIds.length
    ? await user_model.find({
        _id: { $in: commentAuthorIds.map(id => new Types.ObjectId(id)) }
      }).select('_id name img').lean() as unknown as UserDocument[]
    : [];
  const authorMap = authors.reduce((acc, u) => {
    acc[u._id.toString()] = u;
    return acc;
  }, {} as Record<string, UserDocument>);

  // Reverse to chronological so the preview reads naturally.
  const comments = latest.reverse().map((comment: any) => {
    const author = authorMap[comment.author_id.toString()];
    return {
      _id: comment._id.toString(),
      post_id: comment.post_id.toString(),
      message: comment.message,
      ...(comment.message_filtered && { message_filtered: comment.message_filtered }),
      createdAt: comment.createdAt instanceof Date
        ? comment.createdAt.toISOString()
        : new Date(comment.createdAt).toISOString(),
      updatedAt: comment.updatedAt instanceof Date
        ? comment.updatedAt.toISOString()
        : new Date(comment.updatedAt).toISOString(),
      author: author
        ? { _id: author._id.toString(), name: author.name, img: author.img }
        : { _id: comment.author_id.toString(), name: 'Unknown', img: '' }
    };
  });

  // Match the FeedPost shape your frontend expects
  const { author_id, ...rest } = post as any;
  ctx.body = {
    post: {
      ...rest,
      author: author_id,
      user_reaction: null, // or compute from a reactions lookup if you have one
      comments
    }
  };
});

export default postRouter;
