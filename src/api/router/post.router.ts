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

const postRouter = new Router();

postRouter.post('/upload-urls', requireAuth, requireCapability(Capability.CREATE_POST), async (ctx) => {
  try {
    const [drawingUrls, imageUrls, thumbnailUrls] = await Promise.all([
      s3Creator.getPresignedUploadUrl('application/gzip'),
      s3Creator.getPresignedUploadUrl('image/webp'),
      s3Creator.getPresignedUploadUrl('image/webp')
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
  const { drawing_url, image_url, thumbnail_url, aspect_ratio, description } = ctx.request.body;
  const author_id = ctx.state.user._id;

  try {
    const authorObjectId = new Types.ObjectId(author_id);

    const post = await post_model.create({
      author_id: authorObjectId,
      drawing_url,
      image_url,
      thumbnail_url,
      aspect_ratio,
      description
    }) as PostDocument;

    await user_model.updateOne(
      { _id: authorObjectId },
      { $inc: { 'stats.posts': 1 } }
    );

    ctx.status = 201;
    ctx.body = { post: post.toObject() };
  } catch (error) {
    console.error('Publish error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to publish post' };
  }
});

/**
 * NEW: BATCHED VIEW TRACKING
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
    // Cap at 50 IDs per request to prevent abuse of the endpoint
    const oids = post_ids.slice(0, 50).map(id => new Types.ObjectId(id));

    // Bulk increment views for all provided IDs in a single operation
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

    // Priority 1: Mates and Following
    if (followingIds.length > 0) {
      feedPosts = await post_model.find({
        author_id: { $in: followingIds },
        status: 'active'
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean() as unknown as LeanPost[];
    }

    // Priority 2: Global Fallback Algorithm (Interleaved Popular + New)
    if (feedPosts.length < limit) {
      const remainingSlots = limit - feedPosts.length;
      const excludedIds = [userIdObj, ...followingIds, ...blockedIds];

      const popLimit = Math.ceil(remainingSlots / 2); // 50% Popular
      const newLimit = remainingSlots - popLimit;     // 50% New

      // 1. Fetch Popular Posts
      const popularPosts = await post_model.find({
        author_id: { $nin: excludedIds },
        status: 'active'
      })
        // Sort by engagement metrics
        .sort({ views: -1, total_reactions: -1, createdAt: -1 })
        .limit(popLimit)
        .lean() as unknown as LeanPost[];

      // Prevent the "New" query from fetching posts we just got in "Popular"
      const popularIds = popularPosts.map(p => new Types.ObjectId(p._id));
      const combinedExcluded = [...excludedIds, ...popularIds];

      // 2. Fetch New Posts
      const newPosts = await post_model.find({
        author_id: { $nin: combinedExcluded },
        status: 'active'
      })
        .sort({ createdAt: -1 })
        .limit(newLimit)
        .lean() as unknown as LeanPost[];

      // 3. Interleave them (Popular, New, Popular, New...)
      const interleavedGlobal = [];
      const maxLen = Math.max(popularPosts.length, newPosts.length);
      for(let i = 0; i < maxLen; i++) {
        if (popularPosts[i]) interleavedGlobal.push(popularPosts[i]);
        if (newPosts[i]) interleavedGlobal.push(newPosts[i]);
      }

      feedPosts = [...feedPosts, ...interleavedGlobal];
    }

    if (feedPosts.length === 0) {
      ctx.body = { feed: [] };
      return;
    }

    const postIds = feedPosts.map(p => new Types.ObjectId(p._id));

    const [latestCommentsRaw, userReactions] = await Promise.all([
      Promise.all(
        postIds.map(id =>
          post_comment_model.findOne({
            post_id: id,
            status: 'active'
          }).sort({ createdAt: -1 }).lean()
        )
      ),
      post_reaction_model.find({
        user_id: userIdObj,
        post_id: { $in: postIds }
      }).lean()
    ]);

    const validComments = latestCommentsRaw.filter(c => c !== null);
    const postAuthorIds = feedPosts.map(post => post.author_id.toString());
    const commentAuthorIds = validComments.map((c: any) => c.author_id.toString());
    const allUserIdsToFetch = [...new Set([...postAuthorIds, ...commentAuthorIds])].map(id => new Types.ObjectId(id));

    const users = await user_model.find({
      _id: { $in: allUserIdsToFetch }
    }).select('_id name img').lean() as unknown as UserDocument[];

    const userMap = users.reduce((acc, user) => {
      acc[user._id.toString()] = user;
      return acc;
    }, {} as Record<string, UserDocument>);

    const userReactionMap = userReactions.reduce((acc, rx: any) => {
      acc[rx.post_id.toString()] = rx.reaction_type;
      return acc;
    }, {} as Record<string, string>);

    const commentsByPostId = validComments.reduce((acc, comment: any) => {
      const author = userMap[comment.author_id.toString()];

      acc[comment.post_id.toString()] = {
        _id: comment._id.toString(),
        post_id: comment.post_id.toString(),
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
      };
      return acc;
    }, {} as Record<string, HydratedPostComment>);

    const hydratedFeed: FeedPost[] = feedPosts.map(post => {
      const postIdStr = post._id.toString();
      const authorIdStr = post.author_id.toString();
      const authorDoc = userMap[authorIdStr];
      const latestComment = commentsByPostId[postIdStr];

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

        author: authorDoc
          ? { _id: authorDoc._id.toString(), name: authorDoc.name, img: authorDoc.img }
          : { _id: authorIdStr, name: 'Unknown', img: '' },

        reaction_counts: post.reaction_counts instanceof Map
          ? Object.fromEntries(post.reaction_counts)
          : (post.reaction_counts || {}),
        user_reaction: userReactionMap[postIdStr] || null,

        comments: latestComment ? [latestComment] : [],

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

    ctx.status = 201;
    ctx.body = { comment: newComment.toObject() };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to post comment' };
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
                total_reactions: -1 // Decrement aggregate score
              }
            }
          )
        ]);
      }
      ctx.body = { current_reaction: null };
      return;
    }

    if (existing) {
      // Swapping reaction: total_reactions stays the same, just adjust map counts
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
      // New reaction: increment both specific counter and aggregate score
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
  const page = parseInt(ctx.query.page as string) || 1;
  const limit = parseInt(ctx.query.limit as string) || 20;
  const skip = (page - 1) * limit;

  try {
    const comments = await post_comment_model.find({
      post_id: new Types.ObjectId(post_id),
      status: 'active'
    })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean() as any[];

    if (comments.length === 0) {
      ctx.body = { comments: [] };
      return;
    }

    const authorIds = [...new Set(comments.map(c => c.author_id.toString()))].map(id => new Types.ObjectId(id));

    const authors = await user_model.find({
      _id: { $in: authorIds }
    }).select('_id name img').lean() as unknown as UserDocument[];

    const authorMap = authors.reduce((acc, author) => {
      acc[author._id.toString()] = author;
      return acc;
    }, {} as Record<string, UserDocument>);

    const hydratedComments: BasePostComment[] = comments.map(comment => {
      const author = authorMap[comment.author_id.toString()];
      return {
        ...comment,
        _id: comment._id.toString(),
        post_id: comment.post_id.toString(),
        createdAt: comment.createdAt instanceof Date ? comment.createdAt.toISOString() : comment.createdAt,
        author: author
          ? { _id: author._id.toString(), name: author.name, img: author.img }
          : { _id: comment.author_id.toString(), name: 'Unknown', img: '' }
      };
    });

    ctx.status = 200;
    ctx.body = { comments: hydratedComments };
  } catch (error) {
    console.error('Fetch comments error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch comments' };
  }
});

export default postRouter;