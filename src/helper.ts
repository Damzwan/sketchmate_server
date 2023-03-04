import { ParsedUrlQuery } from 'querystring';
import webpush from 'web-push';
import { getUser } from './mongodb';
import { Notifications } from './types';

const conversion = {};

export function parseParams<T>(params: ParsedUrlQuery | string): T {
  const newParams = typeof params === 'string' ? JSON.parse(params) : params;

  for (const [key, value] of Object.entries(newParams)) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    newParams[key] = conversion[key] ? conversion[key](value) : value;
  }

  return newParams as T;
}

export async function sendNotification(_id: string, notification: Notifications) {
  const user = await getUser({ _id });
  if (!user || !user.subscription) return;
  await webpush.sendNotification(user.subscription, notification, {
    vapidDetails: {
      subject: 'mailto:damian.vlaicu@gmail.com',
      publicKey: process.env.VAPID_PUBLIC as string,
      privateKey: process.env.VAPID_PRIVATE as string,
    },
  });
}
