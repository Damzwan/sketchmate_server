import fs from 'fs';
import Router from 'koa-router';
import dayjs from 'dayjs';
import { Types } from 'mongoose';
import { requireAuth } from '../../middleware/auth';
import { requireCapability } from '../../middleware/moderation.middleware';
import { Capability, isCapabilityBlocked } from '../../types/moderation.policy';
import { user_model } from '../../models/user.model';
import { post_model, post_reaction_model } from '../../models/post.model';
import { relationship_model } from '../../models/relationship.model';
import {
  changeUserName,
  createEmblem,
  createSaved,
  createSticker,
  deleteEmblem,
  deleteProfileImg,
  deleteSaved,
  deleteSticker,
  getUser, onLoginEvent,
  s3Creator,
  searchMate,
  updateUser,
  uploadProfileImg
} from '../../mongodb';
import { CONTAINER } from '../../s3';
import {
  ChangeUserNameParams, ENDPOINTS,
  FeedPost, OnLoginEventParams,
  RegisterNotificationParams,
  UnRegisterNotificationParams,
  UpdateUserParams,
  UploadProfileImgParams
} from '../../types/types';
import { LeanPost, RelationshipDocument, UserDocument } from '../../types/mongoose.types';
import { isUserOnline } from '../socket/socket';
import { COMPLETE_PUBLIC_USER_FIELDS, PUBLIC_USER_FIELDS } from '../../types/projections';
import {
  migrateMatesToRelationships,
  parseParams,
  shouldShowThoughtPrompt,
  syncAndFinalizeMigrationStats
} from '../../helper';
import { subscribeV2, unsubscribeV2 } from '../services/user.service';
import { getPublicLobbiesSnapshot } from '../socket/drawSyncing';
import { router } from './router';
import { isPaidTier } from '../../config/catalog.config';

