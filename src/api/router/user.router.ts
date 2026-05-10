import { requireAuth } from '../../middleware/auth';
import { user_model } from '../../models/user.model';
import Router from 'koa-router';
import { post_model, post_reaction_model } from '../../models/post.model';
import { FeedPost } from '../../types/types';
import { s3Creator } from '../../mongodb';
import { CONTAINER } from '../../s3';
import fs from 'fs';
import { conversation_model } from '../../models/conversation.model';
import { isUserOnline } from '../socket/socket';

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
``;
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

    const formattedAuthor = authorInfo ? {
      _id: authorInfo._id.toString(),
      name: authorInfo.name,
      img: authorInfo.img
    } : {
      _id: targetUserId,
      name: 'Unknown',
      img: ''
    };

    const hydratedPosts: FeedPost[] = posts.map(post => {
      const postIdStr = post._id.toString();

      return {
        _id: postIdStr,
        author_id: post.author_id.toString(),
        author: formattedAuthor,
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


userRouter.post('/block', requireAuth, async (ctx) => {
  const current_user_id = ctx.state.user._id; // Assuming auth middleware
  const { block_id } = ctx.request.body;

  if (!block_id) {
    return ctx.throw(400, 'block_id is required');
  }

  await user_model.findByIdAndUpdate(current_user_id, {
    $addToSet: { blocked_users: block_id }
  });

  await user_model.findByIdAndUpdate(current_user_id, {
    $pull: {
      friends: block_id,
      // If using legacy string array for mates:
      mates: block_id
    }
  });

  await conversation_model.updateMany(
    { participants: { $all: [current_user_id, block_id] } },
    { status: 'blocked' }
  );

  ctx.status = 200;
  ctx.body = { success: true, message: 'User blocked successfully' };
});

userRouter.get('/online-friends', requireAuth, async (ctx) => {
  const user_id = ctx.state.user._id;

  const user = await user_model.findById(user_id).lean();
  if (!user) return ctx.throw(404);

  // Combine new friends and legacy mates
  const friendsToCheck = [
    ...(user.friends || [])
  ].map(id => id.toString());

  // Use Promise.all to check all friends in parallel
  const onlineStatusResults = await Promise.all(
    friendsToCheck.map(async (friendId) => {
      const online = await isUserOnline(ctx.app.context.io, friendId);
      return online ? friendId : null;
    })
  );

  // Filter out the nulls (offline users)
  const onlineIds = onlineStatusResults.filter((id): id is string => id !== null);

  ctx.status = 200;
  ctx.body = onlineIds;
});

userRouter.get('/:user_id/profile', requireAuth, async (ctx) => {
  const { user_id: targetId } = ctx.params;
  const viewer_id = ctx.state.user._id.toString();

  try {
    const user = await user_model.findById(targetId).lean();
    if (!user) {
      ctx.status = 404;
      ctx.body = { error: 'User not found' };
      return;
    }

    // Get the first few posts for the profile grid preview
    const posts = await post_model.find({
      author_id: targetId,
      status: 'active'
    })
      .sort({ createdAt: -1 })
      .limit(9)
      .select('_id thumbnail_url image_url aspect_ratio')
      .lean();

    const stats = {
      followers: user.followers?.length || 0,
      following: user.following?.length || 0,
      friends: user.friends?.length || 0,
      posts: await post_model.countDocuments({ author_id: targetId, status: 'active' })
    };

    const relationship = {
      isFollowing: user.followers?.some(id => id.toString() === viewer_id),
      isFriend: user.friends?.some(id => id.toString() === viewer_id)
    };

    ctx.status = 200;
    ctx.body = {
      profile: {
        _id: user._id,
        name: user.name,
        description: user.description || '',
        img: user.img,
        stats,
        relationship
      },
      posts: posts.map(p => ({
        _id: p._id.toString(),
        thumbnail_url: p.thumbnail_url || p.image_url,
        aspect_ratio: p.aspect_ratio
      }))
    };
  } catch (error) {
    console.error('Fetch profile error:', error);
    ctx.status = 500;
  }
});