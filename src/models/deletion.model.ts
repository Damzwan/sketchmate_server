import { Schema, model, Types } from 'mongoose';

const deletionQueueSchema = new Schema({
  target_id: { type: Schema.Types.ObjectId, required: true, index: true },
  target_type: { type: String, required: true },
  execute_after: { type: Date, required: true, index: true }
});

export const deletion_queue_model = model('DeletionQueue', deletionQueueSchema);