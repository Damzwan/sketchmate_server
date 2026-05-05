import { requireAuth } from '../../middleware/auth';
import { user_model } from '../../models/user.model';
import Router from 'koa-router';
import { post_model, post_reaction_model } from '../../models/post.model';
import { FeedPost } from '../../types/types';
import { s3Creator } from '../../mongodb';
import { CONTAINER } from '../../s3';
import fs from 'fs';

export const userRouter = new Router();


userRouter.put('/follow/:target_id', requireAuth, async (ctx) => {
  const followerId = ctx.state.user._id;
  const targetId = ctx.params.target_id;

  if (followerId === targetId) {
    ctx.status = 400;
    ctx.body = { error: 'You can\'t follow yourself' };
    return;
  }

  // Use a transaction or Promise.all to update both users
  // $addToSet ensures no duplicates if they click twice
  await Promise.all([
    user_model.updateOne({ _id: followerId }, { $addToSet: { following: targetId } }),
    user_model.updateOne({ _id: targetId }, { $addToSet: { followers: followerId } })
  ]);

  ctx.status = 200;
  ctx.body = { success: true };
});
``
/**
 * USER POSTS: Get all active posts for a specific user
 */
userRouter.get('/:user_id/posts', requireAuth, async (ctx) => {
  const { user_id: targetUserId } = ctx.params;
  const viewer_id = ctx.state.user._id.toString();
  const limit = parseInt(ctx.query.limit as string) || 20;
  const page = parseInt(ctx.query.page as string) || 1;
  const skip = (page - 1) * limit;

  try {
    const posts = await post_model.find({
      author_id: targetUserId,
      status: 'active'
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean() as any[]; // Using any here is a safe 'shortcut' for assembled lean results

    if (!posts.length) {
      ctx.body = { posts: [] };
      return;
    }

    const postIds = posts.map(p => p._id.toString());

    const [userReactions, authorInfo] = await Promise.all([
      post_reaction_model.find({
        user_id: viewer_id,
        post_id: { $in: postIds }
      }).lean(),
      user_model.findById(targetUserId).select('_id name img').lean()
    ]);

    const userReactionMap = userReactions.reduce((acc, rx: any) => {
      acc[rx.post_id.toString()] = rx.reaction_type;
      return acc;
    }, {} as Record<string, string>);

    // 3. Final Assembly
    const hydratedPosts: FeedPost[] = posts.map(post => {
      const postIdStr = post._id.toString();

      return {
        _id: postIdStr,
        author_id: post.author_id.toString(),
        author: authorInfo || { _id: targetUserId, name: 'Unknown', img: '' },
        drawing_url: post.drawing_url,
        image_url: post.image_url,
        thumbnail_url: post.thumbnail_url,
        aspect_ratio: post.aspect_ratio,
        description: post.description,
        comment_count: post.comment_count,
        reports_count: post.reports_count,
        status: post.status,
        reaction_counts: post.reaction_counts || {},
        user_reaction: userReactionMap[postIdStr] || null,
        comments: [],
        createdAt: post.createdAt instanceof Date ? post.createdAt.toISOString() : post.createdAt,
        updatedAt: post.updatedAt instanceof Date ? post.updatedAt.toISOString() : post.updatedAt
      };
    });


    ctx.status = 200;
    ctx.body = { posts: hydratedPosts };
  } catch (error) {
    console.error('Fetch user posts error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch user posts' };
  }
});


userRouter.put('/profile', requireAuth, async (ctx) => {
  const { name, description } = ctx.request.body;
  const user_id = ctx.state.user._id;

  try {
    await user_model.updateOne(
      { _id: user_id },
      { $set: { name, description } }
    );
    ctx.status = 200;
    ctx.body = { message: 'Profile updated' };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to update profile' };
  }
});

userRouter.post('/upload-image', requireAuth, async (ctx) => {
  const { _id } = ctx.state.user;
  // Assumes the file is parsed by a middleware like koa-body and available at ctx.request.files
  const file = (ctx.request as any).files?.img;
  const { previousImage } = ctx.request.body;

  if (!file) {
    ctx.status = 400;
    ctx.body = { error: 'No image provided' };
    return;
  }

  try {
    const url = await s3Creator.uploadFile(file.filepath, file.mimetype, CONTAINER.account);

    const updateResult = await user_model.updateOne(
      { _id },
      { $set: { img: url } }
    );

    if (updateResult.matchedCount === 0) {
      throw new Error('User not found');
    }

    if (previousImage && !previousImage.includes('stock')) {
      const oldKey = previousImage.split('/').pop();
      if (oldKey) {
        await s3Creator.deleteBlob(oldKey, CONTAINER.account).catch(console.error);
      }
    }

    await fs.promises.unlink(file.filepath).catch(console.error);

    ctx.status = 200;
    ctx.body = { url };
  } catch (error) {
    if (file?.filepath) await fs.promises.unlink(file.filepath).catch(console.error);
    console.error('Upload error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to upload profile image' };
  }
});