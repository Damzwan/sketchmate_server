import Koa from 'koa';
import Router from 'koa-router';
import 'dotenv/config';
import { koaBody } from 'koa-body';
import logger from 'koa-logger';
import {
  ENDPOINTS,
  GetUserParams,
  MatchParams,
  Notifications,
  SendParams,
  SOCKET_ENDPONTS,
  SubscribeParams,
  UnMatchParams,
} from './types';
import { parseParams, sendNotification } from './helper';
import cors from '@koa/cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import {
  connectDb,
  connectWithMate,
  createUser,
  getDrawings,
  getUser,
  send,
  subscribe,
  unMatch,
  unsubscribe,
} from './mongodb';

const app = new Koa();
const server = createServer(app.callback());
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT'],
    credentials: true,
  },
});

const router = new Router();
const port = process.env.PORT || 4000;

router.get(ENDPOINTS.get_user, async (ctx) => {
  ctx.body = await getUser(parseParams<GetUserParams>(ctx.query));
});

router.get(ENDPOINTS.get_drawings, async (ctx) => {
  ctx.body = await getDrawings(parseParams<GetUserParams>(ctx.query));
});

router.post(ENDPOINTS.create_user, async (ctx) => {
  ctx.body = await createUser();
});

router.put(ENDPOINTS.subscribe, async (ctx) => {
  ctx.body = await subscribe(parseParams<SubscribeParams>(ctx.request.body));
});

router.put(ENDPOINTS.unsubscribe, async (ctx) => {
  ctx.body = await unsubscribe(parseParams<GetUserParams>(ctx.request.body));
});

interface Map<T> {
  [key: string]: T;
}

const socketToUserId: Map<string> = {};
const userIdToSocket: Map<string> = {};

io.on('connection', (socket) => {
  console.log('connect', socket.id);
  socket.on(SOCKET_ENDPONTS.login, (params: GetUserParams) => {
    socketToUserId[socket.id] = params._id;
    userIdToSocket[params._id] = socket.id;
  });

  socket.on(SOCKET_ENDPONTS.match, async (params: MatchParams) => {
    try {
      await connectWithMate(params);
      socket.emit(SOCKET_ENDPONTS.match, { mate: params.mate });
      if (userIdToSocket[params.mate])
        io.to(userIdToSocket[params.mate]).emit(SOCKET_ENDPONTS.match, { mate: params._id });
    } catch (e) {
      socket.emit(SOCKET_ENDPONTS.match);
      if (userIdToSocket[params.mate]) io.to(userIdToSocket[params.mate]).emit(SOCKET_ENDPONTS.match);
    }
  });

  socket.on(SOCKET_ENDPONTS.unmatch, async (params: UnMatchParams) => {
    try {
      await unMatch(params);
      socket.emit(SOCKET_ENDPONTS.unmatch, true);
      if (userIdToSocket[params.mate]) io.to(userIdToSocket[params.mate]).emit(SOCKET_ENDPONTS.unmatch, true);
    } catch (e) {
      socket.emit(SOCKET_ENDPONTS.unmatch, false);
      if (userIdToSocket[params.mate]) io.to(userIdToSocket[params.mate]).emit(SOCKET_ENDPONTS.unmatch, false);
    }
  });

  socket.on(SOCKET_ENDPONTS.send, async (params: SendParams) => {
    try {
      const inboxItem = await send(params);
      socket.emit(SOCKET_ENDPONTS.send, inboxItem);
      if (userIdToSocket[params.mate]) io.to(userIdToSocket[params.mate]).emit(SOCKET_ENDPONTS.send, inboxItem);
      await sendNotification(params.mate, Notifications.message);
    } catch (e) {
      console.log(e);
    }
  });

  socket.on(SOCKET_ENDPONTS.disconnect, () => {
    console.log('disconnect', socket.id);
    delete userIdToSocket[socketToUserId[socket.id]];
    delete socketToUserId[socket.id];
  });
});

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err: any) {
    ctx.status = err.statusCode || err.status || 500;
    ctx.body = err.message;
    ctx.app.emit('error', err, ctx);
  }
});

app.use(cors()).use(koaBody()).use(logger()).use(router.routes()).use(router.allowedMethods());
server.listen(port, () => {
  console.log(`Listening on ${port}`);
  connectDb();
});
