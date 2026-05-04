import Router from 'koa-router';
import { s3Creator } from '../../mongodb';
import { post_comment_model, post_model } from '../../models/post.model';
import { requireAuth } from '../../middleware/auth';
import { user_model } from '../../models/user.model';

const postRouter = new Router();

/**
 * STEP 1: Generate S3 Presigned URLs
 * This allows the client to upload directly to S3.
 */
postRouter.post('/upload-urls', requireAuth, async (ctx) => {
  try {
    // Firing all three URL generations concurrently
    const [drawingUrls, imageUrls, thumbnailUrls] = await Promise.all([
      s3Creator.getPresignedUploadUrl('application/gzip'), // Updated for Gzipped JSON
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
 * Called after the client successfully uploads files to S3.
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
 * FEED: Get personalized/global feed
 * Uses hydration to attach author metadata efficiently.
 */
postRouter.get('/feed', requireAuth, async (ctx) => {
  const limit = parseInt(ctx.query.limit as string) || 20;
  const user_id = ctx.state.user._id;

  try {
    // 1. Get user's following list
    const currentUser = await user_model.findById(user_id).select('following').lean();
    const followingIds = currentUser?.following || [];

    let feedPosts: any[] = [];

    // 2. Fetch posts from people the user follows
    if (followingIds.length > 0) {
      feedPosts = await post_model.find({
        author_id: { $in: followingIds },
        status: 'active'
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
    }

    // 3. Fallback/Padding: Global posts if feed is small
    if (feedPosts.length < limit) {
      const remainingSlots = limit - feedPosts.length;
      const globalPosts = await post_model.find({
        author_id: { $nin: [...followingIds, user_id] },
        status: 'active'
      })
        .sort({ createdAt: -1 })
        .limit(remainingSlots)
        .lean();

      feedPosts = [...feedPosts, ...globalPosts];
    }

    // --- NEW: Fetch the latest comment for each post ---
    const postIds = feedPosts.map(p => p._id);

    // Promise.all runs these queries simultaneously
    const latestCommentsRaw = await Promise.all(
      postIds.map(id =>
        post_comment_model.findOne({ post_id: id })
          .sort({ createdAt: -1 })
          .lean()
      )
    );
    // Filter out nulls (posts with no comments)
    const validComments = latestCommentsRaw.filter(c => c !== null);


    // 4. Hydration: Batch fetch author AND commenter profile info
    const postAuthorIds = feedPosts.map(post => post.author_id.toString());
    const commentAuthorIds = validComments.map((c: any) => c.author_id.toString());

    // Combine IDs and remove duplicates
    const allUserIdsToFetch = [...new Set([...postAuthorIds, ...commentAuthorIds])];

    // Fetch all needed users in ONE query
    const users = await user_model.find({
      _id: { $in: allUserIdsToFetch }
    }).select('_id name img').lean();

    // Map users for O(1) lookup
    const userMap = users.reduce((acc, user) => {
      acc[user._id.toString()] = user;
      return acc;
    }, {} as Record<string, any>);


    // 5. Assembly
    // First, hydrate the comments with their authors
    const commentsByPostId = validComments.reduce((acc, comment: any) => {
      acc[comment.post_id.toString()] = {
        ...comment,
        author: userMap[comment.author_id.toString()] || { name: 'Unknown', img: '' }
      };
      return acc;
    }, {} as Record<string, any>);

    // Second, attach authors and comments to the posts
    const hydratedFeed = feedPosts.map(post => {
      const latestComment = commentsByPostId[post._id.toString()];

      return {
        ...post,
        author: userMap[post.author_id.toString()] || { name: 'Unknown Sketcher', img: '' },
        // We pass it as an array so your frontend logic `(currItem.comments || []).slice(0,4)` works seamlessly!
        comments: latestComment ? [latestComment] : []
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
 * COMMENTS: Add a comment to a post
 */
postRouter.post('/:post_id/comment', requireAuth, async (ctx) => {
  const { post_id } = ctx.params;
  const { message } = ctx.request.body;
  const author_id = ctx.state.user._id;

  if (!message || message.trim() === '') {
    ctx.status = 400;
    ctx.body = { error: 'Comment message cannot be empty' };
    return;
  }

  try {
    const post = await post_model.findOne({ _id: post_id, status: 'active' });
    if (!post) {
      ctx.status = 404;
      ctx.body = { error: 'Post not found or unavailable' };
      return;
    }

    const newComment = await post_comment_model.create({
      post_id,
      author_id,
      message
    });

    // Update post metadata
    await post_model.updateOne(
      { _id: post_id },
      { $inc: { comment_count: 1 } }
    );

    ctx.status = 201;
    ctx.body = { comment: newComment };
  } catch (error) {
    console.error('Comment error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to post comment' };
  }
});

/**
 * GET COMMENTS: Paginated comments for a post
 */
/**
 * GET COMMENTS: Hydrated and Paginated
 */
postRouter.get('/:post_id/comments', requireAuth, async (ctx) => {
  const { post_id } = ctx.params;
  const page = parseInt(ctx.query.page as string) || 1;
  const limit = parseInt(ctx.query.limit as string) || 20;
  const skip = (page - 1) * limit;

  try {
    // 1. Fetch raw comments
    const comments = await post_comment_model.find({ post_id })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    if (comments.length === 0) {
      ctx.body = { comments: [] };
      return;
    }

    // 2. Hydrate Commenters
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