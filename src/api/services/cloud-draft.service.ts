import { Types } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { cloud_draft_model } from '../../models/cloud-draft.model';
import { s3Creator } from '../../mongodb';
import { CONTAINER, getCdnUrl } from '../../s3';

/** Per-account ceiling on synced drafts. Local storage stays uncapped. */
export const MAX_CLOUD_DRAFTS = 60;
/** Hard ceiling per draft. Well past the largest drawing we have ever measured. */
export const MAX_DRAFT_BYTES = 32 * 1024 * 1024;

const DRAFT_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export interface CloudDraftSummary {
  draft_id: string;
  updated_at: number;
  bytes: number;
  thumbnail: string;
  drawing: string;
}

export interface CloudDraftPage {
  drafts: CloudDraftSummary[];
  /** Draft ids tombstoned server-side; the device deletes its local copy. */
  deleted: string[];
  /** Echoed back as the next `?since=` cursor. */
  cursor: number;
  limit: number;
  used: number;
}

export class CloudDraftError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

export const isValidDraftId = (id: string) => DRAFT_ID.test(id);

const draftPrefix = (userId: string, draftId: string) => `drafts/${userId}/${draftId}/`;

function summarize(row: {
  draft_id: string;
  updated_at: number;
  bytes: number;
  thumbnail_key: string;
  drawing_key: string;
}): CloudDraftSummary {
  return {
    draft_id: row.draft_id,
    updated_at: row.updated_at,
    bytes: row.bytes,
    thumbnail: row.thumbnail_key ? getCdnUrl(row.thumbnail_key) : '',
    drawing: row.drawing_key ? getCdnUrl(row.drawing_key) : ''
  };
}

/**
 * Incremental list. `since` is the previous response's cursor, so a device that
 * syncs often transfers almost nothing; `since = 0` is the cold full pull.
 *
 * The cursor is the max `updated_at` in the response rather than a server clock,
 * which keeps it immune to clock skew between the device and the API.
 */
export async function listCloudDrafts(userId: string, since: number): Promise<CloudDraftPage> {
  const [rows, used] = await Promise.all([
    cloud_draft_model
      .find({ user_id: new Types.ObjectId(userId), updated_at: { $gt: since } })
      .select('draft_id updated_at bytes thumbnail_key drawing_key deleted_at')
      .sort({ updated_at: 1 })
      .lean(),
    cloud_draft_model.countDocuments({ user_id: new Types.ObjectId(userId), deleted_at: null })
  ]);

  const drafts: CloudDraftSummary[] = [];
  const deleted: string[] = [];
  let cursor = since;

  for (const row of rows) {
    cursor = Math.max(cursor, row.updated_at);
    if (row.deleted_at) deleted.push(row.draft_id);
    else drafts.push(summarize(row));
  }

  return { drafts, deleted, cursor, limit: MAX_CLOUD_DRAFTS, used };
}

export async function createUploadTicket(userId: string, draftId: string) {
  if (!isValidDraftId(draftId)) throw new CloudDraftError(400, 'invalid_draft_id');

  // A fresh revision id per ticket. Overwriting the live key in place would let
  // a half-finished upload replace the copy the device can currently restore.
  const revision = uuidv4();
  const prefix = draftPrefix(userId, draftId);

  const [drawing, thumbnail] = await Promise.all([
    s3Creator.getPresignedUploadUrl('application/gzip', CONTAINER.drawings, `${prefix}${revision}.json.gz`),
    s3Creator.getPresignedUploadUrl('image/webp', CONTAINER.drawings, `${prefix}${revision}.webp`)
  ]);

  return {
    drawingUploadUrl: drawing.signedUrl,
    drawingKey: drawing.key,
    thumbnailUploadUrl: thumbnail.signedUrl,
    thumbnailKey: thumbnail.key
  };
}

/**
 * Last-write-wins commit.
 *
 * The upload already happened (straight to S3, never through this process), so
 * this only moves the pointer. When the incoming revision loses the race the
 * freshly uploaded objects are orphans and are removed here — otherwise every
 * rejected push would leak a full document into the bucket.
 */
