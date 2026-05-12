import { ParsedUrlQuery } from 'querystring';
import sharp from 'sharp';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import * as cron from 'node-cron';
import { FBNotification } from './types/notification.type';
import process from 'process';
import v8 from 'v8';
import { s3Creator } from './mongodb';
import { CONTAINER } from './s3';
import { isDev } from './main';

export function parseParams<T>(params: ParsedUrlQuery | string): T {
  const newParams = typeof params === 'string' ? JSON.parse(params) : params;
  return newParams as T;
}

export function dataUrlToBuffer(dataUrl: string) {
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, ''); // Remove the data URL prefix
  return Buffer.from(base64Data, 'base64');
}

const THUMBNAIL_SIZE = 600; // Set the desired width for the thumbnail
export async function createThumbnail(buffer: Buffer | string) {
  // Create a sharp instance and get metadata
  const image = sharp(buffer);
  const metadata = await image.metadata();

  // Determine dimensions for resizing
  const resizeOptions = metadata.height! > metadata.width! ? { height: THUMBNAIL_SIZE } : { width: THUMBNAIL_SIZE };

  // Resize the image and convert to WebP format
  return await image.resize(resizeOptions).webp().toBuffer();
}

export async function compressImg(buffer: Buffer | string, size?: number) {
  let sharpInstance = sharp(buffer);
  if (size) sharpInstance = sharpInstance.resize(size);
  return await sharpInstance.webp().toBuffer();
}

export const STICKER_SIZE = 256;

export async function imgToEmblem(buffer: Buffer | string) {
  const roundedMask = Buffer.from(
    `<svg><rect x="0" y="0" width="${STICKER_SIZE}" height="${STICKER_SIZE}" rx="${STICKER_SIZE / 2}" ry="${
      STICKER_SIZE / 2
    }" fill="white" /></svg>`
  );

  return await sharp(buffer)
    .resize(STICKER_SIZE, STICKER_SIZE, {
      fit: 'cover',
      position: 'center'
    })
    .composite([{ input: roundedMask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

const bg_url = process.env.BG_URL;

export async function removeBackground(imgUrl: string) {
  const response = await axios.post(bg_url!, undefined, {
    params: {
      url: imgUrl
    }
  });
  return response.data;
}

export function scheduleResetUploadFolder() {
  const directory = 'uploads';
  cron.schedule('0 0 * * *', () => {
    fs.readdir(directory, (err, files) => {
      if (err) throw err;

      for (const file of files) {
        fs.unlink(path.join(directory, file), (err) => {
          if (err) throw err;
        });
      }
    });
  });
}


export function silentNotification(notification: FBNotification) {
  delete notification.notification;
  delete notification.android;
  return notification;
}

export const minimum_age_social_features = 13;

/**
 * Calculate age in years based on a Date of Birth
 * @param dob Date of birth
 * @returns age in years (floating point)
 */
export function calculateAge(dob: Date): number {
  const ageMs = Date.now() - dob.getTime();
  return ageMs / (1000 * 60 * 60 * 24 * 365.25);
}

/**
 * Check if the age meets a minimum requirement
 * @param dob Date of birth
 * @returns true if age >= minimumAge, false otherwise
 */
export function isOldEnough(dob: Date): boolean {
  return calculateAge(dob) >= minimum_age_social_features;
}

export function compareVersions(currentVersion: string, minimumVersion: string): number {
  const current = currentVersion.split('.').map(Number);
  const minimum = minimumVersion.split('.').map(Number);

  const maxLength = Math.max(current.length, minimum.length);

  for (let i = 0; i < maxLength; i++) {
    const v1 = current[i] || 0;
    const v2 = minimum[i] || 0;

    if (v1 < v2) return -1; // Current is older
    if (v1 > v2) return 1;  // Current is newer
  }

  return 0; // Exactly the same
}

// This lock ensures we only ever take ONE snapshot per server lifecycle
let hasTakenEmergencySnapshot = false;

export function startVitalsMonitor() {
  if (isDev) return true;
  setInterval(async () => {
    const memoryData = process.memoryUsage();
    const rssMB = Math.round(memoryData.rss / 1024 / 1024);

    console.log(`[Vitals] RAM Usage: ${rssMB}MB`);

    if (rssMB > 450 && !hasTakenEmergencySnapshot) {
      console.warn('Memory critically high! Taking ONE emergency heap snapshot...');
      hasTakenEmergencySnapshot = true;

      try {
        const fileName = `heapdump-${Date.now()}.heapsnapshot`;
        v8.writeHeapSnapshot(fileName);
        console.log(`Snapshot saved as ${fileName}. Uploading to lab...`);


        // 2. Upload the file using your existing method
        await s3Creator.uploadFile(
          fileName,
          'application/octet-stream',
          CONTAINER.snapshots
        );

        console.log('Labs successfully sent to S3!');

      } catch (err) {
        console.error('Failed to take or upload snapshot:', err);
        hasTakenEmergencySnapshot = false;
      }
    }
  }, 5000);
}

export function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}