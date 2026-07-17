import * as admin from 'firebase-admin';
import { FBNotification } from './types/notification.type';
import { getUserSubscription, pruneSubscriptionTokens } from './mongodb';
import { NotificationSubscription } from './types/types';
import { silentNotification } from './helper';

// FCM error codes that mean the token is permanently dead and must be removed.
// https://firebase.google.com/docs/cloud-messaging/manage-tokens
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument'
]);

/**
 * Sends one message per logged-in subscription in a single batch (sendEach),
 * then returns the tokens FCM reported as permanently invalid so the caller
 * can prune them. Transient errors are logged, not treated as dead.
 */
async function sendToTokens(
  subscriptions: NotificationSubscription[],
  build: (token: string) => admin.messaging.Message
): Promise<string[]> {
  const targets = subscriptions.filter((s) => s.logged_in && s.token);
  if (targets.length === 0) return [];

  const res = await admin.messaging().sendEach(targets.map((s) => build(s.token)));

  const deadTokens: string[] = [];
  res.responses.forEach((r, i) => {
    if (r.success) return;
    const code = r.error?.code;
    if (code && DEAD_TOKEN_CODES.has(code)) {
      deadTokens.push(targets[i].token);
    } else {
      console.error('FCM send failed', code, r.error?.message);
    }
  });
  return deadTokens;
}

export async function sendNotification(
  subscriptions: NotificationSubscription[],
  notification: FBNotification
): Promise<string[]> {
  return sendToTokens(subscriptions, (token) => ({ ...notification, token }));
}

export async function sendSilentNotification(
  subscriptions: NotificationSubscription[],
  notification: FBNotification
): Promise<string[]> {
  return sendToTokens(subscriptions, (token) => ({ ...silentNotification(notification), token }));
}

export async function sendNotificationIncludingSilent(
  subscriptions: NotificationSubscription[],
  notification: FBNotification
): Promise<string[]> {
  const dead = await sendToTokens(subscriptions, (token) => ({ ...notification, token }));
  // Fire the silent companion shortly after so it doesn't collide with the
  // visible one. Rejection is caught so it can never become an unhandled rejection.
  setTimeout(() => {
    sendSilentNotification(subscriptions, notification).catch((e) =>
      console.error('Silent companion notification failed', e)
    );
  }, 5000);
  return dead;
}

export async function sendNotificationUser(user_id: string, notification: FBNotification) {
  const user = await getUserSubscription({ _id: user_id });
  if (!user || user.subscriptions.length === 0) return;

  const dead = await sendNotification(user.subscriptions, notification);
  if (dead.length) await pruneSubscriptionTokens(user_id, dead);
}
