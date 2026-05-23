import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command,
  PutObjectCommand,
  PutObjectCommandInput,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

export enum CONTAINER {
  drawings = 'sketchmate-drawings',
  account = 'sketchmate-account',
  stickers = 'sketchmate-stickers',
  snapshots = 'snapshots-diagnostic',
  moderation_snapshots = 'sketchmate-moderation-snapshots'
}

const CDN_URL = 'https://d5xw0rxlv2zqt.cloudfront.net';

export const getCdnUrl = (path: string) => {
  if (!path) return '';
  return `${CDN_URL}/${path}`;
};

export class S3Creator {
  private s3Client: S3Client | undefined;

  constructor() {
    const region = process.env.AWS_REGION;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (region && accessKeyId && secretAccessKey) {
      this.s3Client = new S3Client({
        region,
        credentials: { accessKeyId, secretAccessKey }
      });
      console.log('Connected to S3 ️');
    }
  }

  async upload(
    content: string | Buffer,
    options?: PutObjectCommandInput,
    bucketName = CONTAINER.drawings
  ): Promise<string> {
    const mergedOptions = {
      ...options,
      Bucket: bucketName,
      Key: options?.Key || uuidv4(),
      Body: content
    };
    await this.s3Client?.send(new PutObjectCommand(mergedOptions));
    return this.getObjectUrl(mergedOptions.Key!, bucketName);
  }

  async uploadImg(
    buffer: Buffer,
    bucketName = CONTAINER.drawings,
    type = 'image/webp'
  ): Promise<string> {
    const uniqueId = uuidv4();
    const filename = `${uniqueId}.${type.split('/')[1]}`;

    return await this.upload(
      buffer,
      {
        Bucket: bucketName,
        Key: filename,
        ContentType: type
      },
      bucketName
    );
  }


