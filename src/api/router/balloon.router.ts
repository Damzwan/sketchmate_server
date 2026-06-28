import Router from 'koa-router';
import { requireAuth } from '../../middleware/auth';
import { requireCapability } from '../../middleware/moderation.middleware';
import { Capability } from '../../types/moderation.policy';
import { getBalloon, s3Creator } from '../../mongodb';
import {
  BalloonNotFoundError,
  cancelBalloonV2,
  listMyActiveBalloons,
  refuseBalloonV2
} from '../services/balloon.service';
import { QuotaExceededError } from '../services/quota.service';
import {
  acceptBalloonV3,
  createBalloonV3,
  triageWaitingRoomV3
} from '../services/balloon.service.v3';
import { v4 as uuidv4 } from 'uuid';
import { CONTAINER } from '../../s3';



export const balloonRouter = new Router();

balloonRouter.post(
  '/upload-urls',
  requireAuth,
  requireCapability(Capability.SEND_BALLOON),
  async (ctx) => {
    try {
      const userId = ctx.state.user._id.toString();
      const uniqueId = uuidv4();

      const [drawingUrls, imageUrls, thumbnailUrls] = await Promise.all([
        s3Creator.getPresignedUploadUrl('application/gzip', CONTAINER.drawings, `balloons/${userId}/${uniqueId}.gz`),
        s3Creator.getPresignedUploadUrl('image/webp', CONTAINER.drawings, `balloons/${userId}/${uniqueId}.webp`),
        s3Creator.getPresignedUploadUrl('image/webp', CONTAINER.drawings, `balloons/${userId}/${uniqueId}-thumb.webp`)
      ]);
      ctx.body = { drawing: drawingUrls, image: imageUrls, thumbnail: thumbnailUrls };
    } catch (error) {
      console.error('Balloon presigned URL error:', error);
      ctx.status = 500;
      ctx.body = { error: 'Failed to generate upload URLs' };
    }
  }
);

balloonRouter.post(
  '/',
  requireAuth,
  requireCapability(Capability.SEND_BALLOON),
  async (ctx) => {
    const { drawing_url, image_url, thumbnail_url, aspect_ratio, message } = ctx.request.body;

    if (!drawing_url || !image_url || !thumbnail_url) {
      ctx.status = 400;
      ctx.body = { error: 'Missing one of: drawing_url, image_url, thumbnail_url' };
      return;
    }

    try {
      const balloon = await createBalloonV3({
        sender: ctx.state.user._id.toString(),
        message: message || '',
        aspect_ratio: parseFloat(aspect_ratio) || 1,
        drawing_url,
        image_url,
        thumbnail_url
      });
      ctx.status = 201;
      ctx.body = { balloon };
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        ctx.status = 429;
        ctx.body = { error: 'quota_exceeded', kind: error.kind, state: error.state };
        return;
      }
      console.error('Balloon create error:', error);
      ctx.status = 500;
      ctx.body = { error: 'Failed to create balloon' };
    }
  }
);

balloonRouter.get('/mine', requireAuth, async (ctx) => {
  try {
    const balloons = await listMyActiveBalloons(ctx.state.user._id.toString());
    ctx.body = { balloons };
  } catch (error) {
    console.error('List balloons error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to list balloons' };
  }
});

// ─── Triage ─────────────────────────────────────────────────────────────
// Called after login (with a random delay) to check if there's a waiting
// balloon for this user. The actual delivery still happens via the
// `receive_new_balloon` socket emit, so the response is just a flag.

balloonRouter.post('/triage', requireAuth, async (ctx) => {
  try {
    const delivered = await triageWaitingRoomV3(ctx.state.user._id.toString());
    ctx.body = { delivered };
  } catch (error) {
    console.error('Balloon triage error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to triage' };
  }
});

balloonRouter.post('/:id/cancel', requireAuth, async (ctx) => {
  try {
    const result = await cancelBalloonV2({
      balloon_id: ctx.params.id,
      user_id: ctx.state.user._id.toString()
    });
    ctx.body = result;
  } catch (error) {
    if (error instanceof BalloonNotFoundError) {
      ctx.status = 404;
      ctx.body = { error: 'balloon_not_found' };
      return;
    }
    console.error('Cancel balloon error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to cancel balloon' };
  }
});

balloonRouter.post(
  '/:id/accept',
  requireAuth,
  requireCapability(Capability.RECEIVE_BALLOON),
  async (ctx) => {
    const { sender_id } = ctx.request.body;
    if (!sender_id) {
      ctx.status = 400;
      ctx.body = { error: 'sender_id required' };
      return;
    }

    try {
      const result = await acceptBalloonV3({
        balloon_id: ctx.params.id,
        sender_id,
        user_id: ctx.state.user._id.toString()
      });
      ctx.body = result;
    } catch (error) {
      if (error instanceof BalloonNotFoundError) {
        ctx.status = 404;
        ctx.body = { error: 'balloon_not_found' };
        return;
      }
      console.error('Accept balloon error:', error);
      ctx.status = 500;
      ctx.body = { error: 'Failed to accept balloon' };
    }
  }
);

balloonRouter.post('/:id/refuse', requireAuth, async (ctx) => {
  const { sender_id, disable } = ctx.request.body;
  if (!sender_id) {
    ctx.status = 400;
    ctx.body = { error: 'sender_id required' };
    return;
  }
  try {
    const result = await refuseBalloonV2({
      balloon_id: ctx.params.id,
      sender_id,
      user_id: ctx.state.user._id.toString(),
      disable: !!disable
    });
    ctx.body = result;
  } catch (error) {
    console.error('Refuse balloon error:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to refuse balloon' };
  }
});

balloonRouter.get('/:id', requireAuth, async (ctx) => {
  ctx.body = await getBalloon(ctx.params.id);
});