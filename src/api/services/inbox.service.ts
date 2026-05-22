import { Types } from 'mongoose';
import { CommentParams, CommentRes, InboxItem, SOCKET_ENDPONTS } from '../../types/types';
import { InboxDocument } from '../../types/mongoose.types';
import { inbox_model } from '../../models/inbox.model';
import { user_model } from '../../models/user.model';
import { mixpanelEvents, trackEvent } from '../../mixpanel';
import { sendSocketNotificationToUser } from '../socket/socket';
import { comment, getUserSubscription } from '../../mongodb';
import { sendNotification, sendNotificationIncludingSilent } from '../../notifications';
import { commentReceivedNotification, drawingReceivedNotification } from '../../config/notification.config';


export interface CreateInboxItemParams {
  sender_id: string;
  sender_name: string;
  followers: string[];
  drawing_url: string;
  image_url: string;
  thumbnail_url: string;
  aspect_ratio: number;
}


export async function createInboxItem(params: CreateInboxItemParams): Promise<InboxItem> {
  const senderObjectId = new Types.ObjectId(params.sender_id);
  const inboxItemId = new Types.ObjectId();
  const date = new Date();

  const followerObjectIds = params.followers.map(f => new Types.ObjectId(f));

  const inboxItemData: Partial<InboxDocument> = {
    _id: inboxItemId,
    drawing: params.drawing_url,
    image: params.image_url,
    thumbnail: params.thumbnail_url,
    date,
    sender: senderObjectId,
    followers: followerObjectIds as any,
    aspect_ratio: params.aspect_ratio,
    original_followers: followerObjectIds as any,
    seen_by: [senderObjectId],
    comments_seen_by: [senderObjectId],
    comments: []
  };

  await Promise.all([
    inbox_model.create(inboxItemData),
    ...params.followers.map(follower =>
      user_model.updateOne({ _id: follower }, { $push: { inbox: inboxItemId.toString() } })
    )
  ]);

  trackEvent(params.sender_id, mixpanelEvents.drawing_sent);

  const inboxItem = {
    ...inboxItemData,
    _id: inboxItemId.toString(),
    sender: params.sender_id,
    followers: params.followers,
    original_followers: params.followers,
    date: date.toISOString()
  } as unknown as InboxItem;

  // Fan out: live socket emit + push notification
  for (const follower of params.followers) {
    sendSocketNotificationToUser(follower, SOCKET_ENDPONTS.send, inboxItem);

    if (follower === params.sender_id) continue;

    const retrievedFollower = await getUserSubscription({ _id: follower });
    if (retrievedFollower && retrievedFollower.subscriptions.length > 0) {
      await sendNotificationIncludingSilent(
        retrievedFollower.subscriptions,
        drawingReceivedNotification(
          params.sender_id,
          params.sender_name,
          inboxItem.thumbnail,
          inboxItem._id
        )
      );
    }
  }

  return inboxItem;
}


export async function commentOnInbox(params: CommentParams & { name: string }): Promise<CommentRes> {
  const createdComment = await comment(params);

  const commentRes: CommentRes = {
    comment: createdComment,
    inbox_item_id: params.inbox_id
  };

  for (const follower of params.followers) {
    if (follower === params.sender) continue;

    sendSocketNotificationToUser(follower, SOCKET_ENDPONTS.comment, commentRes);

    const retrievedFollower = await getUserSubscription({ _id: follower });
    if (retrievedFollower && retrievedFollower.subscriptions.length > 0) {
      await sendNotification(
        retrievedFollower.subscriptions,
        commentReceivedNotification(params.name, params.inbox_id)
      );
    }
  }

  return commentRes;
}