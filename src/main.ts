import Koa from 'koa';
import 'dotenv/config';
import { HttpMethodEnum, koaBody } from 'koa-body';
import logger from 'koa-logger';
import cors from '@koa/cors';
import { createServer } from 'http';
import compress from 'koa-compress';
import etag from 'koa-etag';
import conditional from 'koa-conditional-get';

import { Server } from 'socket.io';
import { connectDb } from './mongodb';
import { router } from './api/router/router';
import { registerSocketHandlers } from './api/socket/socket';
import { errorHandler } from './middleware/error_handler';
import * as fs from 'fs';
import { scheduleResetUploadFolder } from './helper';
import cron from 'node-cron';
import { pairBalloons, removeExpiredBalloons, unPairBalloons } from './api/balloon';
import * as admin from 'firebase-admin';
import serviceAccount from '../fcm.json';
import { inbox_model } from './models/inbox.model';
import { Types } from 'mongoose';
import { inbox_comment_model } from './models/inbox-comment.model';

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as any)
});

const app = new Koa();

const server = createServer(app.callback());
const io = new Server(server, {
  maxHttpBufferSize: 1e7,
  cors: {
    origin: ['https://app.sketchmate.ninja', 'http://localhost:8100', 'http://localhost:3000', 'http://localhost', 'https://localhost', 'https://sketchmate-testing-5e62bf42145c.herokuapp.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }
});
app.context.io = io;

const port = process.env.PORT || 4000;
export const minimum_supported_version = '0.2.0';
export const minimum_online_version = '0.4.0';

registerSocketHandlers(io);

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}


app
  .use(errorHandler())
  .use(cors({
    origin: (ctx) => {
      const allowedOrigins = [
        'https://app.sketchmate.ninja',
        'http://localhost:8100',
        'http://localhost:3000',
        'http://localhost',
        'https://localhost',
        'https://sketchmate-testing-5e62bf42145c.herokuapp.com'
      ];
      const requestOrigin = ctx.get('Origin');
      if (allowedOrigins.includes(requestOrigin)) {
        return requestOrigin;
      }
      return allowedOrigins[0];
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowHeaders: ['Content-Type', 'Authorization', 'Accept']
  }))
  .use(
    koaBody({
      multipart: true,
      formidable: { uploadDir: uploadDir }, //This is where the files would come
      parsedMethods: [HttpMethodEnum.PUT, HttpMethodEnum.POST]
    })
  )
  .use(logger())
  .use(compress({ threshold: 2048 }))
  .use(etag())
  .use(conditional())
  .use(router.routes())
  .use(router.allowedMethods());
server.listen(port, async () => {
  console.log(`Listening on ${port}`);
  await connectDb();
  scheduleResetUploadFolder();
});

// Make the server not crash on unhandled error
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});


// Every hour hours (at :00)
cron.schedule('0 */1 * * *', async () => {
  await pairBalloons();
  await unPairBalloons();
  await removeExpiredBalloons();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function drainInboxComments(opts: { batchSize?: number; pauseMs?: number } = {}) {
  const batchSize = opts.batchSize ?? 100;
  const pauseMs = opts.pauseMs ?? 2000;
  let lastId: any | undefined;
  let migrated = 0, failed = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const q: any = { comments_migrated: { $ne: true } };
    if (lastId) q._id = { $gt: lastId };

    const docs = await inbox_model
      .find(q).sort({ _id: 1 })
      .select('_id comments comments_migrated')
      .limit(batchSize).lean();

    if (!docs.length) break;

    for (const doc of docs) {
      try {
        await migrateEmbeddedComments(doc);
        migrated++;
      } catch (e) {
        failed++;
        console.error(`migrate failed ${doc._id}`, e);
      }
    }

    lastId = docs[docs.length - 1]._id;
    await sleep(pauseMs);   // keep it off the prod load curve
  }
  console.log(`drain done — migrated ${migrated}, failed ${failed}`);
}

export async function migrateEmbeddedComments(doc: any): Promise<void> {
  if (doc.comments_migrated) return;

  const legacy = (Array.isArray(doc.comments) ? doc.comments : []).map((c: any) => ({
    _id: c._id ?? new Types.ObjectId(),
    inbox_id: doc._id,
    sender: c.sender,
    message: c.message,
    date: c.date ?? new Date(),
    status: c.status === 'removed' ? 'removed' : 'active',
    reports_count: c.reports_count ?? 0
  }));

  if (legacy.length) {
    await inbox_comment_model.insertMany(legacy, { ordered: false })
  }
  await inbox_model.updateOne(
    { _id: doc._id },
    { $set: { comments_migrated: true, comments: [] } }
  );
}