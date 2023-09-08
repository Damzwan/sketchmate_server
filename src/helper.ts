import { ParsedUrlQuery } from 'querystring';
import sharp from 'sharp';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import * as cron from 'node-cron';

export function parseParams<T>(params: ParsedUrlQuery | string): T {
  const newParams = typeof params === 'string' ? JSON.parse(params) : params;
  return newParams as T;
}

export function dataUrlToBuffer(dataUrl: string) {
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, ''); // Remove the data URL prefix
  return Buffer.from(base64Data, 'base64');
}

const THUMBNAIL_SIZE = 300; // Set the desired width for the thumbnail
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

export async function trimTransparentBackground(buffer: Buffer | string) {
  return await sharp(buffer).trim().toBuffer();
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
      position: 'center',
    })
    .composite([{ input: roundedMask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

const bg_url = process.env.BG_URL;

export async function removeBackground(imgUrl: string) {
  const response = await axios.post(bg_url!, undefined, {
    params: {
      url: imgUrl,
    },
  });
  return response.data.blob_url;
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
