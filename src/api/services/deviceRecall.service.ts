import { createHash } from 'crypto';
import { Types } from 'mongoose';
import { banned_device_model } from '../../models/banned-device.model';
import { moderation_action_model } from '../../models/moderation.model';
import { user_model } from '../../models/user.model';
import { getLevelConfig, STRIKE_LADDER } from '../../types/moderation.policy';
import { moderationStrikePushNotification } from '../../config/notification.config';
import { dispatchNotification } from './notification.service';

/**
 * DEVICE RECALL
 *
 * A banned account costs its owner nothing to replace, because signing up is
 * anonymous and free. The device is the one thing that carries over. So when an
 * account is banned we remember the hardware, and when that hardware shows up
 * under a new account we restrict it again.
 *
 * Three properties this is built around:
 *
 *  - NOTHING IDENTIFYING IS STORED. Only a SHA-256 of the platform identifier,
 *    which answers "banned before, yes/no" and nothing else. See
 *    models/banned-device.model.ts.
 *
 *  - IT IS NOT A STRIKE. A recall match is not a report that was upheld against
 *    THIS account, so it must not touch strike_summary — otherwise an appeal
 *    that clears a false positive leaves a phantom strike on a clean record,
 *    and strike decay would silently expire a ban that was never time-limited.
 *    It writes a restriction directly, and the audit log records why.
 *
 *  - IT IS APPEALABLE. Shared and handed-down devices are common in this app's
 *    demographic (see docs/FAMILIES_POLICY.md — the whole reason parental
 *    controls exist is that these are family devices). The restriction copy
 *    already points at support, and lifting it is the normal liftRestriction()
 *    path.
 */

/** The top rung of STRIKE_LADDER — read from the ladder so it survives edits. */
export const BANNED_LEVEL = STRIKE_LADDER.length - 1;

export type DevicePlatform = 'android' | 'ios';

/**
 * Raw identifiers never reach the database. ANDROID_ID is already scoped per
 * app-signing-key and iOS identifierForVendor is scoped per vendor, so neither
 * is cross-app linkable to begin with — hashing means they are not linkable to
 * anything at all once stored.
 */
export const hashDeviceId = (rawId: string) =>
  createHash('sha256').update(rawId, 'utf8').digest('hex');

/**
 * Record that `userId` uses this device, then check it against the ban list.
 *
 * Called on login rather than at account creation on purpose: the client only
 * learns its device id after the native layer is up, and running the check on
 * every login also catches accounts that were created before the device was
 * ever banned.
 *
 * Returns whether a recall restriction was applied, for the caller's response.
 */
export async function registerDevice(params: {
  userId: string;
  rawDeviceId: string;
  platform: DevicePlatform;
}): Promise<{ recalled: boolean }> {
  const { userId, rawDeviceId, platform } = params;
  const hash = hashDeviceId(rawDeviceId);

  await user_model.updateOne({ _id: userId }, { $addToSet: { device_ids: hash } });

  const banned = await banned_device_model.findOne({ device_id_hash: hash }).lean();
  if (!banned) return { recalled: false };

  const user = await user_model.findById(userId).select('restriction').lean() as any;
  // Already at the top rung — nothing to escalate, and re-applying would spam
  // the user with a fresh restriction notification on every single login.
  if ((user?.restriction?.level ?? 0) >= BANNED_LEVEL) return { recalled: true };

  await applyDeviceRecallRestriction(userId);
  return { recalled: true };
}

/**
 * Put every device this user has signed in from onto the ban list.
 *
 * Called when an account reaches the banned rung. Uses updateOne with upsert
 * per device rather than insertMany so a device already on the list (a repeat
 * evader) does not throw on the unique index — the FIRST ban is the one worth
 * keeping as provenance.
 */
export async function banDevicesForUser(userId: string, reason: string): Promise<number> {
  const user = await user_model.findById(userId).select('device_ids').lean() as any;
  const hashes: string[] = user?.device_ids ?? [];
  if (!hashes.length) return 0;

  await Promise.all(
    hashes.map((hash) =>
      banned_device_model.updateOne(
        { device_id_hash: hash },
        {
          $setOnInsert: {
            device_id_hash: hash,
            platform: 'unknown',
            first_banned_user_id: new Types.ObjectId(userId),
            reason
          }
        },
        { upsert: true }
      )
    )
  );

  return hashes.length;
}

/**
 * Write the banned-rung restriction directly. Deliberately NOT applyStrike():
 * that derives the level from the count of upheld reports, and this account has
 * none — the signal came from the hardware, not from anything posted here.
 */
async function applyDeviceRecallRestriction(userId: string) {
  const config = getLevelConfig(BANNED_LEVEL);
  const restriction = {
    level: BANNED_LEVEL,
    reason: 'device_recall_match',
    applied_at: new Date(),
    expires_at: null
  };

  await user_model.updateOne({ _id: userId }, { $set: { restriction } });

  await moderation_action_model.create({
    user_id: new Types.ObjectId(userId),
    action_type: 'restriction_applied',
    level: BANNED_LEVEL,
    reason: 'device_recall_match',
    blocked_capabilities: [...config.blocks],
    notes: 'Applied automatically: this device was used by a previously banned account.'
  });

  const payload = {
    level: BANNED_LEVEL,
    name: config.name,
    description: config.description,
    reason: 'device_recall_match',
    expires_at: null,
    blocked_capabilities: [...config.blocks]
  };

  dispatchNotification({
    recipient_id: userId,
    type: 'moderation_strike',
    target_type: 'system',
    channels: {
      in_app: true,
      socket: { event: 'moderation:strike', data: payload },
      push: moderationStrikePushNotification(config.name, config.description)
    },
    payload
  }).catch((err) => console.error('Device recall dispatch failed:', err));
}
