import { DeleteObjectCommand, PutObjectCommand, PutObjectCommandInput, S3Client } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

export enum CONTAINER {
  drawings = 'sketchmate-drawings',
  account = 'sketchmate-account',
  stickers = 'sketchmate-stickers',
}

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
      const extension = fileType.split('/')[1]; // Extract extension
      const filename = `${uuidv4()}.${extension}`; // Generate filename with extension

      const params: PutObjectCommandInput = {
        Bucket: bucketName,
        Key: filename,
        Body: fs.createReadStream(filePath),
        ContentType: fileType
      };

      await this.s3Client?.send(new PutObjectCommand(params));
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

  private getObjectUrl(key: string, bucketName: CONTAINER): string {
    return `https://${bucketName}.s3.${process.env.AWS_REGION!}.amazonaws.com/${key}`;
  }

  public getRandomStockProfileImg(): string {
    const randomNum = Math.floor(Math.random() * 5) + 1;
    return this.getObjectUrl(`stock_${randomNum}.webp`, CONTAINER.account);
  }


}
