import Router from 'koa-router';
import {
  ChangeUserNameParams,
  CreateEmblemParams,
  CreateSavedParams,
  CreateStickerParams,
  DeleteEmblemParams,
  DeleteSavedParams,
  DeleteStickerParams,
  ENDPOINTS,
  GetInboxItemsParams,
  GetUserParams, OnLoginEventParams, RegisterNotificationParams,
  RemoveFromInboxParams,
  UnRegisterNotificationParams,
  UploadProfileImgParams
} from '../types/types';
import {
  changeUserName,
  createEmblem,
  createSaved,
  createSticker,
  createUser,
  deleteEmblem,
  deleteProfileImg,
  deleteSaved,
  deleteSticker,
  getInboxItems, getLastImgFromUser, getPartialUsers,
  getUser, getUserMates, onLoginEvent,
  removeFromInbox,
  seeInbox,
  subscribe,
  unsubscribe,
  uploadProfileImg
} from '../mongodb';
import { parseParams } from '../helper';

export const router = new Router();

router.get(ENDPOINTS.user, async (ctx) => {
  ctx.body = await getUser(parseParams<GetUserParams>(ctx.query));
});

router.put(`${ENDPOINTS.user}/login`, async (ctx) => {
  ctx.body = await onLoginEvent(parseParams<OnLoginEventParams>(ctx.request.body));
});

router.get(`${ENDPOINTS.user}/mates`, async (ctx) => {
  ctx.body = await getUserMates(parseParams<{ user_id: string }>(ctx.query));
});

router.get(`${ENDPOINTS.user}/drawing`, async (ctx) => {
  ctx.body = await getLastImgFromUser(parseParams<{ user_id: string, friend_id: string }>(ctx.query));
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
