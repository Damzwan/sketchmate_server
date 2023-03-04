import {
  BlobServiceClient,
  BlockBlobUploadOptions,
  ContainerClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { randomUUID } from 'crypto';

enum CONTAINERS {
  drawings = 'drawings',
}

export class BlobCreator {
  private static client: ContainerClient;

  constructor() {
    const account = process.env.blob_account;
    const accountKey = process.env.blob_key;
    if (account && accountKey) {
      const sharedKeyCredential = new StorageSharedKeyCredential(account, accountKey);
      BlobCreator.client = new BlobServiceClient(
        `https://${account}.blob.core.windows.net`,
        sharedKeyCredential
      ).getContainerClient(CONTAINERS.drawings);
      console.log('Connected to storage 🗑️');
    }
  }

  async upload(content: string | Buffer, options?: BlockBlobUploadOptions) {
    const blobName = randomUUID().toString();
    const blockBlobClient = BlobCreator.client.getBlockBlobClient(blobName);
    await blockBlobClient.upload(content, content.length, options);
    return blockBlobClient.url;
  }

  async uploadImg(dataUrl: string) {
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, ''); // Remove the data URL prefix
    const buffer = Buffer.from(base64Data, 'base64');
    return await this.upload(buffer, {
      blobHTTPHeaders: {
        blobContentType: 'image/png',
      },
    });
  }
}
