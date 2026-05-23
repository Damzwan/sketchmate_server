import { Types } from 'mongoose';
import { CommentParams, CommentRes, InboxItem, SOCKET_ENDPONTS } from '../../types/types';
import { InboxDocument } from '../../types/mongoose.types';
import { inbox_model } from '../../models/inbox.model';
import { user_model } from '../../models/user.model';
import { mixpanelEvents, trackEvent } from '../../mixpanel';
import { comment } from '../../mongodb';
import { relationship_model } from '../../models/relationship.model';
import { saveMessageLogic } from './chat.service';
import { dispatchNotification } from './notification.service';
import { drawingReceivedNotification } from '../../config/notification.config';


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

  // Pull sender info once for use in actor payloads
  const senderActor = {
    _id: params.sender_id,
    name: params.sender_name,
    img: '' // see note below about img
  };


  // TODO BATCH THIS
  for (const follower of params.followers) {
    if (follower === params.sender_id) continue;

    const sortedUsers = [params.sender_id, follower].sort();
    const rel = await relationship_model.findOne({ users: sortedUsers }).lean();

    const { message, conversation } = await saveMessageLogic(
      params.sender_id,
      follower,
      '',
      rel,
      undefined,
      {
        messageMeta: { type: 'user' },
        shared_inbox_item_id: inboxItemId.toString()
      }
    );

    // Inbox drawing = DM message. The conversation is the record;
    // no bell-feed entry. Just live socket + push if offline.
    dispatchNotification({
      recipient_id: follower,
      type: 'inbox_drawing',
      actor: senderActor,
      target_type: 'inbox_item',
      target_id: inboxItem._id,
      channels: {
        in_app: false,
        socket: {
          event: 'chat:receive_message',
          data: { message, conversation, conversation_id: conversation._id.toString() }
        },
        push: drawingReceivedNotification(
          params.sender_id,
          params.sender_name,
          inboxItem.thumbnail,
          inboxItem._id
        )
      }
    }).catch(err => console.error('Inbox drawing dispatch failed:', err));
  }

  return inboxItem;
}

export async function commentOnInbox(params: CommentParams & { name: string }): Promise<CommentRes> {
  const createdComment = await comment(params);

  const commentRes: CommentRes = {
    comment: createdComment,
    inbox_item_id: params.inbox_id
  };

  // Fetch the inbox item once for the target_preview thumbnail
  const inboxItem = await inbox_model
    .findById(params.inbox_id)
    .select('thumbnail')
    .lean() as any;

  const senderActor = {
    _id: params.sender,
    name: params.name,
    img: params.img
  };

  for (const follower of params.followers) {
    if (follower === params.sender) continue;

    dispatchNotification({
      recipient_id: follower,
      type: 'inbox_comment',
      actor: senderActor,
      aggregation_mode: 'merge_count',
      aggregation_key: `inbox_comment:${params.inbox_id}`,
      target_type: 'inbox_item',
      target_id: params.inbox_id,
      target_preview: {
        thumbnail: inboxItem?.thumbnail,
        text: params.message.slice(0, 100)
      },
      channels: {
        in_app: true,
        socket: { event: SOCKET_ENDPONTS.comment, data: commentRes },
        push: false
      }
    }).catch(err => console.error('Inbox comment dispatch failed:', err));
  }

  return commentRes;
}