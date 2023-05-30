import {
  BlobServiceClient,
  BlockBlobUploadOptions,
  ContainerClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { randomUUID } from 'crypto';

export enum CONTAINER {
  drawings = 'drawings',
  account = 'account',
  stickers = 'stickers',
}

interface ContainerDictionary {
  [key: string]: ContainerClient;
}

export class BlobCreator {
  private containerClients: ContainerDictionary = {};

  constructor() {
    const account = process.env.blob_account;
    const accountKey = process.env.blob_key;
    if (account && accountKey) {
      const sharedKeyCredential = new StorageSharedKeyCredential(account, accountKey);
      Object.values(CONTAINER).forEach((container) => {
        this.containerClients[container] = new BlobServiceClient(
          `https://${account}.blob.core.windows.net`,
          sharedKeyCredential
        ).getContainerClient(container);
      });
      console.log('Connected to storage 🗑️');
    }
  }

  async upload(content: string | Buffer, options?: BlockBlobUploadOptions, container = CONTAINER.drawings) {
    const blockBlobClient = this.containerClients[container].getBlockBlobClient(randomUUID().toString());
    await blockBlobClient.upload(content, content.length, options);
    return blockBlobClient.url;
  }

  async uploadImg(buffer: Buffer, container = CONTAINER.drawings, type = 'image/jpg') {
    return await this.upload(
      buffer,
      {
        blobHTTPHeaders: {
          blobContentType: type,
        },
      },
      container
    );
  }

  async uploadFile(filePath: string, fileType: string, container: CONTAINER) {
    try {
      const fileName = randomUUID().toString();
      const blobClient = this.containerClients[container].getBlockBlobClient(fileName);
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

  async deleteBlob(blobUrl: string, container: CONTAINER) {
    const blobName = blobUrl.substring(blobUrl.lastIndexOf('/') + 1);
    const blobClient = this.containerClients[container].getBlobClient(blobName);
    await blobClient.deleteIfExists();
  }
}
