import Router from 'koa-router';
import { requireAuth } from '../../middleware/auth';
import { requireCapability } from '../../middleware/moderation.middleware';
import { Capability } from '../../types/moderation.policy';
import { getBalloon, s3Creator } from '../../mongodb';
import { createBalloonV2 } from '../services/balloon.service';
import { QuotaExceededError } from '../services/quota.service';

export const balloonRouter = new Router();

balloonRouter.post(
  '/upload-urls',
  requireAuth,
  requireCapability(Capability.SEND_BALLOON),
  async (ctx) => {
    try {
      const [drawingUrls, imageUrls, thumbnailUrls] = await Promise.all([
        s3Creator.getPresignedUploadUrl('application/gzip'),
        s3Creator.getPresignedUploadUrl('image/webp'),
        s3Creator.getPresignedUploadUrl('image/webp')
      ]);

      ctx.body = {
        drawing: drawingUrls,
        image: imageUrls,
        thumbnail: thumbnailUrls
      };
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
      const balloon = await createBalloonV2({
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

balloonRouter.get('/:id', requireAuth, async (ctx) => {
  ctx.body = await getBalloon(ctx.params.id);
});