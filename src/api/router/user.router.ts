import fs from 'fs';
import Router from 'koa-router';
import dayjs from 'dayjs';
import { Types } from 'mongoose';
import { requireAuth } from '../../middleware/auth';
import { user_model } from '../../models/user.model';
import { post_model, post_reaction_model } from '../../models/post.model';
import { relationship_model } from '../../models/relationship.model';
import { s3Creator } from '../../mongodb';
import { CONTAINER } from '../../s3';
import { FeedPost } from '../../types/types';
import { LeanPost, RelationshipDocument, UserDocument } from '../../types/mongoose.types';
import { isUserOnline } from '../socket/socket';
import { FULL_USER_FIELDS, PUBLIC_USER_FIELDS } from '../../types/projections';

export const userRouter = new Router();

/**
 * USER POSTS: Get hydrated active posts for a user
 *
 * The author projection here is intentionally minimal (just _id/name/img).
 * The viewer's frontend cache already holds the author's full public
 * customization — populating it here would be redundant bytes.
 */
userRouter.get('/:user_id/posts', requireAuth, async (ctx) => {
  const { user_id: targetUserId } = ctx.params;
  const viewer_id = ctx.state.user._id.toString();
  const limit = Math.min(parseInt(ctx.query.limit as string) || 20, 50);
  const page = Math.max(parseInt(ctx.query.page as string) || 1, 1);
  const skip = (page - 1) * limit;

  try {
    const posts = await post_model
      .find({ author_id: targetUserId, status: 'active' })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean() as LeanPost[];

    if (!posts.length) {
      ctx.body = { posts: [] };
      return;
    }

    const postIds = posts.map((p) => p._id);

    const [userReactions, authorInfo] = await Promise.all([
      post_reaction_model.find({
        user_id: viewer_id,
        post_id: { $in: postIds }
      }).lean(),
      user_model.findById(targetUserId).select('_id name img').lean() as Promise<UserDocument | null>
    ]);

    const userReactionMap = userReactions.reduce((acc, rx) => {
      acc[rx.post_id.toString()] = rx.reaction_type;
      return acc;
    }, {} as Record<string, string>);

    const author = authorInfo ? {
      _id: authorInfo._id.toString(),
      name: authorInfo.name,
      img: authorInfo.img
    } : { _id: targetUserId, name: 'Unknown', img: '' };

    const hydratedPosts: FeedPost[] = posts.map((post) => {
      const postIdStr = post._id.toString();
      const authorIdStr = post.author_id.toString();

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
        author,
        user_reaction: userReactionMap[postIdStr] || null,
        reaction_counts: post.reaction_counts instanceof Map
          ? Object.fromEntries(post.reaction_counts)
          : post.reaction_counts || {},
        comments: [],
        createdAt: new Date(post.createdAt).toISOString(),
        updatedAt: new Date(post.updatedAt).toISOString()
      };
    });

    ctx.body = { posts: hydratedPosts };
  } catch (error) {
    console.error('Fetch user posts error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch user posts' };
  }
});

/**
 * UPDATE PROFILE: Handle name changes, bio, and customization
 */
const NAME_CHANGE_COOLDOWN_DAYS = 31;
userRouter.put('/profile', requireAuth, async (ctx) => {
  const { name, description, customization, subscription_tier } = ctx.request.body;
  const user_id = ctx.state.user._id;

  const user = await user_model.findById(user_id) as UserDocument | null;
  if (!user) return ctx.throw(404, 'User not found');

  const updateData: any = {};

  if (subscription_tier && ['free', 'pro'].includes(subscription_tier)) {
    updateData.subscription_tier = subscription_tier;
  }

  if (name && name !== user.name) {
    const isPro = user.subscription_tier === 'pro';
    const daysSinceChange = user.last_name_change
      ? dayjs().diff(dayjs(user.last_name_change), 'day')
      : 999;

    if (!isPro && daysSinceChange < NAME_CHANGE_COOLDOWN_DAYS) {
      ctx.status = 403;
      ctx.body = {
        error: 'Name change locked',
        daysLeft: NAME_CHANGE_COOLDOWN_DAYS - daysSinceChange
      };
      return;
    }
    updateData.name = name;
    updateData.last_name_change = new Date();
  }

  if (description !== undefined) updateData.description = description;

  if (customization) {
    Object.keys(customization).forEach(key => {
      updateData[`customization.${key}`] = customization[key];
    });
  }

  if (Object.keys(updateData).length === 0) {
    ctx.body = { message: 'No changes to update' };
    return;
  }

  await user_model.updateOne({ _id: user_id }, { $set: updateData });
  ctx.body = { message: 'Profile updated' };
});

/**
 * UPLOAD IMAGE: Profile picture handling
 */
userRouter.post('/upload-image', requireAuth, async (ctx) => {
  const { _id } = ctx.state.user;
  const file = (ctx.request as any).files?.img;
  const { previousImage } = ctx.request.body;

  if (!file) return ctx.throw(400, 'No image provided');

  try {
    const url = await s3Creator.uploadFile(file.filepath, file.mimetype, CONTAINER.account);
    await user_model.updateOne({ _id }, { $set: { img: url } });

    if (previousImage && !previousImage.includes('stock')) {
      const oldKey = previousImage.split('/').pop();
      if (oldKey) await s3Creator.deleteBlob(oldKey, CONTAINER.account).catch(console.error);
    }

    await fs.promises.unlink(file.filepath).catch(console.error);
    ctx.body = { url };
  } catch (error) {
    if (file?.filepath) await fs.promises.unlink(file.filepath).catch(console.error);
    ctx.throw(500, 'Failed to upload profile image');
  }
});

