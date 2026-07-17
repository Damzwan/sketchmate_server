import { RegisterNotificationParams, Res, UnRegisterNotificationParams } from '../../types/types';
import { user_model } from '../../models/user.model';

export async function subscribeV2(params: RegisterNotificationParams): Promise<Res<void>> {
  const { user_id, subscription } = params;
  const sub = { ...subscription, updated_at: new Date() };

  try {
    // Enforce exactly one entry per device. Remove any prior entry that shares
    // this device fingerprint OR this FCM token, then insert the fresh one.
    // Matching on both keys makes re-subscribe fully idempotent and survives a
    // token migrating between fingerprints (or a fingerprint rotating its token),
    // so duplicate/stale subscriptions can never accumulate.
    await user_model.updateOne(
      { _id: user_id },
      {
        $pull: {
          subscriptions: { $or: [{ fingerprint: sub.fingerprint }, { token: sub.token }] }
        }
      }
    );

    await user_model.updateOne(
      { _id: user_id },
      { $push: { subscriptions: sub } }
    );
  } catch (e) {
    throw new Error('Failed to subscribe: ' + (e as Error).message);
  }
}

export async function unsubscribeV2(params: UnRegisterNotificationParams): Promise<Res<void>> {
  try {
    await user_model.updateOne(
      { _id: params.user_id },
      { $pull: { subscriptions: { fingerprint: params.fingerprint } } }
    );
  } catch (e) {
    throw new Error('Failed to unsubscribe: ' + (e as Error).message);
  }
}