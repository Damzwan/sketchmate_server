import { AndroidConfig, Notification } from 'firebase-admin/lib/messaging';

export interface FBNotification {
  notification?: Notification;
  android?: AndroidConfig;
  data?: { [key: string]: string };
}
