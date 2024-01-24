import * as admin from 'firebase-admin';
import { FBNotification } from './types/notification.type';
import serviceAccount from '../fcm.json';
import { getUserSubscription, subscribe, unsubscribe } from './mongodb';
import { NotificationSubscription } from './types/types';
import { silentNotification } from './helper';

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as any)
});
const messaging = admin.messaging();

export async function sendNotification(subscriptions: NotificationSubscription[], notification: FBNotification) {
  try {
    await Promise.all(subscriptions.map(async (subscription) => {
      if (subscription.logged_in) {
        await messaging.send({
          ...notification,
          token: subscription.token,
        });
      }
    }));
  } catch (e) {
    console.log(e);
  }
}

export async function sendSilentNotification(subscriptions: NotificationSubscription[], notification: FBNotification) {
  try {
    await Promise.all(subscriptions.map(async (subscription) => {
      if (subscription.logged_in) {
        await messaging.send({
          ...silentNotification(notification),
          token: subscription.token,
        });
      }
    }));
  } catch (e) {
    console.log(e);
  }
}

export async function sendNotificationIncludingSilent(subscriptions: NotificationSubscription[], notification: FBNotification) {
  try {
    await Promise.all(subscriptions.map(async (subscription) => {
      if (subscription.logged_in) {
        setTimeout(async () => {
          await messaging.send({
            ...silentNotification(notification),
            token: subscription.token,
          });
        }, 5000); // Hack since we need to send silent notifications but they might interfere with normal notifications

        await messaging.send({
          ...notification,
          token: subscription.token,
        });
      }
    }));
  } catch (e) {
    console.log(e);
  }
}


export async function sendNotificationUser(user_id: string, notification: FBNotification) {
  const user = await getUserSubscription({ _id: user_id });
  if (!user || user.subscriptions.length == 0) return;
  else await sendNotification(user.subscriptions, notification);
}
