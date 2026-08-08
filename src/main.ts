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
import { advancePhases } from './api/services/competition.service';
import { runCompetitionNotifications } from './api/services/competitionNotifications.service';
import { isCompetitionEnabled } from './config/competition.config';
import * as admin from 'firebase-admin';
import { loadServiceAccount } from './firebase-credential';

admin.initializeApp({
  credential: admin.credential.cert(loadServiceAccount() as any)
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
export const minimum_online_version = '0.4.3';

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

  // Catch-up on boot: a dyno that was down over a rollover still opens, scores
  // and announces the weeks it slept through.
  if (isCompetitionEnabled()) {
    advancePhases().catch((e) => console.error('[competition] boot advance failed:', e));
  }
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

  // Hourly is enough: every transition is date-driven and idempotent, so a
  // phase flipping up to an hour late breaks nothing.
  if (isCompetitionEnabled()) {
    await advancePhases().catch((e) => console.error('[competition] advance failed:', e));
    // After the advance, so a competition that just flipped to `announced`
    // gets its results push on this same tick.
    await runCompetitionNotifications().catch((e) =>
      console.error('[competition] notifications failed:', e)
    );
  }
});