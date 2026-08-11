import mongoose, { Schema } from 'mongoose';

const guestRecoverySchema = new Schema(
  {
    credential_id: { type: String, required: true, unique: true, index: true },
    auth_id: { type: String, required: true, index: true },
    secret_hash: { type: String, required: true },
    last_used_at: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

export const guest_recovery_model = mongoose.model('guest_recovery_credentials', guestRecoverySchema);
