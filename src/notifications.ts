import * as admin from 'firebase-admin';
import { FBNotification } from './types/notification.type';
import serviceAccount from '../fcm.json';
import { getUserSubscription } from './mongodb';

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as any),
});
const messaging = admin.messaging();

export async function sendNotification(token: string, notification: FBNotification) {
  await messaging.send({
    ...notification,
    token,
  });
}

export async function sendNotificationUser(user_id: string, notification: FBNotification) {
  const user = await getUserSubscription({ _id: user_id });
  if (!user || !user.subscription) return;
  else await sendNotification(user.subscription, notification);
}