/**
 * PROFILE VIEW: Aggregate stats and relationship status
 *
 * Now uses FULL_USER_FIELDS so the profile modal receives the user's
 * signature and full customization. This is the ONE endpoint where the
 * signature ships — list endpoints stay lean with PUBLIC_USER_FIELDS only.
 */
userRouter.get('/:user_id/profile', requireAuth, async (ctx) => {
  const { user_id: targetId } = ctx.params;
  const viewer_id = ctx.state.user._id.toString();

  try {
    const sortedUsers = [viewer_id, targetId].sort();

    const [
      user,
      connection,
      posts
    ] = await Promise.all([
      // Use FULL_USER_FIELDS so the response includes signature + description
      user_model.findById(targetId).select(FULL_USER_FIELDS).lean() as Promise<UserDocument | null>,
      relationship_model.findOne({ users: sortedUsers }).lean() as Promise<RelationshipDocument | null>,
      post_model.find({
        author_id: targetId,
        status: 'active'
      }).sort({ createdAt: -1 }).limit(9).lean() as Promise<LeanPost[]>
    ]);

    if (!user) return ctx.throw(404, 'User not found');

    const postIds = posts.map(p => p._id);
    const userReactions = await post_reaction_model.find({
      user_id: viewer_id,
      post_id: { $in: postIds }
    }).lean();

    const userReactionMap = userReactions.reduce((acc, rx) => {
      acc[rx.post_id.toString()] = rx.reaction_type;
      return acc;
    }, {} as Record<string, string>);

    const hydratedPosts: FeedPost[] = posts.map(post => {
      const postIdStr = post._id.toString();
      return {
        _id: postIdStr,
        author_id: post.author_id.toString(),
        drawing_url: post.drawing_url,
        image_url: post.image_url,
        thumbnail_url: post.thumbnail_url,
        aspect_ratio: post.aspect_ratio,
        description: post.description || '',
        status: post.status || 'active',
        comment_count: post.comment_count || 0,
        reports_count: post.reports_count || 0,
        author: { _id: user._id.toString(), name: user.name, img: user.img },
        user_reaction: userReactionMap[postIdStr] || null,
        reaction_counts: post.reaction_counts instanceof Map
          ? Object.fromEntries(post.reaction_counts)
          : post.reaction_counts || {},
        comments: [],
        createdAt: new Date(post.createdAt).toISOString(),
        updatedAt: new Date(post.updatedAt).toISOString()
      };
    });

    ctx.body = {
      profile: {
        _id: user._id.toString(),
        name: user.name,
        description: user.description || '',
        img: user.img,
        last_seen_version: user.last_seen_version,
        // Customization (full, with signature) — frontend ProfileCard
        // expects this nested object exactly as stored
        customization: user.customization || {},
        // Stats sourced directly from the User document
        stats: user.stats || { followers: 0, following: 0, mates: 0, posts: 0 },
        chat_status: connection?.chat_status || 'none',
        relationship: {
          isFollowing: connection?.follows?.some(f => f.follower.toString() === viewer_id) || false,
          areFollowingMe: connection?.follows?.some(f => f.followed.toString() === viewer_id) || false
        }
      },
      posts: hydratedPosts
    };
  } catch (error) {
    console.error('Profile fetch error:', error);
    ctx.throw(500, 'Internal Server Error');
  }
});

/**
 * ONLINE FRIENDS: list of currently-online mates
 *
 * Projection updated to include public customization so online friends
 * render with their decorations/titles without an extra cache fill.
 */
userRouter.get('/online-friends', requireAuth, async (ctx) => {
  const viewerId = ctx.state.user._id.toString();
  const io = ctx.app.context.io;

  const relationships = await relationship_model.find({
    users: new Types.ObjectId(viewerId),
    chat_status: { $in: ['temporary', 'pending_mate', 'mate'] }
  }).lean();

  if (!relationships.length) {
    ctx.body = [];
    return;
  }

  const partnerIds = relationships.map(rel =>
    rel.users.find(id => id.toString() !== viewerId)?.toString()
  ).filter(Boolean) as string[];

  const onlineFlags = await Promise.all(partnerIds.map(id => isUserOnline(io, id)));
  const onlineIds = partnerIds.filter((_, i) => onlineFlags[i]);

  if (!onlineIds.length) {
    ctx.body = [];
    return;
  }

  // Public projection — includes lightweight customization + stats
  const users = await user_model
    .find({ _id: { $in: onlineIds } })
    .select(PUBLIC_USER_FIELDS)
    .lean();

  const relByPartnerId = new Map(
    relationships.map(rel => {
      const partnerId = rel.users.find(id => id.toString() !== viewerId)?.toString();
      return [partnerId, rel];
    })
  );

  ctx.body = users.map(u => {
    const rel = relByPartnerId.get(u._id.toString());
    return {
      ...u,
      _id: u._id.toString(),
      chat_status: rel?.chat_status ?? 'none'
    };
  });
});


userRouter.get('/public_users', requireAuth, async (ctx) => {
  const _ids = (ctx.query._ids as string) || '';

  if (!_ids) {
    ctx.body = [];
    return;
  }

  const safeIds = _ids
    .split(',')
    .slice(0, 100)
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));

  if (!safeIds.length) {
    ctx.body = [];
    return;
  }

  const users = await user_model
    .find({ _id: { $in: safeIds } })
    .select(PUBLIC_USER_FIELDS)
    .lean();

  ctx.body = users;
});