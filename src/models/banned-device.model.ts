import mongoose, { Schema } from 'mongoose';

/**
 * DEVICE RECALL — the ban list, keyed by hardware rather than by account.
 *
 * The problem this exists for: accounts are anonymous and free, so a level-3
 * ban costs the banned person nothing. They sign in again and they are new.
 * The one thing that does not change between those accounts is the phone.
 *
 * What is stored is a SHA-256 of the platform identifier, never the raw value.
 * The hash is enough to answer the only question ever asked of this collection
 * — "have we banned this device before, yes or no" — and it means the row is
 * useless to anyone who reads the database. It cannot be reversed into a
 * device, correlated with another app, or turned into a profile. There is
 * deliberately no user-agent, no IP, and no last-seen tracking here: this is a
 * ban list, not an analytics table.
 *
 * `first_banned_user_id` is kept for one reason — when someone appeals, it is
 * the only way to see WHICH ban put their device on this list.
 */
const bannedDeviceSchema = new Schema(
  {
    device_id_hash: { type: String, required: true, unique: true, index: true },
    platform: { type: String, required: true },
    first_banned_user_id: { type: Schema.Types.ObjectId, ref: 'users', required: true },
    reason: { type: String, default: 'device_recall' }
  },
  { timestamps: true }
);

export const banned_device_model = mongoose.model('banned_devices', bannedDeviceSchema);
