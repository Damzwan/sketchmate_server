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
      Object.values(CONTAINERS).forEach((container) => {
        this.containerClients[container] = new BlobServiceClient(
          `https://${account}.blob.core.windows.net`,
          sharedKeyCredential
        ).getContainerClient(container);
      });
      console.log('Connected to storage 🗑️');
    }
  }

  async upload(content: string | Buffer, options?: BlockBlobUploadOptions, container = CONTAINERS.drawings) {
    const blockBlobClient = this.containerClients[container].getBlockBlobClient(randomUUID().toString());
    await blockBlobClient.upload(content, content.length, options);
    return blockBlobClient.url;
  }

  async uploadImg(buffer: Buffer, container = CONTAINERS.drawings) {
    return await this.upload(
      buffer,
      {
        blobHTTPHeaders: {
          blobContentType: 'image/png',
        },
      },
      container
    );
  }

  async uploadFile(filePath: string, fileType: string, container: CONTAINERS) {
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

  async deleteBlob(blobUrl: string, container: CONTAINERS) {
    const blobName = blobUrl.substring(blobUrl.lastIndexOf('/') + 1);
    const blobClient = this.containerClients[container].getBlobClient(blobName);
    await blobClient.deleteIfExists();
  }
}
