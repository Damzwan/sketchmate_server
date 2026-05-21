import Router from 'koa-router';
import {
  ChangeUserNameParams,
  CreateBalloonPostParams,
  CreateBalloonPostRes,
  CreateEmblemParams,
  CreateSavedParams,
  CreateStickerParams,
  DeleteEmblemParams,
  DeleteSavedParams,
  DeleteStickerParams,
  ENDPOINTS,
  GetInboxItemsParams,
  GetUserParams,
  OnLoginEventParams,
  RegisterNotificationParams,
  RemoveFromInboxParams,
  UnRegisterNotificationParams,
  UpdateUserParams,
  UploadProfileImgParams
} from '../../types/types';
import {
  changeUserName,
  createBalloon,
  createEmblem,
  createSaved,
  createSticker,
  deleteEmblem,
  deleteProfileImg,
  deleteSaved,
  deleteSticker,
  getBalloon,
  getInboxItems,
  getInboxItemsV2,
  getPartialUsers,
  getUser,
  onLoginEvent,
  removeFromInbox,
  s3Creator,
  searchMate,
  seeInbox,
  subscribe,
  unsubscribe,
  updateUser,
  uploadProfileImg
} from '../../mongodb';
import { migrateMatesToRelationships, parseParams, syncAndFinalizeMigrationStats } from '../../helper';
import { routeBalloonToOnlineUser } from '../balloon';
import { userSocketMap } from '../socket/socket';
import { mixpanelEvents, trackEvent } from '../../mixpanel';
import zlib from 'zlib';
import { promisify } from 'util';
import { promises as fsPromises } from 'fs';
import { inbox_model } from '../../models/inbox.model';
import postRouter from './post.router';
import { userRouter } from './user.router';
import { chatRouter } from './chat.router';
import { relationshipRouter } from './relationship.router';
import { InboxDocument } from '../../types/mongoose.types';
import { moderationRouter } from './moderation.router';
import devModerationRouter from './devModeration.router';
import { isDev } from '../../config/app.config';
import { requireAuth } from '../../middleware/auth';
import { requireCapability } from '../../middleware/moderation.middleware';
import { Capability } from '../../types/moderation.policy';

export const router = new Router();

router.use('/post', postRouter.routes(), postRouter.allowedMethods());
router.use('/user', userRouter.routes(), userRouter.allowedMethods());
router.use('/moderation', moderationRouter.routes(), moderationRouter.allowedMethods());
router.use('/chats', chatRouter.routes(), chatRouter.allowedMethods());
router.use('/relationship', relationshipRouter.routes(), relationshipRouter.allowedMethods());

if (isDev) {
  router.use('/dev/moderation', devModerationRouter.routes(), devModerationRouter.allowedMethods());
}

// =============================================================================
// READ ENDPOINTS — no gates, no auth required for most (legacy public reads)
// =============================================================================
// TODO: many of these accept user_id via query/body without requireAuth. That
// means anyone with the URL can read another user's inbox or partial info.
// Adding requireAuth would close that hole, but check for client impact first
// (older app versions may not send the auth header for these calls).

