import Router from 'koa-router';
import zlib from 'zlib';
import { promisify } from 'util';
import { promises as fsPromises } from 'fs';

import { requireAuth } from '../../middleware/auth';
import { requireCapability } from '../../middleware/moderation.middleware';
import { Capability } from '../../types/moderation.policy';
import { createBalloon, getBalloon } from '../../mongodb';
import { routeBalloonToOnlineUser } from '../balloon';
import { userSocketMap } from '../socket/socket';
import { mixpanelEvents, trackEvent } from '../../mixpanel';
import { parseParams } from '../../helper';
import { CreateBalloonPostParams, CreateBalloonPostRes } from '../../types/types';

export const balloonRouter = new Router();
const gunzipAsync = promisify(zlib.gunzip);


balloonRouter.post('/', requireAuth, requireCapability(Capability.SEND_BALLOON), async (ctx) => {
  if (!ctx.request.files) throw new Error('No files uploaded');

  const files = ctx.request.files as any;
  const params = parseParams<CreateBalloonPostParams>(ctx.request.body);

  // SECURE: Force sender to be the authenticated user
  params.sender = ctx.state.user._id.toString();
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

  const balloonId = balloon._id.toString();

  routeBalloonToOnlineUser(params.sender, balloonId, userSocketMap, 0).catch((err: any) => {
    console.error('Error during balloon routing triage:', err);
  });

  ctx.body = { balloon } as CreateBalloonPostRes;
  trackEvent(params.sender, mixpanelEvents.balloon_v2_create);
});

// Read Balloon (Un-gated read)
balloonRouter.get('/:id', requireAuth, async (ctx) => {
  ctx.body = await getBalloon(ctx.params.id);
});