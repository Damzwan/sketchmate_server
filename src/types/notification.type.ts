import { AndroidConfig, Notification } from 'firebase-admin/lib/messaging';

export interface FBNotification {
  notification?: Notification;
  android?: any;
  data?: { [key: string]: string };
}
