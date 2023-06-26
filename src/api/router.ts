import Router from 'koa-router';
import {
  ChangeUserNameParams,
  CreateEmblemParams,
  CreateSavedParams,
  CreateStickerParams,
  CreateUserParams,
  DeleteEmblemParams,
  DeleteSavedParams,
  DeleteStickerParams,
  ENDPOINTS,
  GetInboxItemsParams,
  GetUserParams,
  RemoveFromInboxParams,
  SubscribeParams,
  UploadProfileImgParams,
  User,
} from '../types/types';
import {
  changeUserName,
  createEmblem,
  createSaved,
  createSticker,
  createUser,
  deleteEmblem,
  deleteSaved,
  deleteSticker,
  getInboxItems,
  getUser,
  removeFromInbox,
  subscribe,
  unsubscribe,
  uploadProfileImg,
} from '../mongodb';
import { parseParams } from '../helper';
import { PageRangeInfo } from '@azure/storage-blob';

export const router = new Router();

router.get(ENDPOINTS.user, async (ctx) => {
  ctx.body = await getUser(parseParams<GetUserParams>(ctx.query));
});

router.get(ENDPOINTS.inbox, async (ctx) => {
  const params = ctx.query as any;
  params._ids = params._ids.split(',');
  ctx.body = await getInboxItems(parseParams<GetInboxItemsParams>(params));
});

router.post(ENDPOINTS.user, async (ctx) => {
  const files = ctx.request.files as any;
  const userData: CreateUserParams = JSON.parse(ctx.request.body.user);
  if (files.img) userData.img = files.img.filepath;

  ctx.body = await createUser(userData);
});

router.put(ENDPOINTS.user, async (ctx) => {
  ctx.body = await changeUserName(parseParams<ChangeUserNameParams>(ctx.request.body));
});

router.put(`${ENDPOINTS.user}/img/:id`, async (ctx) => {
  if (!ctx.request.files) throw new Error();
  const params: UploadProfileImgParams = {
    _id: ctx.params.id,
    mate_id: ctx.request.query.mate_id as string,
    img: ctx.request.files.file,
    previousImage: ctx.request.query.previousImage as string,
  };

  ctx.body = await uploadProfileImg(params);
});

router.post(`${ENDPOINTS.sticker}/:id`, async (ctx) => {
  if (!ctx.request.files) throw new Error();
  const params: CreateStickerParams = {
    _id: ctx.params.id,
    img: ctx.request.files.file,
  };
  ctx.body = await createSticker(params);
});

router.post(`${ENDPOINTS.emblem}/:id`, async (ctx) => {
  if (!ctx.request.files) throw new Error();
  const params: CreateEmblemParams = {
    _id: ctx.params.id,
    img: ctx.request.files.file,
  };
  ctx.body = await createEmblem(params);
});

router.post(`${ENDPOINTS.saved}/:id`, async (ctx) => {
  if (!ctx.request.files) throw new Error();
  const files = ctx.request.files;
  const params: CreateSavedParams = {
    _id: ctx.params.id,
    img: files.img,
    drawing: files.drawing,
  };
  ctx.body = await createSaved(params);
});

router.put(ENDPOINTS.subscribe, async (ctx) => {
  ctx.body = await subscribe(parseParams<SubscribeParams>(ctx.request.body));
});

router.put(ENDPOINTS.unsubscribe, async (ctx) => {
  ctx.body = await unsubscribe(parseParams<GetUserParams>(ctx.request.body));
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
    inbox_id: ctx.params.inboxItemId,
  };
  ctx.body = await removeFromInbox(params);
});
