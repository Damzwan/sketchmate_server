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
} from '../types/types';
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
  removeFromInbox, s3Creator,
  searchMate,
  seeInbox,
  subscribe,
  unsubscribe,
  updateUser,
  uploadProfileImg
} from '../mongodb';
import { parseParams } from '../helper';
import fs from 'fs';
import { routeBalloonToOnlineUser } from './balloon';
import { userSocketMap } from './socket/socket';
import { mixpanelEvents, trackEvent } from '../mixpanel';
import zlib from 'zlib';
import { promisify } from 'util';
import { promises as fsPromises } from 'fs';

export const router = new Router();

router.get(ENDPOINTS.user, async (ctx) => {
  ctx.body = await getUser(parseParams<GetUserParams>(ctx.query));
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

router.get('/admin/latest-vitals', async (ctx) => {
  const url = await s3Creator.getLatestSnapshotUrl();

  if (url) {
    ctx.body = {
      message: "Latest vitals found.",
      download_url: url
    };
  } else {
    ctx.status = 404;
    ctx.body = { message: "No snapshots available." };
  }
});


