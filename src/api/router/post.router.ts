import Router from 'koa-router';
import { Types } from 'mongoose';
import { s3Creator } from '../../mongodb';
import { post_comment_model, post_model, post_reaction_model } from '../../models/post.model';
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
import { requireCapability } from '../../middleware/moderation.middleware';
import { Capability } from '../../types/moderation.policy';
import { PUBLIC_USER_FIELDS } from '../../types/projections';
import { shapeFeedPost } from '../services/post.service';
import { quota_usage_model } from '../../models/quota_usage.model';
import { startOfUtcDay } from '../../config/quota.config';
import { dispatchNotification } from '../services/notification.service';
import { v4 as uuidv4 } from 'uuid';

const postRouter = new Router();

postRouter.post('/upload-urls', requireAuth, requireCapability(Capability.CREATE_POST), async (ctx) => {
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

postRouter.post('/publish', requireAuth, requireCapability(Capability.CREATE_POST), async (ctx) => {
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
        .select('_id name img')
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
        img: authorDoc.img
      }
      : { _id: ctx.state.user._id.toString(), name: 'Unknown', img: '' };

    const hydrated = shapeFeedPost(leanPost, author, null, []);

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

    await post_model.updateMany(
      { _id: { $in: oids }, status: 'active' },
      { $inc: { views: 1 } }
    );

    ctx.status = 200;
    ctx.body = { success: true };
  } catch (error) {
    console.error('Failed to log views:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to log views' };
  }
});

