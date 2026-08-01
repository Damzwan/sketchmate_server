import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { inbox_model } from '../../models/inbox.model';
import { post_model } from '../../models/post.model';
import { user_model } from '../../models/user.model';
import { s3Creator } from '../../mongodb';
import { CONTAINER } from '../../s3';

export type ChatBackgroundSource = 'inbox' | 'post';

const MAX_BACKGROUND_SIZE = 720;

/**
 * Removes the canvas colour without erasing matching colours enclosed inside
 * the drawing. The dominant edge colour is treated as the canvas, and only
 * pixels connected to an outer edge are cleared. A small feather keeps
 * antialiased stroke edges clean.
 */
export async function makeTransparentChatBackground(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize({
      width: MAX_BACKGROUND_SIZE,
      height: MAX_BACKGROUND_SIZE,
      fit: 'inside',
      withoutEnlargement: true
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixelCount = width * height;
  const border: number[] = [];
  for (let x = 0; x < width; x++) {
    border.push(x, (height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    border.push(y * width, y * width + width - 1);
  }

  const transparentBorder = border.filter(index => data[index * channels + 3] < 16).length;
  if (transparentBorder / Math.max(1, border.length) < 0.3) {
    const bins = new Map<number, { count: number; r: number; g: number; b: number }>();
    for (const index of border) {
      const offset = index * channels;
      if (data[offset + 3] < 16) continue;
      const key =
        (Math.floor(data[offset] / 16) << 8) |
        (Math.floor(data[offset + 1] / 16) << 4) |
        Math.floor(data[offset + 2] / 16);
      const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      bin.count++;
      bin.r += data[offset];
      bin.g += data[offset + 1];
      bin.b += data[offset + 2];
      bins.set(key, bin);
    }

    const dominant = [...bins.values()].sort((a, b) => b.count - a.count)[0];
    if (dominant) {
      const background = {
        r: dominant.r / dominant.count,
        g: dominant.g / dominant.count,
        b: dominant.b / dominant.count
      };
      const visited = new Uint8Array(pixelCount);
      const queue = new Int32Array(pixelCount);
      let head = 0;
      let tail = 0;
      const MAX_DISTANCE = 60;
      const CLEAR_DISTANCE = 24;

      const distance = (index: number) => {
        const offset = index * channels;
        return Math.sqrt(
          (data[offset] - background.r) ** 2 +
          (data[offset + 1] - background.g) ** 2 +
          (data[offset + 2] - background.b) ** 2
        );
      };
      const enqueue = (index: number) => {
        if (visited[index] || distance(index) > MAX_DISTANCE) return;
        visited[index] = 1;
        queue[tail++] = index;
      };
      border.forEach(enqueue);

      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        const d = distance(index);
        const offset = index * channels;
        const feather = Math.max(0, Math.min(1, (d - CLEAR_DISTANCE) / (MAX_DISTANCE - CLEAR_DISTANCE)));
        data[offset + 3] = Math.round(data[offset + 3] * feather);
        if (x > 0) enqueue(index - 1);
        if (x + 1 < width) enqueue(index + 1);
        if (y > 0) enqueue(index - width);
        if (y + 1 < height) enqueue(index + width);
      }
    }
  }

  return sharp(data, { raw: { width, height, channels } })
    .webp({ quality: 82, alphaQuality: 90, effort: 4 })
    .toBuffer();
}

async function resolveSourceUrl(params: {
  userId: string;
  sourceType: ChatBackgroundSource;
  sourceId: string;
}): Promise<string> {
  const { userId, sourceType, sourceId } = params;
  let sourceUrl = '';

  if (sourceType === 'inbox') {
    const item = await inbox_model.findOne({
      _id: sourceId,
      followers: userId,
      status: { $ne: 'removed' }
    }).select('image').lean();
    sourceUrl = item?.image ?? '';
  } else {
    const post = await post_model.findOne({
      _id: sourceId,
      author_id: userId,
      status: 'active'
    }).select('image_url').lean();
    sourceUrl = post?.image_url ?? '';
  }

  if (!sourceUrl) throw new Error('background_source_not_found');
  return sourceUrl;
}

export async function prepareChatBackground(params: {
  userId: string;
  sourceType: ChatBackgroundSource;
  sourceId: string;
}): Promise<string> {
  const sourceUrl = await resolveSourceUrl(params);
  const source = await s3Creator.getObjectBuffer(sourceUrl, CONTAINER.drawings);
  const processed = await makeTransparentChatBackground(source);
  // Preview data never touches S3. If the user dismisses or declines Pro, the
  // bounded data URL simply falls out of client memory and cannot become an
  // orphaned object in account storage.
  return `data:image/webp;base64,${processed.toString('base64')}`;
}

export async function confirmChatBackground(params: {
  userId: string;
  sourceType: ChatBackgroundSource;
  sourceId: string;
}): Promise<string> {
  const { userId, sourceType, sourceId } = params;
  // Re-check access at confirmation time rather than trusting the staged
  // client state if the source was deleted or removed while previewing.
  const sourceUrl = await resolveSourceUrl(params);
  const source = await s3Creator.getObjectBuffer(sourceUrl, CONTAINER.drawings);
  const processed = await makeTransparentChatBackground(source);
  const key = `chat-background-${userId}-${uuidv4()}.webp`;
  const backgroundImageUrl = await s3Creator.upload(processed, {
    Bucket: CONTAINER.account,
    Key: key,
    ContentType: 'image/webp',
    CacheControl: 'public, max-age=31536000, immutable'
  }, CONTAINER.account);

  const previous = await user_model.findByIdAndUpdate(
    userId,
    {
      $set: {
        'chat_customization.backgroundImageUrl': backgroundImageUrl,
        'chat_customization.backgroundSourceType': sourceType,
        'chat_customization.backgroundSourceId': sourceId
      }
    },
    { new: false }
  ).select('chat_customization.backgroundImageUrl').lean();

  const previousUrl = previous?.chat_customization?.backgroundImageUrl;
  if (previousUrl && previousUrl !== backgroundImageUrl) {
    s3Creator.deleteBlob(previousUrl, CONTAINER.account).catch(console.error);
  }
  return backgroundImageUrl;
}

export async function clearChatBackground(userId: string): Promise<void> {
  const previous = await user_model.findByIdAndUpdate(
    userId,
    {
      $unset: {
        'chat_customization.backgroundImageUrl': 1,
        'chat_customization.backgroundSourceType': 1,
        'chat_customization.backgroundSourceId': 1
      }
    },
    { new: false }
  ).select('chat_customization.backgroundImageUrl').lean();

  const previousUrl = previous?.chat_customization?.backgroundImageUrl;
  if (previousUrl) {
    s3Creator.deleteBlob(previousUrl, CONTAINER.account).catch(console.error);
  }
}
