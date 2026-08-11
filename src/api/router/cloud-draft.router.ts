import Router from 'koa-router';
import { requireAuth } from '../../middleware/auth';
import { requirePro } from '../../middleware/pro';
import {
  CloudDraftError,
  commitCloudDraft,
  createUploadTicket,
  deleteCloudDraft,
  listCloudDrafts,
  MAX_CLOUD_DRAFTS,
  MAX_DRAFT_BYTES
} from '../services/cloud-draft.service';

export const cloudDraftRouter = new Router();

cloudDraftRouter.use(requireAuth, requirePro);

const handle = async (ctx: any, run: () => Promise<void>) => {
  try {
    await run();
  } catch (error: any) {
    if (error instanceof CloudDraftError) {
      ctx.status = error.status;
      ctx.body = { error: error.code };
      return;
    }
    console.error('Cloud draft error:', error);
    ctx.status = 500;
    ctx.body = { error: 'draft_sync_failed' };
  }
};

/** Advertised so the client can refuse an oversized push before uploading it. */
cloudDraftRouter.get('/limits', async (ctx) => {
  ctx.body = { limit: MAX_CLOUD_DRAFTS, maxBytes: MAX_DRAFT_BYTES };
});

cloudDraftRouter.get('/', async (ctx) => {
  await handle(ctx, async () => {
    const since = Number(ctx.query.since ?? 0);
    ctx.body = await listCloudDrafts(ctx.state.user._id.toString(), Number.isFinite(since) ? Math.max(0, since) : 0);
  });
});

cloudDraftRouter.post('/:draftId/upload-url', async (ctx) => {
  await handle(ctx, async () => {
    ctx.body = await createUploadTicket(ctx.state.user._id.toString(), ctx.params.draftId);
  });
});

cloudDraftRouter.put('/:draftId', async (ctx) => {
  await handle(ctx, async () => {
    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    ctx.body = await commitCloudDraft({
      userId: ctx.state.user._id.toString(),
      draftId: ctx.params.draftId,
      updatedAt: Number(body.updated_at),
      drawingKey: String(body.drawing_key ?? ''),
      thumbnailKey: String(body.thumbnail_key ?? ''),
      bytes: Number(body.bytes ?? 0)
    });
  });
});

cloudDraftRouter.delete('/:draftId', async (ctx) => {
  await handle(ctx, async () => {
    const deletedAt = Number(ctx.query.deleted_at);
    await deleteCloudDraft(
      ctx.state.user._id.toString(),
      ctx.params.draftId,
      Number.isFinite(deletedAt) && deletedAt > 0 ? deletedAt : Date.now()
    );
    ctx.status = 200;
    ctx.body = { success: true };
  });
});
