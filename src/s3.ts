import {
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
  snapshots = 'snapshots-diagnostic'
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
      Key: options?.Key || uuidv4(), // Use passed Key or generate one
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
    const uniqueId = uuidv4(); // Generate a unique ID
    const filename = `${uniqueId}.${type.split('/')[1]}`; // Extract extension

    return await this.upload(
      buffer,
      {
        Bucket: bucketName,
        Key: filename, // Use the filename with extension
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
      // Only add an extension if the filename doesn't already have one
      const hasExtension = filePath.includes('.');
      const extension = fileType.split('/')[1];
      const filename = hasExtension
        ? `${uuidv4()}-${filePath}` // Keep original name + uuid to avoid collisions
        : `${uuidv4()}.${extension}`;

      const params: PutObjectCommandInput = {
        Bucket: bucketName,
        Key: filename,
        Body: fs.createReadStream(filePath),
        ContentType: fileType
      };

      await this.s3Client?.send(new PutObjectCommand(params));

      // Clean up the local file after upload so it doesn't sit on Heroku's disk
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
      // AWS throws these specific errors if the bucket is already there
      if (e.name === 'BucketAlreadyOwnedByYou' || e.name === 'BucketAlreadyExists') {
        console.log(`Bucket '${bucketName}' already exists. Proceeding...`);
      } else {
        console.error('Failed to create diagnostic bucket:', e);
        throw e;
      }
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

    // Return the CDN URL instead of the S3 URL
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
      // 1. Get list of all files in the diagnostic bucket
      const listCommand = new ListObjectsV2Command({
        Bucket: CONTAINER.snapshots
      });
      const listResponse = await this.s3Client?.send(listCommand);
      if (!listResponse) return null;

      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        console.log('No snapshots found in the lab.');
        return null;
      }

      // 2. Sort by date to find the freshest "blood sample"
      const latest = listResponse.Contents.sort((a, b) =>
        (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0)
      )[0];

      // 3. Generate a signed URL valid for 15 minutes
      const getCommand = new GetObjectCommand({
        Bucket: CONTAINER.snapshots,
        Key: latest.Key
      });

      // This creates a temporary link you can click to download the file
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
