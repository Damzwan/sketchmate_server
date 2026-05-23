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
  getPartialUsers,
  getUser,
  onLoginEvent,
  removeFromInbox,
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
import { inboxRouter } from './inbox.router';
import { balloonRouter } from './balloon.router';
import { quotaRouter } from './quota.router';
import { notificationRouter } from './notification.router';

export const router = new Router();

router.use('/v2/post', postRouter.routes(), postRouter.allowedMethods());
router.use('/v2/user', userRouter.routes(), userRouter.allowedMethods());
router.use('/v2/moderation', moderationRouter.routes(), moderationRouter.allowedMethods());
router.use('/v2/chats', chatRouter.routes(), chatRouter.allowedMethods());
router.use('/v2/relationship', relationshipRouter.routes(), relationshipRouter.allowedMethods());
router.use('/v2/inbox', inboxRouter.routes(), inboxRouter.allowedMethods());
router.use('/v2/balloon', balloonRouter.routes(), balloonRouter.allowedMethods());
router.use('/v2/quota', quotaRouter.routes(), quotaRouter.allowedMethods());
router.use('/v2/notification', notificationRouter.routes(), notificationRouter.allowedMethods());
router.use('/dev/moderation', devModerationRouter.routes(), devModerationRouter.allowedMethods());

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


router.put(ENDPOINTS.user, async (ctx) => {
  ctx.body = await changeUserName(parseParams<ChangeUserNameParams>(ctx.request.body));
});

router.put(`${ENDPOINTS.user}/update`, async (ctx) => {
  ctx.body = await updateUser(parseParams<UpdateUserParams>(ctx.request.body));
});

router.put(`${ENDPOINTS.user}/img/:id`, async (ctx) => {
  if (!ctx.request.files) throw new Error();
  const params: UploadProfileImgParams = {
    _id: ctx.params.id,
    img: ctx.request.files.file,
    previousImage: ctx.request.query.previousImage as string
  };

  ctx.body = await uploadProfileImg(params);
});

router.delete(`${ENDPOINTS.user}/img/:id`, async (ctx) => {
  const user_id = ctx.params.id;
  const stock_img = ctx.request.query.stockImage as string;
  ctx.body = await deleteProfileImg(user_id, stock_img);
});

router.post(`${ENDPOINTS.sticker}/:id`, async (ctx) => {
  if (!ctx.request.files) throw new Error();
  const params: CreateStickerParams = {
    _id: ctx.params.id,
    img: ctx.request.files.file
  };
  ctx.body = await createSticker(params);
});

router.post(`${ENDPOINTS.emblem}/:id`, async (ctx) => {
  if (!ctx.request.files) throw new Error();
  const params: CreateEmblemParams = {
    _id: ctx.params.id,
    img: ctx.request.files.file
  };
  ctx.body = await createEmblem(params);
});

router.post(`${ENDPOINTS.saved}/:id`, async (ctx) => {
  if (!ctx.request.files) throw new Error();
  const files = ctx.request.files;
  const params: CreateSavedParams = {
    _id: ctx.params.id,
    img: files.img,
    drawing: files.drawing
  };
  ctx.body = await createSaved(params);
});

router.put(ENDPOINTS.subscribe, async (ctx) => {
  ctx.body = await subscribe(parseParams<RegisterNotificationParams>(ctx.request.body));
});

router.put(ENDPOINTS.unsubscribe, async (ctx) => {
  ctx.body = await unsubscribe(parseParams<UnRegisterNotificationParams>(ctx.request.body));
});

router.delete(ENDPOINTS.sticker, async (ctx) => {
  ctx.body = await deleteSticker(parseParams<DeleteStickerParams>(ctx.query));
});

router.delete(ENDPOINTS.emblem, async (ctx) => {
  ctx.body = await deleteEmblem(parseParams<DeleteEmblemParams>(ctx.query));
});

router.delete(ENDPOINTS.saved, async (ctx) => {
  ctx.body = await deleteSaved(parseParams<DeleteSavedParams>(ctx.query));
});

router.delete(`${ENDPOINTS.inbox}/:userId/:inboxItemId`, async (ctx) => {
  const params: RemoveFromInboxParams = {
    user_id: ctx.params.userId,
    inbox_id: ctx.params.inboxItemId
  };
  ctx.body = await removeFromInbox(params);
});

router.post(`${ENDPOINTS.inbox}/see/:id`, async (ctx) => {
  const inbox_id = ctx.params.id;
  const user_id = ctx.request.query.user_id as string;

  ctx.body = await seeInbox({ inbox_id, user_id });
});


const inflateAsync = promisify(zlib.inflate);
router.post(`${ENDPOINTS.balloon}`, async (ctx) => {
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
  params.version = 1

  const balloon = await createBalloon(params);
  if (!balloon) return;

  ctx.body = { balloon } as CreateBalloonPostRes;
});

const gunzipAsync = promisify(zlib.gunzip);

router.post(`${ENDPOINTS.balloon}/v2`, async (ctx) => {
  if (!ctx.request.files) {
    throw new Error('No files uploaded');
  }

  const files = ctx.request.files as any;
  const params = parseParams<CreateBalloonPostParams>(ctx.request.body);

  params.aspect_ratio = parseFloat(params.aspect_ratio as any as string);

  // ASYNC I/O: Read both files simultaneously without blocking the server's heartbeat
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

  // 2. Circulation: Immediately start the Hot Potato routing
  const senderId = balloon.sender.toString();
  const balloonId = balloon._id.toString();


  routeBalloonToOnlineUser(senderId, balloonId, userSocketMap, 0).catch((err: any) => {
    console.error('Error during balloon routing triage:', err);
  });

  ctx.body = { balloon } as CreateBalloonPostRes;
  trackEvent(params.sender, mixpanelEvents.balloon_v2_create);
});

router.get(`${ENDPOINTS.balloon}/:id`, async (ctx) => {
  const balloon_id = ctx.params.id;
  return ctx.body = await getBalloon(balloon_id);
});


// used by the widget
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

