import mongoose, { Schema } from 'mongoose';
import { CloudDraftDocument } from '../types/mongoose.types';

/**
 * One row per (user, client draft id). Rows are UPSERTED, never appended: a
 * draft is a living document, so its history is worth exactly one revision.
 *
 * `updated_at` is the CLIENT's clock, not the server's, because that is the
 * value the device compares against its local copy to decide which side is
 * newer. `createdAt/updatedAt` from timestamps stay as server-side bookkeeping.
 */
const cloudDraftSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'users', required: true },
    /** Client-generated uuid. Stable across devices for the same draft. */
    draft_id: { type: String, required: true },
    updated_at: { type: Number, required: true },
    /** S3 keys, not URLs — deleteBlob() only understands flat keys. */
    drawing_key: { type: String, default: '' },
    thumbnail_key: { type: String, default: '' },
    bytes: { type: Number, default: 0 },
    /**
     * Tombstone. A discarded draft has to stay listable for a while so a device
     * that was offline during the delete learns about it instead of re-uploading
     * its stale local copy on the next push.
     */
    deleted_at: { type: Number, default: null }
  },
  { timestamps: true }
);

cloudDraftSchema.index({ user_id: 1, draft_id: 1 }, { unique: true });
// Drives the incremental `?since=` pull.
cloudDraftSchema.index({ user_id: 1, updated_at: -1 });
// Reap tombstones after 60 days; by then every device has either synced or been
// through a fresh full pull anyway.
cloudDraftSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 60 * 24 * 60 * 60,
    partialFilterExpression: { deleted_at: { $type: 'number' } }
  }
);

export const cloud_draft_model = mongoose.model<CloudDraftDocument>('cloud_drafts', cloudDraftSchema);