postRouter.get('/feed', requireAuth, async (ctx) => {
  const limit = parseInt(ctx.query.limit as string) || 20;
  const user_id = ctx.state.user._id.toString();
  const userIdObj = new Types.ObjectId(user_id);

  try {
    const relationships = await relationship_model.find({
      users: userIdObj
    }).lean();

    const followingIds: Types.ObjectId[] = [];
    const blockedIds: Types.ObjectId[] = [];

    for (const rel of relationships) {
      const otherUser = rel.users.find(id => id.toString() !== user_id);
      if (!otherUser) continue;

      const otherUserIdStr = otherUser.toString();

      if (rel.chat_status === 'blocked') {
        blockedIds.push(otherUser as Types.ObjectId);
        continue;
      }

      const isMate = rel.chat_status === 'mate';
      const userFollowsOther = rel.follows?.some(f =>
        f.follower.toString() === user_id &&
        f.followed.toString() === otherUserIdStr
      );

      if (isMate || userFollowsOther) {
        followingIds.push(otherUser as Types.ObjectId);
      }
    }

    let feedPosts: LeanPost[] = [];

    if (followingIds.length > 0) {
      feedPosts = await post_model.find({
        author_id: { $in: followingIds },
        status: 'active'
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean() as unknown as LeanPost[];
    }

    if (feedPosts.length < limit) {
      const remainingSlots = limit - feedPosts.length;
      const excludedAuthorIds = [userIdObj, ...followingIds, ...blockedIds];

      const popLimit = Math.ceil(remainingSlots / 2);
      const newLimit = remainingSlots - popLimit;

      const popularPosts = await post_model.find({
        author_id: { $nin: excludedAuthorIds },
        status: 'active'
      })
        .sort({ views: -1, total_reactions: -1, createdAt: -1 })
        .limit(popLimit)
        .lean() as unknown as LeanPost[];

      const popularPostIds = popularPosts.map(p => p._id);

      const newPosts = await post_model.find({
        author_id: { $nin: excludedAuthorIds },
        _id: { $nin: popularPostIds },
        status: 'active'
      })
        .sort({ createdAt: -1 })
        .limit(newLimit)
        .lean() as unknown as LeanPost[];

      const interleavedGlobal = [];
      const maxLen = Math.max(popularPosts.length, newPosts.length);
      for (let i = 0; i < maxLen; i++) {
        if (popularPosts[i]) interleavedGlobal.push(popularPosts[i]);
        if (newPosts[i]) interleavedGlobal.push(newPosts[i]);
      }

      feedPosts = [...feedPosts, ...interleavedGlobal];
    }

    if (feedPosts.length === 0) {
      ctx.body = { feed: [] };
      return;
    }

    const uniquePostsMap = new Map<string, LeanPost>();
    for (const post of feedPosts) {
      if (!uniquePostsMap.has(post._id.toString())) {
        uniquePostsMap.set(post._id.toString(), post);
      }
    }
    feedPosts = Array.from(uniquePostsMap.values());

    const postIds = feedPosts.map(p => new Types.ObjectId(p._id));

    // Fetch the 2 latest comments per post and user reactions
    const [latestCommentsNested, userReactions] = await Promise.all([
      Promise.all(
        postIds.map(id =>
          post_comment_model.find({
            post_id: id,
            status: { $nin: ['under_review', 'removed'] }
          })
            .sort({ createdAt: -1 }) // get newest first
            .limit(2)
            .lean()
        )
      ),
      post_reaction_model.find({
        user_id: userIdObj,
        post_id: { $in: postIds }
      }).lean()
    ]);

    // Flatten array of arrays
    const validComments = latestCommentsNested.flat().filter(c => c !== null);

    const postAuthorIds = feedPosts.map(post => post.author_id.toString());
    const commentAuthorIds = validComments.map((c: any) => c.author_id.toString());
    const allUserIdsToFetch = [...new Set([...postAuthorIds, ...commentAuthorIds])].map(id => new Types.ObjectId(id));

    const users = await user_model.find({
      _id: { $in: allUserIdsToFetch }
    }).select('_id name img customization').lean() as unknown as UserDocument[];

    const userMap = users.reduce((acc, user) => {
      acc[user._id.toString()] = user;
      return acc;
    }, {} as Record<string, UserDocument>);

    const userReactionMap = userReactions.reduce((acc, rx: any) => {
      acc[rx.post_id.toString()] = rx.reaction_type;
      return acc;
    }, {} as Record<string, string>);

    // Group hydrated comments by Post ID
    const commentsByPostId = validComments.reduce((acc, comment: any) => {
      const author = userMap[comment.author_id.toString()];
      const pid = comment.post_id.toString();

      if (!acc[pid]) acc[pid] = [];

      acc[pid].push({
        _id: comment._id.toString(),
        post_id: pid,
        message: comment.message,
        createdAt: comment.createdAt instanceof Date
          ? comment.createdAt.toISOString()
          : new Date(comment.createdAt).toISOString(),
        updatedAt: comment.updatedAt instanceof Date
          ? comment.updatedAt.toISOString()
          : new Date(comment.updatedAt).toISOString(),
        author: author ? {
          _id: author._id.toString(),
          name: author.name,
          img: author.img
        } : { _id: comment.author_id.toString(), name: 'Unknown', img: '' }
      });
      return acc;
    }, {} as Record<string, HydratedPostComment[]>);

    const hydratedFeed: FeedPost[] = feedPosts.map(post => {
      const postIdStr = post._id.toString();
      const authorIdStr = post.author_id.toString();
      const authorDoc = userMap[authorIdStr];

      const postComments = commentsByPostId[postIdStr] || [];
      // Sort the 2 comments chronologically so the preview looks natural
      postComments.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      return {
        _id: postIdStr,
        author_id: authorIdStr,
        drawing_url: post.drawing_url,
        image_url: post.image_url,
        thumbnail_url: post.thumbnail_url,
        aspect_ratio: post.aspect_ratio,
        description: post.description || '',
        status: post.status || 'active',
        comment_count: post.comment_count || 0,
        reports_count: post.reports_count || 0,
        views: post.views || 0,
        total_reactions: post.total_reactions || 0,
        enable_remix: post.enable_remix ?? true,
        enable_comments: post.enable_comments ?? true,

        author: authorDoc
          ? {
            _id: authorDoc._id.toString(),
            name: authorDoc.name,
            img: authorDoc.img,
            customization: authorDoc.customization
          }
          : { _id: authorIdStr, name: 'Unknown', img: '' },

        reaction_counts: post.reaction_counts instanceof Map
          ? Object.fromEntries(post.reaction_counts)
          : (post.reaction_counts || {}),
        user_reaction: userReactionMap[postIdStr] || null,

        comments: postComments,

        createdAt: post.createdAt instanceof Date
          ? post.createdAt.toISOString()
          : new Date(post.createdAt).toISOString(),
        updatedAt: post.updatedAt instanceof Date
          ? post.updatedAt.toISOString()
          : new Date(post.updatedAt).toISOString()
      };
    });

    ctx.body = { feed: hydratedFeed };
  } catch (error) {
    console.error('Feed Error:', error);
    ctx.throw(500, 'Failed to fetch feed');
  }
});

postRouter.post('/:post_id/comment', requireAuth, requireCapability(Capability.COMMENT_ON_POST), async (ctx) => {
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

    const newComment = await post_comment_model.create({
      post_id: new Types.ObjectId(post_id),
      author_id: new Types.ObjectId(author_id),
      message
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

    await Promise.all([
      post_model.deleteOne({ _id: post._id }),
      post_comment_model.deleteMany({ post_id: post._id }),
      post_reaction_model.deleteMany({ post_id: post._id }),
      user_model.updateOne(
        { _id: post.author_id },
        { $inc: { 'stats.posts': -1 } }
      )
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

    ctx.status = 200;
    ctx.body = { message: 'Post and associated data deleted successfully' };
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

  // Match the FeedPost shape your frontend expects
  const { author_id, ...rest } = post as any;
  ctx.body = {
    post: {
      ...rest,
      author: author_id,
      user_reaction: null, // or compute from a reactions lookup if you have one
      comments: []
    }
  };
});

export default postRouter;