import fs from 'fs';
import Router from 'koa-router';
import dayjs from 'dayjs';
import { requireAuth } from '../../middleware/auth';
import { user_model } from '../../models/user.model';
import { post_model, post_reaction_model } from '../../models/post.model';
import { conversation_model } from '../../models/conversation.model';
import { s3Creator } from '../../mongodb';
import { CONTAINER } from '../../s3';
import { FeedPost } from '../../types/types';
import { isUserOnline } from '../socket/socket';

export const userRouter = new Router();

/**
 * FOLLOW USER: Update both follower and target
 */
userRouter.put('/follow/:target_id', requireAuth, async (ctx) => {
  const followerId = ctx.state.user._id;
  const targetId = ctx.params.target_id;

  if (followerId === targetId) {
    ctx.status = 400;
    ctx.body = { error: 'You can\'t follow yourself' };
    return;
  }

  // Use Promise.all to update both users; $addToSet ensures no duplicates
  await Promise.all([
    user_model.updateOne({ _id: followerId }, { $addToSet: { following: targetId } }),
    user_model.updateOne({ _id: targetId }, { $addToSet: { followers: followerId } })
  ]);

  ctx.status = 200;
  ctx.body = { success: true };
});

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
    const posts = (await post_model
      .find({ author_id: targetUserId, status: 'active' })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()) as any[];

    if (!posts.length) {
      ctx.body = { posts: [] };
      return;
    }

    const postIds = posts.map((p) => p._id.toString());

    const [userReactions, authorInfo] = await Promise.all([
      post_reaction_model
        .find({
          user_id: viewer_id,
          post_id: { $in: postIds }
        })
        .lean(),
      user_model.findById(targetUserId).select('_id name img').lean()
    ]);

    const userReactionMap = userReactions.reduce((acc, rx: any) => {
      acc[rx.post_id.toString()] = rx.reaction_type;
      return acc;
    }, {} as Record<string, string>);

    const formattedAuthor = authorInfo
      ? {
        _id: authorInfo._id.toString(),
        name: authorInfo.name,
        img: authorInfo.img
      }
      : {
        _id: targetUserId,
        name: 'Unknown',
        img: ''
      };

    const hydratedPosts: FeedPost[] = posts.map((post) => {
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

/**
 * UPDATE PROFILE: Name and description
 */
userRouter.put('/profile', requireAuth, async (ctx) => {
  const { name, description } = ctx.request.body;
  const user_id = ctx.state.user._id;

  try {
    await user_model.updateOne({ _id: user_id }, { $set: { name, description } });
    ctx.status = 200;
    ctx.body = { message: 'Profile updated' };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to update profile' };
  }
});

/**
 * UPLOAD IMAGE: Upload to S3 and update user profile
 */
userRouter.post('/upload-image', requireAuth, async (ctx) => {
  const { _id } = ctx.state.user;
  const file = (ctx.request as any).files?.img;
  const { previousImage } = ctx.request.body;

  if (!file) {
    ctx.status = 400;
    ctx.body = { error: 'No image provided' };
    return;
  }

  try {
    const url = await s3Creator.uploadFile(file.filepath, file.mimetype, CONTAINER.account);
    const updateResult = await user_model.updateOne({ _id }, { $set: { img: url } });

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
  const current_user_id = ctx.state.user._id;
  const { block_id } = ctx.request.body;

  if (!block_id) {
    return ctx.throw(400, 'block_id is required');
  }

  await user_model.findByIdAndUpdate(current_user_id, {
    $addToSet: { blocked_users: block_id },
    $pull: {
      friends: block_id,
      mates: block_id
    }
  });

  await user_model.findByIdAndUpdate(block_id, {
    $pull: {
      friends: current_user_id,
      mates: current_user_id
    }
  });

  ctx.status = 200;
  ctx.body = { success: true, message: 'User blocked successfully' };
});

userRouter.post('/unblock', requireAuth, async (ctx) => {
  const current_user_id = ctx.state.user._id;
  const { block_id } = ctx.request.body;

  if (!block_id) {
    return ctx.throw(400, 'block_id is required');
  }

  try {
    const updateResult = await user_model.findByIdAndUpdate(
      current_user_id,
      {
        $pull: { blocked_users: block_id }
      },
      { new: true } // Returns the updated document
    );

    if (!updateResult) {
      ctx.status = 404;
      ctx.body = { error: 'User not found' };
      return;
    }

    ctx.status = 200;
    ctx.body = {
      success: true,
      message: 'User unblocked successfully',
      blocked_users: updateResult.blocked_users
    };
  } catch (error) {
    console.error('Unblock error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to unblock user' };
  }
});

/**
 * ONLINE FRIENDS: Get list of IDs for currently online friends/mates
 */
userRouter.get('/online-friends', requireAuth, async (ctx) => {
  const user_id = ctx.state.user._id.toString();

  const [user, activeConversations] = await Promise.all([
    user_model.findById(user_id, { friends: 1, mates: 1 }).lean(),
    conversation_model
      .find({
        participants: user_id,
        status: { $in: ['active', 'temporary', 'mate_pending', 'expired'] }
      })
      .select('participants')
      .lean()
  ]);

  if (!user) return ctx.throw(404);

  const partnerIdSet = new Set<string>();

  if (user.friends) user.friends.forEach((id) => partnerIdSet.add(id.toString()));
  if (user.mates) {
    user.mates.forEach((m: any) => {
      const mId = typeof m === 'string' ? m : m._id.toString();
      partnerIdSet.add(mId);
    });
  }

  activeConversations.forEach((convo) => {
    convo.participants.forEach((p) => {
      const pId = p.toString();
      if (pId !== user_id) partnerIdSet.add(pId);
    });
  });

  const partnerIds = Array.from(partnerIdSet);
  const onlineStatusResults = await Promise.all(
    partnerIds.map(async (friendId) => {
      const online = await isUserOnline(ctx.app.context.io, friendId);
      return online ? friendId : null;
    })
  );

  const onlineIds = onlineStatusResults.filter((id): id is string => id !== null);

  ctx.status = 200;
  ctx.body = onlineIds;
});

/**
 * PROFILE VIEW: Get public profile data and post preview
 */
userRouter.get('/:user_id/profile', requireAuth, async (ctx) => {
  const { user_id: targetId } = ctx.params;
  const viewer_id = ctx.state.user._id.toString();

  try {
    // 1. Fetch the user profile data
    const user = await user_model.findById(targetId).lean();
    if (!user) {
      ctx.status = 404;
      ctx.body = { error: 'User not found' };
      return;
    }

    // 2. Fetch the posts for this user
    const posts = await post_model
      .find({ author_id: targetId, status: 'active' })
      .sort({ createdAt: -1 })
      .limit(9)
      .lean() as any[];

    // 3. Prepare the common author object for all posts
    const formattedAuthor = {
      _id: user._id.toString(),
      name: user.name,
      img: user.img
    };

    // 4. Gather post IDs for batch hydration (Reactions)
    const postIds = posts.map(p => p._id);
    const userReactions = await post_reaction_model.find({
      user_id: viewer_id,
      post_id: { $in: postIds }
    }).lean();

    const userReactionMap = userReactions.reduce((acc, rx: any) => {
      acc[rx.post_id.toString()] = rx.reaction_type;
      return acc;
    }, {} as Record<string, string>);

    // 5. Hydrate the posts with author info and viewer reactions
    const hydratedPosts: FeedPost[] = posts.map(post => {
      const postIdStr = post._id.toString();
      return {
        ...post,
        _id: postIdStr,
        author: formattedAuthor, // Reusing the profile user data
        user_reaction: userReactionMap[postIdStr] || null,
        reaction_counts: post.reaction_counts || {},
        comments: [], // As requested, first comment is not important here
        createdAt: post.createdAt instanceof Date ? post.createdAt.toISOString() : post.createdAt,
        updatedAt: post.updatedAt instanceof Date ? post.updatedAt.toISOString() : post.updatedAt
      };
    });

    const stats = {
      followers: user.followers?.length || 0,
      following: user.following?.length || 0,
      friends: user.friends?.length || 0,
      posts: await post_model.countDocuments({ author_id: targetId, status: 'active' })
    };

    const relationship = {
      isFollowing: user.followers?.some((id) => id.toString() === viewer_id),
      isFriend: user.friends?.some((id) => id.toString() === viewer_id)
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
      posts: hydratedPosts
    };
  } catch (error) {
    console.error('Fetch profile error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch profile' };
  }
});

/**
 * UNFRIEND: Remove friendship and expire conversation
 */
userRouter.put('/unfriend/:target_id', requireAuth, async (ctx) => {
  const current_user_id = ctx.state.user._id.toString();
  const target_id = ctx.params.target_id;
  const io = ctx.app.context.io;

  try {
    await Promise.all([
      user_model.updateOne({ _id: current_user_id }, { $pull: { friends: target_id } }),
      user_model.updateOne({ _id: target_id }, { $pull: { friends: current_user_id } })
    ]);

    const cooldownDate = dayjs().add(48, 'hours').toDate();
    const autoDeleteDate = dayjs().add(30, 'days').toDate();

    const updateQuery = {
      status: 'expired',
      trial_expires_at: new Date(),
      cooldown_until: cooldownDate,
      deleted_at: autoDeleteDate,
      initiator_id: undefined
    };

    await conversation_model.updateOne(
      { participants: { $all: [current_user_id, target_id] } },
      { $set: updateQuery }
    );

    const updatedConvo = await conversation_model
      .findOne({ participants: { $all: [current_user_id, target_id] } })
      .populate('participants', 'name img _id')
      .lean();

    if (io && target_id) {
      io.to(target_id).emit('chat:mate_unfriended', {
        conversation_id: updatedConvo?._id,
        conversation: updatedConvo,
        unfriended_by: current_user_id
      });
    }

    ctx.status = 200;
    ctx.body = {
      success: true,
      conversation: updatedConvo,
      cooldown_until: cooldownDate
    };
  } catch (error) {
    console.error('Unfriend error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to unfriend' };
  }
});