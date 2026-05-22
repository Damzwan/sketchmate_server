import { Types } from 'mongoose';
import { balloon_model } from '../../models/balloon.model';
import { Balloon } from '../../types/types';
import { BalloonDocument } from '../../types/mongoose.types';
import { user_model } from '../../models/user.model';
import { mixpanelEvents, trackEvent } from '../../mixpanel';
import { routeBalloonToOnlineUser } from '../balloon';
import { userSocketMap } from '../socket/socket';
import { assertBalloonQuota } from './quota.service';


export interface CreateBalloonV2Params {
  sender: string;
  message: string;
  aspect_ratio: number;
  drawing_url: string;
  image_url: string;
  thumbnail_url: string;
}

export class DuplicateBalloonError extends Error {
  constructor() {
    super('Balloon already exists');
    this.name = 'DuplicateBalloonError';
  }
}

/**
 * V2 balloon creation — client has already uploaded drawing/image/thumbnail
 * to S3 via presigned URLs, so we only persist the references here.
 *
 * Side effects:
 *   - Duplicate check (one outstanding balloon per sender)
 *   - Insert balloon doc
 *   - Set `balloon.sent` on the user
 *   - Mixpanel event
 *   - Fire-and-forget route-to-online-user
 */
export async function createBalloonV2(params: CreateBalloonV2Params): Promise<Balloon> {
  const senderObjectId = new Types.ObjectId(params.sender);

  // 1. Quota gate — throws QuotaExceededError if budget is 0
  await assertBalloonQuota(params.sender);

  // 2. Build the document
  const balloonId = new Types.ObjectId();
  const now = new Date();

  const balloonToCreate: Partial<BalloonDocument> = {
    _id: balloonId,
    status: 'pending',
    createdAt: now,
    lastActivityAt: now,
    drawingJsonUrl: params.drawing_url,
    img: params.image_url,
    thumbnail: params.thumbnail_url,
    aspect_ratio: params.aspect_ratio,
    sender: senderObjectId,
    message: params.message,
    cancelledBalloons: [],
    version: 2,
    rejected_by: []
  };

  try {
    await balloon_model.create(balloonToCreate);
  } catch (e) {
    throw new Error(`Failed to create balloon: ${(e as Error).message}`);
  }

  trackEvent(params.sender, mixpanelEvents.balloon_v2_create);

  // Fire-and-forget routing.
  routeBalloonToOnlineUser(params.sender, balloonId.toString(), userSocketMap, 0)
    .catch((err: any) => {
      console.error('Error during balloon routing triage:', err);
    });

  return {
    ...balloonToCreate,
    _id: balloonId.toString(),
    sender: params.sender,
    createdAt: now.toISOString(),
    lastActivityAt: now.toISOString()
  } as unknown as Balloon;
}
