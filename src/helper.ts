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
import { user_model } from './models/user.model';
import { relationship_model } from './models/relationship.model';
import { Types } from 'mongoose';
import { UserDocument } from './types/mongoose.types';
import { post_model } from './models/post.model';
import { User } from './types/types';
import { CATALOG_BY_ID } from './config/catalog.config';

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

export function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function migrateMatesToRelationships(userId: string, legacyMates: any[]) {
  if (!legacyMates || legacyMates.length === 0) return;

  const userOID = new Types.ObjectId(userId);

  const uniqueMateIds = [...new Set(legacyMates.map(m =>
    typeof m === 'string' ? m : m._id.toString()
  ))];

  const operations: any[] = uniqueMateIds.map(mateIdStr => {
    const mateOID = new Types.ObjectId(mateIdStr);

    const sortedOIDs = [userOID, mateOID].sort((a, b) =>
      a.toString().localeCompare(b.toString())
    );

    return {
      updateOne: {
        filter: {
          'users.0': sortedOIDs[0],
          'users.1': sortedOIDs[1]
        },
        update: {
          $setOnInsert: {
            users: sortedOIDs,
            createdAt: new Date()
          },
          $set: {
            chat_status: 'mate',
            updatedAt: new Date()
          }
        },
        upsert: true
      }
    };
  });

  try {
    // We use (relationship_model as any) to bypass strict BulkWrite types if needed
    await (relationship_model as any).bulkWrite(operations, { ordered: false });
  } catch (error: any) {
    console.warn(`Migration completed with some skips for ${userId}:`, error.message);
  }
}

// Accounts created on or before launch earn the OG founder reward.
export const EARLY_TESTER_CUTOFF = new Date('2026-07-05T23:59:59Z');

// OG founder gift — the exclusive Gratitude world + Crumpled Paper effect +
// Early Tester title. Never sold (these ids aren't in the shop catalog), granted
// once during the v1 migration.
const EARLY_TESTER_GRANTS = [
  'title.early-tester',
  'world.gratitude',
  'effect.crumpled-paper'
];
const SUPPORTER_TITLE = 'title.supporter';

/**
 * Inventory items a user qualifies for, evaluated once during the v1 migration.
 * Replaces the old live POST /user/titles/sync endpoint — future stat-gated
 * grants get bumped to a new migration_version instead of a runtime re-check.
 *
 *   early-tester (+ gift) → account created on/before EARLY_TESTER_CUTOFF
 *   supporter             → owns a purchased catalog item (webhook-written only),
 *                           kept here so existing purchasers are backfilled
 */
export function migrationGrants(user: {
  createdAt?: Date;
  inventory?: string[];
}): string[] {
  const inventory = user.inventory ?? [];
  const grants: string[] = [];

  console.log(user)
  if (!user.createdAt || new Date(user.createdAt) <= EARLY_TESTER_CUTOFF) {
    grants.push(...EARLY_TESTER_GRANTS);
  }
  if (inventory.some((id) => Boolean(CATALOG_BY_ID[id]))) {
    grants.push(SUPPORTER_TITLE);
  }

  return grants.filter((id) => !inventory.includes(id));
}

export async function syncAndFinalizeMigrationStats(user: UserDocument) {
  const legacyMatesCount = user.mates?.length || 0;

  // Get post count synchronously for the response
  const postsCount = await post_model.countDocuments({
    author_id: user._id,
    status: 'active'
  });

  const initialStats = {
    mates: legacyMatesCount,
    followers: 0,
    following: 0,
    posts: postsCount
  };

  const grantedItems = migrationGrants(user);

  const update: any = {
    $set: {
      migration_version: 1,
      stats: initialStats
    }
  };
  if (grantedItems.length) {
    update.$addToSet = { inventory: { $each: grantedItems } };
  }

  await user_model.updateOne({ _id: user._id }, update);

  return { stats: initialStats, grantedItems };
}

const MAX_LIFETIME_PROMPTS = 5;
const MIN_TASKS_BEFORE_PROMPT = 3;
const BASE_COOLDOWN_DAYS = 7;

export function shouldShowThoughtPrompt(user: UserDocument): boolean {
  const meta = user.engagement_metadata;
  if (!meta) return false;
  if (meta.feedback_opted_out) return false;

  const totalShown = meta.total_thought_prompts_shown ?? 0;
  if (totalShown >= MAX_LIFETIME_PROMPTS) return false;

  const tasksDone = meta.tasks_completed_since_last_prompt ?? 0;
  if (tasksDone < MIN_TASKS_BEFORE_PROMPT) return false;

  // First-ever prompt: qualifies as soon as task threshold is met
  if (!meta.last_thought_prompt_at) return true;

  const daysSinceLastPrompt =
    (Date.now() - new Date(meta.last_thought_prompt_at).getTime()) / (1000 * 60 * 60 * 24);

  // Cooldown grows each time: 7, 14, 21, 28 days
  const requiredCooldown = BASE_COOLDOWN_DAYS * totalShown;

  return daysSinceLastPrompt >= requiredCooldown;
}