export const userRouter = new Router();

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
      user_model.findById(targetUserId).select(PUBLIC_USER_FIELDS).lean() as Promise<UserDocument | null>
    ]);

    const userReactionMap = userReactions.reduce((acc, rx) => {
      acc[rx.post_id.toString()] = rx.reaction_type;
      return acc;
    }, {} as Record<string, string>);

    const author = authorInfo ? {
      _id: authorInfo._id.toString(),
      name: authorInfo.name,
      img: authorInfo.img,
      customization: authorInfo.customization
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
        enable_remix: post.enable_remix ?? true,
        enable_comments: post.enable_comments ?? true,
        description: post.description || '',
        status: post.status || 'active',
        comment_count: post.comment_count || 0,
        reports_count: post.reports_count || 0,
        views: post.views || 0,
        total_reactions: post.total_reactions || 0,
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

const NAME_CHANGE_COOLDOWN_DAYS = 31;
userRouter.put('/profile', requireAuth, async (ctx) => {
  const { name, description, customization, subscription_tier } = ctx.request.body;
  const user_id = ctx.state.user._id;

  const user = await user_model.findById(user_id) as UserDocument | null;
  if (!user) return ctx.throw(404, 'User not found');

  const updateData: any = {};

  // Accept client tier sync. Never let a 'pro'/'free' sync clobber a lifetime
  // account (lifetime is a one-time purchase — RC entitlement can momentarily
  // read as plain Pro on some paths). Webhook remains authoritative for grants.
  if (subscription_tier && ['free', 'pro', 'lifetime'].includes(subscription_tier)) {
    if (!(user.subscription_tier === 'lifetime' && subscription_tier !== 'lifetime')) {
      updateData.subscription_tier = subscription_tier;
    }
  }

  if (name && name !== user.name) {
    // MODERATION: Swapped to complete dynamic calculation based on operational levels
    const userRestriction = ctx.state.user.restriction;
    const userLevel = userRestriction?.level ?? 0;

    if (isCapabilityBlocked(userLevel, Capability.CHANGE_NAME)) {
      ctx.status = 403;
      ctx.body = {
        error: 'capability_blocked',
        capability: Capability.CHANGE_NAME,
        restriction: {
          level: userLevel,
          reason: userRestriction?.reason,
          expires_at: userRestriction?.expires_at
        }
      };
      return;
    }

    const isPro = isPaidTier(user.subscription_tier);
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

userRouter.post('/upload-image', requireAuth, requireCapability(Capability.CHANGE_PROFILE_IMG), async (ctx) => {
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
      user_model.findById(targetId).select(COMPLETE_PUBLIC_USER_FIELDS).lean() as Promise<UserDocument | null>,
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
        enable_remix: post.enable_remix ?? true,
        enable_comments: post.enable_comments ?? true,
        description: post.description || '',
        status: post.status || 'active',
        comment_count: post.comment_count || 0,
        reports_count: post.reports_count || 0,
        views: post.views || 0,
        total_reactions: post.total_reactions || 0,
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
        customization: user.customization || {},
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

  ctx.body = onlineIds;
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

userRouter.get('/', requireAuth, async (ctx) => {
  const auth_id = ctx.state.auth_id;
  const _id = ctx.state.user?._id?.toString();

  const res = await getUser({ auth_id, _id });

  if (!res?.user) return ctx.throw(404, 'User not found');

  const user = res.user as any;

  if ((user.migration_version || 0) < 1) {
    const newStats = await syncAndFinalizeMigrationStats(user);

    migrateMatesToRelationships(user._id, user.mates)
      .catch(err => console.error('Mates migration failed:', err));

    user.stats = newStats;
    user.mates = [];
    user.migration_version = 1;
  }

  if (!user.customization) user.customization = {};
  ctx.body = res;
});

userRouter.put('/name', requireAuth, requireCapability(Capability.CHANGE_NAME), async (ctx) => {
  const params = parseParams<ChangeUserNameParams>(ctx.request.body);
  params._id = ctx.state.user._id.toString();
  ctx.body = await changeUserName(params);
});

userRouter.put('/update', requireAuth, requireCapability(Capability.CHANGE_NAME), async (ctx) => {
  const params = parseParams<UpdateUserParams>(ctx.request.body);
  params._id = ctx.state.user._id.toString();
  ctx.body = await updateUser(params);
});

userRouter.put('/img', requireAuth, requireCapability(Capability.CHANGE_PROFILE_IMG), async (ctx) => {
  if (!ctx.request.files || !ctx.request.files.file) {
    ctx.status = 400;
    ctx.body = { error: 'No file uploaded' };
    return;
  }

  const params: UploadProfileImgParams = {
    _id: ctx.state.user._id.toString(),
    img: ctx.request.files.file, // matches frontend file key
    previousImage: ctx.request.body.previousImage as string // reads from FormData payload cleanly
  };

  const url = await uploadProfileImg(params);
  ctx.body = { url };
});

userRouter.delete('/img', requireAuth, async (ctx) => {
  const stock_img = ctx.request.query.stockImage as string;
  ctx.body = await deleteProfileImg(ctx.state.user._id.toString(), stock_img);
});

userRouter.post('/sticker', requireAuth, requireCapability(Capability.CHANGE_PROFILE_IMG), async (ctx) => {
  if (!ctx.request.files) throw new Error('No files');
  ctx.body = await createSticker({ _id: ctx.state.user._id.toString(), img: ctx.request.files.file });
});

userRouter.delete('/sticker', requireAuth, async (ctx) => {
  ctx.body = await deleteSticker({
    user_id: ctx.state.user._id.toString(),
    sticker_url: ctx.query.sticker_url as string
  });
});

userRouter.post('/emblem', requireAuth, requireCapability(Capability.CHANGE_PROFILE_IMG), async (ctx) => {
  if (!ctx.request.files) throw new Error('No files');
  ctx.body = await createEmblem({ _id: ctx.state.user._id.toString(), img: ctx.request.files.file });
});

userRouter.delete('/emblem', requireAuth, async (ctx) => {
  ctx.body = await deleteEmblem({ user_id: ctx.state.user._id.toString(), emblem_url: ctx.query.emblem_url as string });
});

userRouter.post('/saved', requireAuth, requireCapability(Capability.CHANGE_PROFILE_IMG), async (ctx) => {
  if (!ctx.request.files) throw new Error('No files');
  const files = ctx.request.files as any;
  ctx.body = await createSaved({
    _id: ctx.state.user._id.toString(),
    img: files.img,
    drawing: files.drawing
  });
});

userRouter.delete('/saved', requireAuth, async (ctx) => {
  ctx.body = await deleteSaved({
    user_id: ctx.state.user._id.toString(),
    drawing_url: ctx.query.drawing_url as string,
    img_url: ctx.query.img_url as string
  });
});

userRouter.put('/subscribe', requireAuth, async (ctx) => {
  ctx.body = await subscribeV2(parseParams<RegisterNotificationParams>(ctx.request.body));
});

userRouter.put('/unsubscribe', requireAuth, async (ctx) => {
  ctx.body = await unsubscribeV2(parseParams<UnRegisterNotificationParams>(ctx.request.body));
});

userRouter.get(`/search_mate`, requireAuth, async (ctx) => {
  const params = parseParams<{ mateName: string, user_id: string }>(ctx.query);
  ctx.body = await searchMate(params.mateName, params.user_id);
});

userRouter.get(`/lobbies`, async (ctx) => {
  ctx.body = getPublicLobbiesSnapshot(ctx.app.context.io);
});

userRouter.put(`/login`, async (ctx) => {
  ctx.body = await onLoginEvent(parseParams<OnLoginEventParams>(ctx.request.body));
});

userRouter.post('/engagement/action', requireAuth, async (ctx) => {
  const userId = ctx.state.user._id;

  // Atomic increment of the counter
  const updated = await user_model.findByIdAndUpdate(
    userId,
    { $inc: { 'engagement_metadata.tasks_completed_since_last_prompt': 1 } },
    { new: true }
  );

  if (!updated) {
    ctx.status = 404;
    return;
  }

  const shouldPrompt = shouldShowThoughtPrompt(updated);

  if (shouldPrompt) {
    // Atomically: stamp the time, reset counter, bump lifetime total
    await user_model.updateOne(
      { _id: userId },
      {
        $set: {
          'engagement_metadata.last_thought_prompt_at': new Date(),
          'engagement_metadata.tasks_completed_since_last_prompt': 0
        },
        $inc: { 'engagement_metadata.total_thought_prompts_shown': 1 }
      }
    );
  }

  ctx.body = { should_prompt: shouldPrompt };
});

// PUT /user/engagement/opt-out
userRouter.put('/engagement/opt-out', requireAuth, async (ctx) => {
  const userId = ctx.state.user._id;
  const { opted_out } = ctx.request.body as { opted_out: boolean };

  await user_model.updateOne(
    { _id: userId },
    { $set: { 'engagement_metadata.feedback_opted_out': !!opted_out } }
  );

  ctx.status = 204;
});