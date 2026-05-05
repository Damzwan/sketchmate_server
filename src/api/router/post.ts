import Router from 'koa-router';
import { s3Creator } from '../../mongodb';
import { post_comment_model, post_model, post_reaction_model } from '../../models/post.model';
import { requireAuth } from '../../middleware/auth';
import { user_model } from '../../models/user.model';
import { FeedPost } from '../../types/types';
import { CONTAINER } from '../../s3';

const postRouter = new Router();

/**
 * STEP 1: Generate S3 Presigned URLs
 */
postRouter.post('/upload-urls', requireAuth, async (ctx) => {
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

/**
 * STEP 2: Publish the Post
 */
postRouter.post('/publish', requireAuth, async (ctx) => {
  const { drawing_url, image_url, thumbnail_url, aspect_ratio, description } = ctx.request.body;
  const author_id = ctx.state.user._id;

  try {
    const post = await post_model.create({
      author_id,
      drawing_url,
      image_url,
      thumbnail_url,
      aspect_ratio,
      description
    });

    ctx.status = 201;
    ctx.body = { post };
  } catch (error) {
    console.error('Publish error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to publish post' };
  }
});

/**
 * FEED: Paginated and Hydrated
 */
postRouter.get('/feed', requireAuth, async (ctx) => {
  const limit = parseInt(ctx.query.limit as string) || 20;
  const user_id = ctx.state.user._id.toString();

  try {
    // 1. Get user's following list
    const currentUser = await user_model.findById(user_id).select('following').lean();
    const followingIds = currentUser?.following || [];

    let feedPosts: any[] = [];

    // 2. Fetch posts from people the user follows (EXCLUDING self)
    if (followingIds.length > 0) {
      feedPosts = await post_model.find({
        author_id: { $in: followingIds, $ne: user_id },
        status: 'active'
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
    }

    // 3. Fallback/Padding: Global posts (EXCLUDING self and already fetched following)
    if (feedPosts.length < limit) {
      const remainingSlots = limit - feedPosts.length;
      const excludedIds = [...followingIds, user_id];

      const globalPosts = await post_model.find({
        author_id: { $nin: excludedIds },
        status: 'active'
      })
        .sort({ createdAt: -1 })
        .limit(remainingSlots)
        .lean();

      feedPosts = [...feedPosts, ...globalPosts];
    }

    const postIds = feedPosts.map(p => p._id);

    // 4. Batch Hydration: Comments and Reactions
    const [latestCommentsRaw, userReactions] = await Promise.all([
      Promise.all(
        postIds.map(id =>
          post_comment_model.findOne({ post_id: id }).sort({ createdAt: -1 }).lean()
        )
      ),
      post_reaction_model.find({
        user_id,
        post_id: { $in: postIds }
      }).lean()
    ]);

    const validComments = latestCommentsRaw.filter(c => c !== null);

    // Collect all authors (post authors + commenters)
    const postAuthorIds = feedPosts.map(post => post.author_id.toString());
    const commentAuthorIds = validComments.map((c: any) => c.author_id.toString());
    const allUserIdsToFetch = [...new Set([...postAuthorIds, ...commentAuthorIds])];

    const users = await user_model.find({
      _id: { $in: allUserIdsToFetch }
    }).select('_id name img').lean();

    const userMap = users.reduce((acc, user) => {
      acc[user._id.toString()] = user;
      return acc;
    }, {} as Record<string, any>);

    const userReactionMap = userReactions.reduce((acc, rx: any) => {
      acc[rx.post_id.toString()] = rx.reaction_type;
      return acc;
    }, {} as Record<string, string>);

    const commentsByPostId = validComments.reduce((acc, comment: any) => {
      acc[comment.post_id.toString()] = {
        ...comment,
        author: userMap[comment.author_id.toString()] || { name: 'Unknown', img: '' }
      };
      return acc;
    }, {} as Record<string, any>);

    // 5. Final Assembly
    const hydratedFeed: FeedPost[] = feedPosts.map(post => {
      const postIdStr = post._id.toString();
      const latestComment = commentsByPostId[postIdStr];


      return {
        ...post,
        _id: postIdStr,
        author: userMap[post.author_id.toString()] || { name: 'Unknown Sketcher', img: '' },
        reaction_counts: post.reaction_counts || {},
        user_reaction: userReactionMap[postIdStr] || null,
        comments: latestComment ? [latestComment] : [],
        createdAt: post.createdAt instanceof Date ? post.createdAt.toISOString() : post.createdAt,
        updatedAt: post.updatedAt instanceof Date ? post.updatedAt.toISOString() : post.updatedAt
      };
    });

    ctx.status = 200;
    ctx.body = { feed: hydratedFeed };
  } catch (error) {
    console.error('Feed retrieval error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch feed' };
  }
});

/**
 * COMMENTS & REACTIONS
 */
postRouter.post('/:post_id/comment', requireAuth, async (ctx) => {
  const { post_id } = ctx.params;
  const { message } = ctx.request.body;
  const author_id = ctx.state.user._id;

  if (!message?.trim()) {
    ctx.status = 400;
    ctx.body = { error: 'Comment message cannot be empty' };
    return;
  }

  try {
    const post = await post_model.findOne({ _id: post_id, status: 'active' });
    if (!post) {
      ctx.status = 404;
      ctx.body = { error: 'Post not found' };
      return;
    }

    const newComment = await post_comment_model.create({ post_id, author_id, message });
    await post_model.updateOne({ _id: post_id }, { $inc: { comment_count: 1 } });

    ctx.status = 201;
    ctx.body = { comment: newComment };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to post comment' };
  }
});

postRouter.post('/:post_id/react', requireAuth, async (ctx) => {
  const { post_id } = ctx.params;
  const { reaction_type } = ctx.request.body; // e.g., 'fire' or null
  const user_id = ctx.state.user._id.toString();

  try {
    const post = await post_model.findOne({ _id: post_id, status: 'active' });
    if (!post) {
      ctx.status = 404;
      ctx.body = { error: 'Post not found' };
      return;
    }

    const existing = await post_reaction_model.findOne({ post_id, user_id });

    const isRemoving = !reaction_type || (existing && existing.reaction_type === reaction_type);

    if (isRemoving) {
      if (existing) {
        await Promise.all([
          post_reaction_model.deleteOne({ _id: existing._id }),
          post_model.updateOne(
            { _id: post_id },
            { $inc: { [`reaction_counts.${existing.reaction_type}`]: -1 } }
          )
        ]);
      }
      ctx.body = { current_reaction: null };
      return;
    }

    if (existing) {
      await Promise.all([
        post_reaction_model.updateOne({ _id: existing._id }, { reaction_type }),
        post_model.updateOne(
          { _id: post_id },
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
        post_reaction_model.create({ post_id, user_id, reaction_type }),
        post_model.updateOne(
          { _id: post_id },
          { $inc: { [`reaction_counts.${reaction_type}`]: 1 } }
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
    const post = await post_model.findById(post_id);

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
      post_model.deleteOne({ _id: post_id }),
      post_comment_model.deleteMany({ post_id }),
      post_reaction_model.deleteMany({ post_id })
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

/**
 * GET COMMENTS
 */
postRouter.get('/:post_id/comments', requireAuth, async (ctx) => {
  const { post_id } = ctx.params;
  const page = parseInt(ctx.query.page as string) || 1;
  const limit = parseInt(ctx.query.limit as string) || 20;
  const skip = (page - 1) * limit;

  try {
    const comments = await post_comment_model.find({ post_id })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    if (comments.length === 0) {
      ctx.body = { comments: [] };
      return;
    }

    const authorIds = [...new Set(comments.map(c => c.author_id))];
    const authors = await user_model.find({
      _id: { $in: authorIds }
    }).select('_id name img').lean();

    const authorMap = authors.reduce((acc, author) => {
      acc[author._id.toString()] = author;
      return acc;
    }, {} as Record<string, any>);

    const hydratedComments = comments.map(comment => ({
      ...comment,
      author: authorMap[comment.author_id] || { name: 'Unknown', img: '' }
    }));

    ctx.status = 200;
    ctx.body = { comments: hydratedComments };
  } catch (error) {
    console.error('Fetch comments error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch comments' };
  }
});

export default postRouter;