  async uploadFile(
    filePath: string,
    fileType: string,
    bucketName: CONTAINER
  ): Promise<string> {
    try {
      const hasExtension = filePath.includes('.');
      const extension = fileType.split('/')[1];
      const filename = hasExtension
        ? `${uuidv4()}-${filePath}`
        : `${uuidv4()}.${extension}`;

      const params: PutObjectCommandInput = {
        Bucket: bucketName,
        Key: filename,
        Body: fs.createReadStream(filePath),
        ContentType: fileType
      };

      await this.s3Client?.send(new PutObjectCommand(params));
      fs.promises.unlink(filePath).catch(console.error);

      return this.getObjectUrl(filename, bucketName);
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  async deleteBlob(blobUrl: string, bucketName: CONTAINER) {
    const blobName = blobUrl.substring(blobUrl.lastIndexOf('/') + 1);
    const params = {
      Bucket: bucketName,
      Key: blobName
    };
    await this.s3Client?.send(new DeleteObjectCommand(params));
  }

  async deleteObjects(keys: string[], bucketName: CONTAINER) {
    if (!keys || keys.length === 0) return;

    const params = {
      Bucket: bucketName,
      Delete: {
        Objects: keys.map(key => ({ Key: key })),
        Quiet: true
      }
    };
    await this.s3Client?.send(new DeleteObjectsCommand(params));
  }

  async createBucketIfMissing(bucketName: string): Promise<void> {
    try {
      await this.s3Client?.send(new CreateBucketCommand({ Bucket: bucketName }));
      console.log(`Diagnostic bucket '${bucketName}' created successfully.`);
    } catch (e: any) {
      if (e.name === 'BucketAlreadyOwnedByYou' || e.name === 'BucketAlreadyExists') {
        console.log(`Bucket '${bucketName}' already exists. Proceeding...`);
      } else {
        console.error('Failed to create diagnostic bucket:', e);
        throw e;
      }
    }
  }

  /**
   * Server-side copy of a single object from one bucket to another.
   * Used for moderation snapshots — we clone the live thumbnail so that
   * when the original is deleted (by the author or by an upheld removal),
   * the moderator can still review what was reported.
   *
   * Returns the public-looking URL of the cloned object (still in the
   * snapshot bucket, not the CDN — kept private). Returns null on failure;
   * callers should never fail a report submission because the snapshot
   * couldn't be cloned. An incomplete snapshot is better than no report.
   */
  async cloneToSnapshot(sourceUrl: string, sourceBucket: CONTAINER): Promise<string | null> {
    if (!sourceUrl) return null;
    if (!this.s3Client) return null;

    try {
      // Extract the key from the URL. Works for both direct S3 URLs and CDN URLs.
      const key = sourceUrl.substring(sourceUrl.lastIndexOf('/') + 1);
      if (!key) return null;

      // Snapshot key includes a timestamp prefix so when we list the bucket
      // for an admin dashboard we can sort by report date naturally.
      const datePrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const destKey = `${datePrefix}/${uuidv4()}-${key}`;

      await this.s3Client.send(new CopyObjectCommand({
        Bucket: CONTAINER.moderation_snapshots,
        // CopySource format: "{source-bucket}/{source-key}", URL-encoded
        CopySource: encodeURIComponent(`${sourceBucket}/${key}`)
      } as any));

      return this.getObjectUrl(destKey, CONTAINER.moderation_snapshots);
    } catch (e) {
      console.error('Snapshot clone failed:', e);
      return null;
    }
  }

  /**
   * Generates a short-lived signed URL for a snapshot so the mod dashboard
   * can render it without making the bucket public. 15-minute expiry —
   * long enough to review, short enough that leaked links die fast.
   */
  async getSnapshotSignedUrl(snapshotUrl: string): Promise<string | null> {
    if (!snapshotUrl || !this.s3Client) return null;
    try {
      const key = snapshotUrl.substring(snapshotUrl.lastIndexOf('/') + 1);
      const getCommand = new GetObjectCommand({
        Bucket: CONTAINER.moderation_snapshots,
        Key: key
      });
      return await getSignedUrl(this.s3Client as any, getCommand as any, { expiresIn: 900 });
    } catch (e) {
      console.error('Failed to sign snapshot URL:', e);
      return null;
    }
  }

  async uploadLobbyThumbnail(
    buffer: Buffer,
    roomId: string,
    bucketName = CONTAINER.drawings
  ): Promise<string> {
    const key = `public-lobbies/${roomId}.webp`;

    await this.upload(
      buffer,
      {
        Bucket: bucketName,
        Key: key,
        ContentType: 'image/webp',
        CacheControl: 'no-cache, no-store, must-revalidate'
      },
      bucketName
    );

    return `${CDN_URL}/${key}`;
  }

  async getPresignedUploadUrl(
    contentType: string,
    bucketName = CONTAINER.drawings
  ): Promise<{ signedUrl: string; key: string; publicUrl: string }> {
    try {
      const extension = contentType.split('/')[1] || 'bin';
      const key = `public-posts/${uuidv4()}.${extension}`;

      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        ContentType: contentType
      });

      const signedUrl = await getSignedUrl(this.s3Client as any, command as any, { expiresIn: 300 });

      return {
        signedUrl,
        key,
        publicUrl: getCdnUrl(key)
      };
    } catch (error) {
      console.error('Error generating pre-signed URL:', error);
      throw new Error('Could not generate upload URL');
    }
  }

  async getLatestSnapshotUrl(): Promise<string | null> {
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: CONTAINER.snapshots
      });
      const listResponse = await this.s3Client?.send(listCommand);
      if (!listResponse) return null;

      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        console.log('No snapshots found in the lab.');
        return null;
      }

      const latest = listResponse.Contents.sort((a, b) =>
        (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0)
      )[0];

      const getCommand = new GetObjectCommand({
        Bucket: CONTAINER.snapshots,
        Key: latest.Key
      });

      const url = await getSignedUrl(this.s3Client as any, getCommand as any, { expiresIn: 900 });
      return url;
    } catch (e) {
      console.error('Failed to retrieve snapshot URL:', e);
      return null;
    }
  }


  private getObjectUrl(key: string, bucketName: CONTAINER): string {
    return `https://${bucketName}.s3.${process.env.AWS_REGION!}.amazonaws.com/${key}`;
  }

  public getRandomStockProfileImg(): string {
    const randomNum = Math.floor(Math.random() * 5) + 1;
    return this.getObjectUrl(`stock_${randomNum}.webp`, CONTAINER.account);
  }


}