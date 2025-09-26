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
import { connectDb, pairBalloons, removeExpiredBalloons, unPairBalloons } from './mongodb';
import { router } from './api/router';
import { registerSocketHandlers } from './api/socket';
import { errorHandler } from './middleware/error_handler';
import * as fs from 'fs';
import { scheduleResetUploadFolder } from './helper';
import cron from 'node-cron';

const app = new Koa();
export const isDev = process.env.NODE_ENV === 'development';


const server = createServer(app.callback());
const io = new Server(server, {
  cors: {
    origin: ['https://app.sketchmate.ninja', 'http://localhost:8100', 'http://localhost', 'https://localhost'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }
});

const port = process.env.PORT || 4000;
export const minimum_supported_version = '0.2.0';

registerSocketHandlers(io);

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app
  .use(errorHandler())
  .use(cors())
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

