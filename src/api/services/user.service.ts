import { RegisterNotificationParams, Res, UnRegisterNotificationParams } from '../../types/types';
import { user_model } from '../../models/user.model';

export async function subscribeV2(params: RegisterNotificationParams): Promise<Res<void>> {
  const { user_id, subscription } = params;
  const sub = { ...subscription, updated_at: new Date() };

  try {
    // Atomic upsert-into-array: try to update existing subscription by fingerprint.
    const updated = await user_model.findOneAndUpdate(
      { _id: user_id, 'subscriptions.fingerprint': sub.fingerprint },
      {
        $set: {
          'subscriptions.$.token': sub.token,
          'subscriptions.$.logged_in': sub.logged_in,
          'subscriptions.$.platform': sub.platform,
          'subscriptions.$.model': sub.model,
          'subscriptions.$.os': sub.os,
          'subscriptions.$.updated_at': sub.updated_at
        }
      },
      { new: true }
    );

    if (updated) return;

    await user_model.updateOne(
      { _id: user_id, 'subscriptions.fingerprint': { $ne: sub.fingerprint } },
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