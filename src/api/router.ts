import Router from 'koa-router';
import {
  ChangeUserNameParams,
  CommentParams,
  ENDPOINTS,
  GetInboxItemsParams,
  GetUserParams,
  RemoveFromInboxParams,
  SubscribeParams,
  UploadProfileImgParams,
} from '../types';
import {
  changeUserName,
  comment,
  createUser,
  getInboxItems,
  getUser,
  removeFromInbox,
  subscribe,
  unsubscribe,
  uploadProfileImg,
} from '../mongodb';
import { parseParams } from '../helper';

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
  ctx.body = await createUser();
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

router.put(ENDPOINTS.subscribe, async (ctx) => {
  ctx.body = await subscribe(parseParams<SubscribeParams>(ctx.request.body));
});

router.put(ENDPOINTS.unsubscribe, async (ctx) => {
  ctx.body = await unsubscribe(parseParams<GetUserParams>(ctx.request.body));
});

router.put(ENDPOINTS.inbox, async (ctx) => {
  ctx.body = await comment(parseParams<CommentParams>(ctx.request.body));
});

router.delete(`${ENDPOINTS.inbox}/:userId/:inboxItemId`, async (ctx) => {
  const params: RemoveFromInboxParams = {
    user_id: ctx.params.userId,
    inbox_id: ctx.params.inboxItemId,
  };
  ctx.body = await removeFromInbox(params);
});
