import { ParsedUrlQuery } from 'querystring';
import webpush from 'web-push';
import { getUser, getUserSubscription } from './mongodb';
import { NotificationType, Res, User } from './types';
import sharp from 'sharp';

export function parseParams<T>(params: ParsedUrlQuery | string): T {
  const newParams = typeof params === 'string' ? JSON.parse(params) : params;
  return newParams as T;
}

function createNotificationTitle(type: NotificationType, user: User) {
  if (type === NotificationType.match)
    return user.mate?.name ? `Matched to ${user.mate.name}` : 'You are matched!';
  else if (type === NotificationType.message)
    return `New drawing ${user.mate?.name ? `from ${user.mate.name}` : ''}`;
  else if (type === NotificationType.unmatched)
    return user.mate?.name ? `${user.mate.name} Unmatched you` : `You got unmatched`;
}

export async function sendNotificationNoUser(
  _id: string,
  type: NotificationType,
  payload = {}
) {
  const user = await getUserSubscription({ _id });
  await sendNotification(user, type, payload);
}

export async function sendNotification(
  user: Res<User>,
  type: NotificationType,
  payload = {}
) {
  if (!user || !user.subscription) return;

  const body = JSON.stringify({
    title: createNotificationTitle(type, user),
    payload: {
      ...payload,
      type: type,
    },
  });
  await webpush.sendNotification(user.subscription, body, {
    vapidDetails: {
      subject: 'mailto:damian.vlaicu@gmail.com',
      publicKey: process.env.VAPID_PUBLIC as string,
      privateKey: process.env.VAPID_PRIVATE as string,
    },
  });
}

export function dataUrlToBuffer(dataUrl: string) {
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, ''); // Remove the data URL prefix
  return Buffer.from(base64Data, 'base64');
}

const THUMBNAIL_WIDTH = 200; // Set the desired width for the thumbnail
export async function createThumbnail(buffer: Buffer) {
  return await sharp(buffer).resize(THUMBNAIL_WIDTH).jpeg({ mozjpeg: true }).toBuffer();
}

const PROFILE_WIDTH = 400; // Set the desired width for the thumbnail
export async function createProfileImg(img: string | ArrayBuffer) {
  return await sharp(img).resize(PROFILE_WIDTH).jpeg({ mozjpeg: true }).toBuffer();
}
