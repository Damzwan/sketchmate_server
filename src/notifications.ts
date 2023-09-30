import * as admin from 'firebase-admin';
import { FBNotification } from './types/notification.type';
import serviceAccount from '../fcm.json';
import { getUserSubscription, subscribe, unsubscribe } from './mongodb';

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as any),
});
const messaging = admin.messaging();

export async function sendNotification(token: string, notification: FBNotification, user_id: string) {
  try {
    await messaging.send({
      ...notification,
      token,
    });
  } catch (e) {
    unsubscribe({ _id: user_id });
    console.log(e);
  }
}

export async function sendNotificationUser(user_id: string, notification: FBNotification) {
  const user = await getUserSubscription({ _id: user_id });
  if (!user || !user.subscription) return;
  else await sendNotification(user.subscription, notification, user_id);
}
