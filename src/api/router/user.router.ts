import fs from 'fs';
import Router from 'koa-router';
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
  parseParams,
  shouldShowThoughtPrompt,
  syncAndFinalizeMigrationStats
} from '../../helper';
import { subscribeV2, unsubscribeV2 } from '../services/user.service';
import { getPublicLobbiesSnapshot } from '../socket/drawSyncing';
import { router } from './router';
import { buildItemId, FREE_ITEMS, isPaidTier } from '../../config/catalog.config';
import {
  clearChatBackground,
  setChatBackground,
  type ChatBackgroundSource
} from '../services/chat-background.service';

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

userRouter.put('/profile', requireAuth, async (ctx) => {
  const { name, description, customization, chat_customization, subscription_tier } = ctx.request.body;
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

    // One-time rename: the name picked at signup (from the default 'Anonymous')
    // is free and doesn't count; after that a free user gets exactly ONE more
    // change, then the name locks. `last_name_change` is the "used my one edit"
    // marker. Pro/Lifetime are exempt and never stamp it.
    const isPro = isPaidTier(user.subscription_tier);
    const isOnboardingName = user.name === 'Anonymous';
    const hasUsedRename = Boolean(user.last_name_change);

    if (!isPro && !isOnboardingName && hasUsedRename) {
      ctx.status = 403;
      ctx.body = { error: 'Name locked', locked: true };
      return;
    }

    updateData.name = name;
    // Consume the one allowed edit — but not for the onboarding name choice.
    if (!isPro && !isOnboardingName) updateData.last_name_change = new Date();
  }

  if (description !== undefined) updateData.description = description;

  if (customization) {
    Object.keys(customization).forEach(key => {
      updateData[`customization.${key}`] = customization[key];
    });
  }

  if (chat_customization) {
    const chatCustomizationFields: Record<string, 'theme' | 'font' | 'font_effect' | 'world' | 'effect'> = {
      themeId: 'theme',
      fontId: 'font',
      fontEffectId: 'font_effect',
      worldId: 'world',
      effectId: 'effect'
    };
    for (const [key, category] of Object.entries(chatCustomizationFields)) {
      if (typeof chat_customization[key] === 'string') {
        const itemId = buildItemId(category, chat_customization[key]);
        const canUse =
          FREE_ITEMS.has(itemId) ||
          user.subscription_tier === 'lifetime' ||
          (user.inventory ?? []).includes(itemId);
        if (!canUse) {
          ctx.status = 403;
          ctx.body = { error: 'cosmetic_not_owned', item_id: itemId };
          return;
        }
        updateData[`chat_customization.${key}`] = chat_customization[key];
      }
    }

    if (
      isPaidTier(user.subscription_tier) &&
      typeof chat_customization.backgroundImageOpacity === 'number' &&
      Number.isFinite(chat_customization.backgroundImageOpacity)
    ) {
      updateData['chat_customization.backgroundImageOpacity'] = Math.max(
        0.06,
        Math.min(0.35, chat_customization.backgroundImageOpacity)
      );
    }
  }

  if (Object.keys(updateData).length === 0) {
    ctx.body = { message: 'No changes to update' };
    return;
  }

  await user_model.updateOne({ _id: user_id }, { $set: updateData });
  ctx.body = { message: 'Profile updated' };
});

userRouter.put('/chat-background', requireAuth, async (ctx) => {
  const userId = ctx.state.user._id.toString();
  const user = await user_model.findById(userId).select('subscription_tier').lean();
  if (!user) return ctx.throw(404, 'User not found');
  if (!isPaidTier(user.subscription_tier)) {
    ctx.status = 403;
    ctx.body = { error: 'pro_required' };
    return;
  }

  const sourceType = ctx.request.body?.source_type as ChatBackgroundSource;
  const sourceId = String(ctx.request.body?.source_id ?? '');
  if (!['inbox', 'post'].includes(sourceType) || !Types.ObjectId.isValid(sourceId)) {
    ctx.status = 400;
    ctx.body = { error: 'invalid_background_source' };
    return;
  }

  try {
    const url = await setChatBackground({ userId, sourceType, sourceId });
    ctx.body = { url };
  } catch (error: any) {
    if (error?.message === 'background_source_not_found') {
      ctx.status = 404;
      ctx.body = { error: 'background_source_not_found' };
      return;
    }
    console.error('Set chat background error:', error);
    ctx.status = 500;
    ctx.body = { error: 'chat_background_failed' };
  }
});

userRouter.delete('/chat-background', requireAuth, async (ctx) => {
  try {
    await clearChatBackground(ctx.state.user._id.toString());
    ctx.body = { success: true };
  } catch (error) {
    console.error('Clear chat background error:', error);
    ctx.status = 500;
    ctx.body = { error: 'chat_background_clear_failed' };
  }
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
    // migrateMatesToRelationships is now awaited INSIDE
    // syncAndFinalizeMigrationStats — the counters are derived from the
    // relationships it creates, so running the two in parallel raced the
    // counting against the writing it was supposed to count.
    const { stats, grantedItems } = await syncAndFinalizeMigrationStats(user);

    user.stats = stats;
    user.mates = [];
    user.migration_version = 1;
    // Reflect the just-granted OG gift / titles so the client hydrates them
    // immediately, without a second round-trip.
    if (grantedItems.length) {
      user.inventory = [...(user.inventory ?? []), ...grantedItems];
    }
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

userRouter.put('/timezone', requireAuth, async (ctx) => {
  const requestedTimezone = ctx.request.body?.timezone;
  if (typeof requestedTimezone !== 'string' || requestedTimezone.length > 100) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid timezone' };
    return;
  }

  try {
    const candidate = requestedTimezone.trim();
    // Intl both validates the IANA identifier and gives us its canonical form.
    const timezone = new Intl.DateTimeFormat('en-US', {
      timeZone: candidate
    }).resolvedOptions().timeZone;

    await user_model.updateOne(
      { _id: ctx.state.user._id },
      { $set: { timezone } }
    );

    ctx.body = { timezone };
  } catch {
    ctx.status = 400;
    ctx.body = { error: 'Invalid timezone' };
  }
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