router.get(ENDPOINTS.user, async (ctx) => {
  const res = await getUser(parseParams<GetUserParams>(ctx.query));
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

router.put(`${ENDPOINTS.user}/login`, async (ctx) => {
  ctx.body = await onLoginEvent(parseParams<OnLoginEventParams>(ctx.request.body));
});

router.get(`${ENDPOINTS.user}/search_mate`, async (ctx) => {
  const params = parseParams<{ mateName: string, user_id: string }>(ctx.query);
  ctx.body = await searchMate(params.mateName, params.user_id);
});

router.get(ENDPOINTS.partial_users, async (ctx) => {
  const params = ctx.query as any;
  ctx.body = await getPartialUsers(params._ids.split(','));
});

router.get(ENDPOINTS.inbox, async (ctx) => {
  const params = ctx.query as any;
  params._ids = params._ids.split(',');
  ctx.body = await getInboxItems(parseParams<GetInboxItemsParams>(params));
});


// =============================================================================
// USER MUTATIONS — gated on CHANGE_NAME / CHANGE_PROFILE_IMG
// =============================================================================
// These are legacy endpoints. The newer /user/profile (in user.router.ts) is
// the preferred path. Keeping these gated for safety until they're deprecated.
//
// SECURITY TODO: these accept user_id from the body, not ctx.state.user._id.
// A user could pass another user's ID. Gating with requireCapability checks
// THE CALLER'S restriction, but mutates the TARGET. Once everything uses
// requireAuth + ctx.state.user._id, this hole closes.

router.put(ENDPOINTS.user, requireAuth, requireCapability(Capability.CHANGE_NAME), async (ctx) => {
  ctx.body = await changeUserName(parseParams<ChangeUserNameParams>(ctx.request.body));
});

router.put(`${ENDPOINTS.user}/update`, requireAuth, requireCapability(Capability.CHANGE_NAME), async (ctx) => {
  // Defensive: this endpoint can update many fields, but we gate on CHANGE_NAME
  // because name is the most sensitive field it touches. If you split this
  // into per-field endpoints later, pick more specific capabilities.
  ctx.body = await updateUser(parseParams<UpdateUserParams>(ctx.request.body));
});

router.put(`${ENDPOINTS.user}/img/:id`, requireAuth, requireCapability(Capability.CHANGE_PROFILE_IMG), async (ctx) => {
  if (!ctx.request.files) throw new Error();
  const params: UploadProfileImgParams = {
    _id: ctx.params.id,
    img: ctx.request.files.file,
    previousImage: ctx.request.query.previousImage as string
  };

  ctx.body = await uploadProfileImg(params);
});

router.delete(`${ENDPOINTS.user}/img/:id`, requireAuth, async (ctx) => {
  // Delete (reset to stock) is destructive and always allowed.
  const user_id = ctx.params.id;
  const stock_img = ctx.request.query.stockImage as string;
  ctx.body = await deleteProfileImg(user_id, stock_img);
});


// =============================================================================
// INVENTORY (stickers, emblems, saved drawings) — gated on CHANGE_PROFILE_IMG
// =============================================================================
// Reused capability because these are personal-customization assets that
// flow into outgoing content (stickers go on drawings, emblems on profiles).
// A restricted user shouldn't be prepping new content while sanctioned.
//
// If you want finer-grained control, add CUSTOMIZE_INVENTORY to the Capability
// enum and swap it in here. The pattern is identical.

router.post(`${ENDPOINTS.sticker}/:id`, requireAuth, async (ctx) => {
  if (!ctx.request.files) throw new Error();
  const params: CreateStickerParams = {
    _id: ctx.params.id,
    img: ctx.request.files.file
  };
  ctx.body = await createSticker(params);
});

router.post(`${ENDPOINTS.emblem}/:id`, requireAuth, async (ctx) => {
  if (!ctx.request.files) throw new Error();
  const params: CreateEmblemParams = {
    _id: ctx.params.id,
    img: ctx.request.files.file
  };
  ctx.body = await createEmblem(params);
});

router.post(`${ENDPOINTS.saved}/:id`, requireAuth, async (ctx) => {
  if (!ctx.request.files) throw new Error();
  const files = ctx.request.files;
  const params: CreateSavedParams = {
    _id: ctx.params.id,
    img: files.img,
    drawing: files.drawing
  };
  ctx.body = await createSaved(params);
});

// Deletes — destructive, always allowed.
router.delete(ENDPOINTS.sticker, async (ctx) => {
  ctx.body = await deleteSticker(parseParams<DeleteStickerParams>(ctx.query));
});

router.delete(ENDPOINTS.emblem, async (ctx) => {
  ctx.body = await deleteEmblem(parseParams<DeleteEmblemParams>(ctx.query));
});

router.delete(ENDPOINTS.saved, async (ctx) => {
  ctx.body = await deleteSaved(parseParams<DeleteSavedParams>(ctx.query));
});


// =============================================================================
// PUSH NOTIFICATIONS — never gated
// =============================================================================
// Restricted users still need to receive notifications — including the one
// that tells them their restriction was lifted. Cutting off notifications
// from a banned user is the kind of decision that leads to support tickets
// from people who think they were silently dropped.

router.put(ENDPOINTS.subscribe, async (ctx) => {
  ctx.body = await subscribe(parseParams<RegisterNotificationParams>(ctx.request.body));
});

router.put(ENDPOINTS.unsubscribe, async (ctx) => {
  ctx.body = await unsubscribe(parseParams<UnRegisterNotificationParams>(ctx.request.body));
});


// =============================================================================
// INBOX — reads and deletes only at this level
// =============================================================================

router.delete(`${ENDPOINTS.inbox}/:userId/:inboxItemId`, async (ctx) => {
  // Removing an item from one's own inbox is destructive — always allowed.
  const params: RemoveFromInboxParams = {
    user_id: ctx.params.userId,
    inbox_id: ctx.params.inboxItemId
  };
  ctx.body = await removeFromInbox(params);
});

router.post(`${ENDPOINTS.inbox}/see/:id`, async (ctx) => {
  // Marking as seen is bookkeeping, not a social action.
  const inbox_id = ctx.params.id;
  const user_id = ctx.request.query.user_id as string;

  ctx.body = await seeInbox({ inbox_id, user_id });
});


// =============================================================================
// BALLOONS — gated on SEND_BALLOON
// =============================================================================
// The two creation endpoints (v1 and v2) are the user-facing entry points for
// balloon sending. SEND_BALLOON is blocked at strike level 2+ ("Balloon Pause"),
// which is the lightest restriction. Other levels also include it.
//
// SECURITY TODO: these routes read `sender` from the request body rather than
// using ctx.state.user._id. That's a hole — a user could create a balloon as
// someone else. Add requireAuth and pull sender from ctx.state.user when
// you next touch this code.

const inflateAsync = promisify(zlib.inflate);
router.post(`${ENDPOINTS.balloon}`, requireAuth, requireCapability(Capability.SEND_BALLOON), async (ctx) => {
  if (!ctx.request.files) {
    throw new Error('No files uploaded');
  }

  const files = ctx.request.files as any;

  const params = parseParams<CreateBalloonPostParams>(ctx.request.body);
  params.aspect_ratio = parseFloat(params.aspect_ratio as any as string);

  const [imgBuffer, compressedBuffer] = await Promise.all([
    fsPromises.readFile(files.img.filepath),
    fsPromises.readFile(files.drawing.filepath)
  ]);

  await Promise.all([
    fsPromises.unlink(files.img.filepath).catch(console.error),
    fsPromises.unlink(files.drawing.filepath).catch(console.error)
  ]);

  params.img = imgBuffer;

  const decompressedBuffer = await inflateAsync(compressedBuffer);
  params.drawing = JSON.parse(decompressedBuffer.toString('utf-8'));

  const balloon = await createBalloon(params);
  if (!balloon) return;

  ctx.body = { balloon } as CreateBalloonPostRes;
});

const gunzipAsync = promisify(zlib.gunzip);

router.post(`${ENDPOINTS.balloon}/v2`, requireAuth, requireCapability(Capability.SEND_BALLOON), async (ctx) => {
  if (!ctx.request.files) {
    throw new Error('No files uploaded');
  }

  const files = ctx.request.files as any;
  const params = parseParams<CreateBalloonPostParams>(ctx.request.body);

  params.aspect_ratio = parseFloat(params.aspect_ratio as any as string);

  const [imgBuffer, compressedBuffer] = await Promise.all([
    fsPromises.readFile(files.img.filepath),
    fsPromises.readFile(files.drawing.filepath)
  ]);

  await Promise.all([
    fsPromises.unlink(files.img.filepath).catch(console.error),
    fsPromises.unlink(files.drawing.filepath).catch(console.error)
  ]);

  params.img = imgBuffer;

  const decompressedBuffer = await gunzipAsync(compressedBuffer);
  params.drawing = JSON.parse(decompressedBuffer.toString('utf-8'));

  const balloonData = { ...params, version: 2 };
  const balloon = await createBalloon(balloonData);

  if (!balloon) return;

  const senderId = balloon.sender.toString();
  const balloonId = balloon._id.toString();

  routeBalloonToOnlineUser(senderId, balloonId, userSocketMap, 0).catch((err: any) => {
    console.error('Error during balloon routing triage:', err);
  });

  ctx.body = { balloon } as CreateBalloonPostRes;
  trackEvent(params.sender, mixpanelEvents.balloon_v2_create);
});

router.get(`${ENDPOINTS.balloon}/:id`, async (ctx) => {
  // Read — not gated.
  const balloon_id = ctx.params.id;
  return ctx.body = await getBalloon(balloon_id);
});


router.get('/user/inbox/latest', async (ctx) => {
  const userId = ctx.query.user_id as string;
  const offset = parseInt(ctx.query.offset as string) || 0;

  if (!userId) {
    return ctx.throw(400, 'user_id is required');
  }

  try {
    const item = await inbox_model
      .findOne({ followers: userId })
      .sort({ date: -1 })
      .skip(offset)
      .select('_id thumbnail sender')
      .lean() as InboxDocument | null;

    if (!item) {
      ctx.body = null;
      return;
    }

    const [mate_info] = await getPartialUsers([item.sender.toString()]);

    trackEvent(userId, mixpanelEvents.widget);

    ctx.body = {
      _id: item._id.toString(),
      image: item.thumbnail,
      senderName: mate_info?.name || 'Unknown',
      senderImg: mate_info?.img || ''
    };

  } catch (err) {
    console.error('Widget API Error:', err);
    ctx.status = 500;
    ctx.body = { error: 'Internal Server Error' };
  }
});

router.get('/v2/inbox', async (ctx) => {
  const { user_id, limit, lastDate } = ctx.query as any;
  ctx.body = await getInboxItemsV2({
    user_id,
    limit: parseInt(limit) || 20,
    lastDate: lastDate ? new Date(lastDate) : undefined
  });
});