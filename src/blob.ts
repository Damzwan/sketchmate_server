import {
  BlobServiceClient,
  BlockBlobUploadOptions,
  ContainerClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { randomUUID } from 'crypto';

export enum CONTAINERS {
  drawings = 'drawings',
  account = 'account',
}

export class BlobCreator {
  private static drawings: ContainerClient;
  private static account: ContainerClient;

  constructor() {
    const account = process.env.blob_account;
    const accountKey = process.env.blob_key;
    if (account && accountKey) {
      const sharedKeyCredential = new StorageSharedKeyCredential(account, accountKey);
      BlobCreator.drawings = new BlobServiceClient(
        `https://${account}.blob.core.windows.net`,
        sharedKeyCredential
      ).getContainerClient(CONTAINERS.drawings);

      BlobCreator.account = new BlobServiceClient(
        `https://${account}.blob.core.windows.net`,
        sharedKeyCredential
      ).getContainerClient(CONTAINERS.account);
      console.log('Connected to storage 🗑️');
    }
  }

  async upload(
    content: string | Buffer,
    options?: BlockBlobUploadOptions,
    client = CONTAINERS.drawings
  ) {
    const blobClient =
      client === CONTAINERS.drawings ? BlobCreator.drawings : BlobCreator.account;
    const blobName = randomUUID().toString();
    const blockBlobClient = blobClient.getBlockBlobClient(blobName);
    await blockBlobClient.upload(content, content.length, options);
    return blockBlobClient.url;
  }

  async uploadImg(buffer: Buffer, client = CONTAINERS.drawings) {
    return await this.upload(buffer, {
      blobHTTPHeaders: {
        blobContentType: 'image/png',
      },
    });
  }

  async uploadFile(filePath: string, fileType: string) {
    try {
      const fileName = randomUUID().toString();
      const blobClient = BlobCreator.account.getBlockBlobClient(fileName);
      await blobClient.uploadFile(filePath, {
        blobHTTPHeaders: {
          blobContentType: fileType,
        },
      });
      return blobClient.url;
    } catch (e) {
      console.log(e);
    }
  }

  async deleteBlob(blobUrl: string, container: CONTAINERS) {
    const blobName = blobUrl.substring(blobUrl.lastIndexOf('/') + 1);
    const client =
      container === CONTAINERS.drawings ? BlobCreator.drawings : BlobCreator.account;
    const blobClient = client.getBlobClient(blobName);
    await blobClient.deleteIfExists();
  }
}