export async function commitCloudDraft(params: {
  userId: string;
  draftId: string;
  updatedAt: number;
  drawingKey: string;
  thumbnailKey: string;
  bytes: number;
}): Promise<CloudDraftSummary> {
  const { userId, draftId, updatedAt, drawingKey, thumbnailKey, bytes } = params;

  if (!isValidDraftId(draftId)) throw new CloudDraftError(400, 'invalid_draft_id');
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) throw new CloudDraftError(400, 'invalid_updated_at');
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_DRAFT_BYTES) {
    throw new CloudDraftError(413, 'draft_too_large');
  }

  // The presigned URL already restricts WHERE a client can write; this makes the
  // pointer we persist obey the same restriction, so a commit can never be aimed
  // at another account's object.
  const prefix = draftPrefix(userId, draftId);
  if (!drawingKey.startsWith(prefix) || (thumbnailKey && !thumbnailKey.startsWith(prefix))) {
    throw new CloudDraftError(400, 'invalid_draft_key');
  }

  const user_id = new Types.ObjectId(userId);
  const existing = await cloud_draft_model.findOne({ user_id, draft_id: draftId }).lean();

  const orphan = async () => {
    await s3Creator
      .deleteObjects([drawingKey, thumbnailKey].filter(Boolean), CONTAINER.drawings)
      .catch((error) => console.warn('Orphaned draft upload cleanup failed:', error));
  };

  if (existing && existing.updated_at >= updatedAt) {
    await orphan();
    throw new CloudDraftError(409, 'stale_draft');
  }

  if (!existing) {
    const used = await cloud_draft_model.countDocuments({ user_id, deleted_at: null });
    if (used >= MAX_CLOUD_DRAFTS) {
      await orphan();
      throw new CloudDraftError(409, 'draft_limit_reached');
    }
  }

  const updated = await cloud_draft_model
    .findOneAndUpdate(
      { user_id, draft_id: draftId },
      {
        $set: {
          updated_at: updatedAt,
          drawing_key: drawingKey,
          thumbnail_key: thumbnailKey,
          bytes,
          deleted_at: null
        }
      },
      { new: true, upsert: true }
    )
    .lean();

  // Superseded revision, dropped only after the pointer moved. Failure here
  // costs bucket space, never the user's draft, so it must not fail the commit.
  const stale = [existing?.drawing_key, existing?.thumbnail_key].filter(
    (key): key is string => !!key && key !== drawingKey && key !== thumbnailKey
  );
  if (stale.length) {
    void s3Creator
      .deleteObjects(stale, CONTAINER.drawings)
      .catch((error) => console.warn('Stale draft revision cleanup failed:', error));
  }

  return summarize(updated as any);
}

export async function deleteCloudDraft(userId: string, draftId: string, deletedAt: number) {
  if (!isValidDraftId(draftId)) throw new CloudDraftError(400, 'invalid_draft_id');

  const user_id = new Types.ObjectId(userId);
  const existing = await cloud_draft_model.findOne({ user_id, draft_id: draftId }).lean();
  if (!existing) return;

  // The tombstone rides on `updated_at` so it is newer than the revision it
  // retires and wins the same comparison every other device already performs.
  const stamp = Math.max(deletedAt, existing.updated_at + 1);
  await cloud_draft_model.updateOne(
    { user_id, draft_id: draftId },
    { $set: { deleted_at: stamp, updated_at: stamp, drawing_key: '', thumbnail_key: '', bytes: 0 } }
  );

  const keys = [existing.drawing_key, existing.thumbnail_key].filter(Boolean);
  if (keys.length) {
    await s3Creator
      .deleteObjects(keys, CONTAINER.drawings)
      .catch((error) => console.warn('Draft blob cleanup failed:', error));
  }
}

/** Account deletion / downgrade cleanup. Purges rows and bucket objects. */
export async function purgeCloudDrafts(userId: string) {
  const user_id = new Types.ObjectId(userId);
  const rows = await cloud_draft_model.find({ user_id }).select('drawing_key thumbnail_key').lean();
  const keys = rows.flatMap((row) => [row.drawing_key, row.thumbnail_key]).filter(Boolean);
  if (keys.length) {
    await s3Creator.deleteObjects(keys, CONTAINER.drawings).catch((error) => console.warn('Draft purge failed:', error));
  }
  await cloud_draft_model.deleteMany({ user_id });
}
