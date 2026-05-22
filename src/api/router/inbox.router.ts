import Router from 'koa-router';
import { requireAuth } from '../../middleware/auth';
import { getInboxItemsV2, removeFromInbox, seeInbox, s3Creator } from '../../mongodb';
import { requireCapability } from '../../middleware/moderation.middleware';
import { Capability } from '../../types/moderation.policy';
import { commentOnInbox, createInboxItem } from '../services/inbox.service';

export const inboxRouter = new Router();

inboxRouter.get('/', requireAuth, async (ctx) => {
  const { limit, lastDate } = ctx.query as any;

  ctx.body = await getInboxItemsV2({
    user_id: ctx.state.user._id.toString(),
    limit: parseInt(limit) || 20,
    lastDate: lastDate ? new Date(lastDate) : undefined
  });
});

inboxRouter.delete('/:inboxId', requireAuth, async (ctx) => {
  ctx.body = await removeFromInbox({
    user_id: ctx.state.user._id.toString(),
    inbox_id: ctx.params.inboxId
  });
});

inboxRouter.post('/see/:inboxId', requireAuth, async (ctx) => {
  ctx.body = await seeInbox({
    inbox_id: ctx.params.inboxId,
    user_id: ctx.state.user._id.toString()
  });
});

/**
 * V2 PRESIGNED UPLOAD URLs
 * Client uploads the drawing blob, image, and thumbnail directly to S3,
 * then calls POST /inbox with the resulting URLs.
 */
inboxRouter.post(
  '/upload-urls',
  requireAuth,
  requireCapability(Capability.SEND_INBOX_DRAWING),
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
      console.error('S3 Presigned URL error:', error);
      ctx.status = 500;
      ctx.body = { error: 'Failed to generate upload URLs' };
    }
  }
);

/**
 * V2 PUBLISH INBOX ITEM
 * Persists the inbox item from pre-uploaded S3 URLs and fans out
 * via live socket emit + push notification to all followers.
 */
inboxRouter.post(
  '/',
  requireAuth,
  requireCapability(Capability.SEND_INBOX_DRAWING),
  async (ctx) => {
    const { drawing_url, image_url, thumbnail_url, aspect_ratio, followers } = ctx.request.body;

    if (!drawing_url || !image_url || !thumbnail_url) {
      ctx.status = 400;
      ctx.body = { error: 'Missing one of: drawing_url, image_url, thumbnail_url' };
      return;
    }

    if (!Array.isArray(followers) || followers.length === 0) {
      ctx.status = 400;
      ctx.body = { error: 'followers must be a non-empty array' };
      return;
    }

    try {
      const inboxItem = await createInboxItem({
        sender_id: ctx.state.user._id.toString(),
        sender_name: ctx.state.user.name,
        followers,
        drawing_url,
        image_url,
        thumbnail_url,
        aspect_ratio
      });

      ctx.status = 201;
      ctx.body = { inbox_item: inboxItem };
    } catch (error) {
      console.error('Publish inbox item error:', error);
      ctx.status = 500;
      ctx.body = { error: 'Failed to publish inbox item' };
    }
  }
);

/**
 * V2 COMMENT ON INBOX ITEM
 */
inboxRouter.post(
  '/:inboxId/comment',
  requireAuth,
  requireCapability(Capability.COMMENT_ON_INBOX),
  async (ctx) => {
    const { inboxId } = ctx.params;
    const { message, followers } = ctx.request.body;
    const sender = ctx.state.user._id.toString();
    const name = ctx.state.user.name;

    if (!message?.trim()) {
      ctx.status = 400;
      ctx.body = { error: 'Comment message cannot be empty' };
      return;
    }

    if (!Array.isArray(followers)) {
      ctx.status = 400;
      ctx.body = { error: 'followers must be an array' };
      return;
    }

    try {
      const commentRes = await commentOnInbox({
        inbox_id: inboxId,
        sender,
        message,
        followers,
        name
      });

      ctx.status = 201;
      ctx.body = commentRes;
    } catch (error) {
      console.error('Inbox comment error:', error);
      ctx.status = 500;
      ctx.body = { error: 'Failed to post comment' };
    }
  }
);

export default inboxRouter;