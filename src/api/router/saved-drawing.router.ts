// router/saved.router.ts
import Router from 'koa-router';
import { createSaved, deleteSaved, getSavedDrawings } from '../services/saved-drawing.service';
import { requireAuth } from '../../middleware/auth';
import { s3Creator } from '../../mongodb';
import { CONTAINER } from '../../s3';

export const savedRouter = new Router();
savedRouter.use(requireAuth);

// GET /v2/saved/presigned
// Frontend calls this first to get the S3 upload URLs
savedRouter.get('/presigned/urls', async (ctx) => {

  // Get a ticket for the WebP Thumbnail
  const imgData = await s3Creator.getPresignedUploadUrl('image/webp', CONTAINER.drawings);
  // Get a ticket for the JSON File
  const jsonData = await s3Creator.getPresignedUploadUrl('application/json', CONTAINER.drawings);

  ctx.body = {
    imgUploadUrl: imgData.signedUrl,
    imgPublicUrl: imgData.publicUrl,
    jsonUploadUrl: jsonData.signedUrl,
    jsonPublicUrl: jsonData.publicUrl
  };
});

// GET /v2/saved/:userId
savedRouter.get('/:userId', async (ctx) => {
  const user_id = ctx.params.userId;
  ctx.body = await getSavedDrawings(user_id);
});

// POST /v2/saved/:userId
// Called AFTER the frontend successfully pushes files to S3
savedRouter.post('/:userId', async (ctx) => {
  const { img, drawing } = ctx.request.body as any;

  if (!img || !drawing) {
    return ctx.throw(400, 'Missing img or drawing URLs in body');
  }

  ctx.body = await createSaved({
    _id: ctx.params.userId,
    img,
    drawing
  });
});

// DELETE /v2/saved/:id
savedRouter.delete('/:id', async (ctx) => {
  const saved_id = ctx.params.id;
  const user_id = ctx.query.user_id as string;

  if (!user_id) return ctx.throw(400, 'user_id is required');

  await deleteSaved(saved_id, user_id);
  ctx.status = 200;
  ctx.body = { success: true };
});