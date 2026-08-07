import { Types } from 'mongoose';
import {
  CommentParams,
  CommentRes,
  GetInboxCommentsRes,
  GetInboxRes,
  InboxComment,
  InboxItem,
  SOCKET_ENDPONTS
} from '../../types/types';
import { InboxDocument } from '../../types/mongoose.types';
import { inbox_model } from '../../models/inbox.model';
import { user_model } from '../../models/user.model';
import { mixpanelEvents, trackEvent } from '../../mixpanel';
import { getPartialUsers } from '../../mongodb';
import { relationship_model } from '../../models/relationship.model';
import { saveMessageLogic } from './chat.service';
import { dispatchNotification } from './notification.service';
import { drawingReceivedNotification } from '../../config/notification.config';
import { inbox_comment_model } from '../../models/inbox-comment.model';
import { censorText } from './profanity.service';


export interface CreateInboxItemParams {
  sender_id: string;
  sender_name: string;
  followers: string[];
  drawing_url: string;
  image_url: string;
  thumbnail_url: string;
  aspect_ratio: number;
  sender_img: string;
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
    comments_migrated: true,
    comments: [],
    comment_count: 0
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

    // $all, not an exact array match: the pair is stored sorted, but an
    // order-sensitive lookup silently misses any legacy unsorted document and
    // the caller then creates a second relationship for the same two people.
    const rel = await relationship_model.findOne({
      users: { $all: [new Types.ObjectId(params.sender_id), new Types.ObjectId(follower)] }
    }).lean();

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
          inboxItem._id,
          params.sender_img
        )
      }
    }).catch(err => console.error('Inbox drawing dispatch failed:', err));
  }

  return inboxItem;
}

export async function commentOnInbox(params: CommentParams & { name: string }): Promise<CommentRes> {
  const createdComment = await createInboxComment(params);

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

const GALLERY_COMMENT_LIMIT = 4;

export async function getInboxItemsV2(params: {
  user_id: string,
  limit: number,
  lastDate?: Date
}): Promise<GetInboxRes> {
  try {
    const query: any = {
      followers: params.user_id,
      status: { $nin: ['under_review', 'removed'] }
    };
    if (params.lastDate) query.date = { $lt: params.lastDate };

    const docs = await inbox_model
      .find(query).sort({ date: -1 }).limit(params.limit).lean() as InboxDocument[];

    // 1. Identify which items need what
    const migratedIds = docs.filter((d: any) => d.comments_migrated).map((d: any) => d._id);
    const idsNeedingCount = docs.filter((d: any) => d.comments_migrated && typeof d.comment_count !== 'number').map((d: any) => d._id);

    let groupedComments: any[] = [];
    let groupCounts: any[] = [];

    // 2. Fetch comments and counts optimally in parallel
    if (migratedIds.length > 0) {
      const promises: Promise<any>[] = [
        // Always fetch the first 4 comments (highly optimized Top-K scan)
        inbox_comment_model.aggregate([
          { $match: { inbox_id: { $in: migratedIds }, status: 'active' } },
          {
            $group: {
              _id: '$inbox_id',
              newest: { $topN: { n: GALLERY_COMMENT_LIMIT, sortBy: { date: 1 }, output: '$$ROOT' } }
            }
          }
        ])
      ];

      // Only perform the expensive full-scan $sum for items actually missing the count
      if (idsNeedingCount.length > 0) {
        promises.push(
          inbox_comment_model.aggregate([
            { $match: { inbox_id: { $in: idsNeedingCount }, status: 'active' } },
            {
              $group: {
                _id: '$inbox_id',
                count: { $sum: 1 }
              }
            }
          ])
        );
      }

      const results = await Promise.all(promises);
      groupedComments = results[0];
      if (idsNeedingCount.length > 0) {
        groupCounts = results[1];
      }
    }

    // 3. Create lookup maps for O(1) assignment
    const commentsMap = new Map(groupedComments.map((g: any) => [g._id.toString(), g.newest]));
    const countsMap = new Map(groupCounts.map((g: any) => [g._id.toString(), g.count]));

    const backfillPromises: Promise<any>[] = [];

    // 4. Map everything together
    const inboxItems: InboxItem[] = docs.map((doc: any) => {
      let comments: InboxComment[] = [];
      let comment_count = 0;

      if (doc.comments_migrated) {
        const docIdStr = doc._id.toString();
        const newestComments = commentsMap.get(docIdStr) ?? [];

        if (typeof doc.comment_count === 'number') {
          comment_count = doc.comment_count;
        } else {
          // Pull from the secondary aggregation and trigger the backfill
          comment_count = countsMap.get(docIdStr) ?? 0;
          backfillPromises.push(
            inbox_model.updateOne({ _id: doc._id }, { $set: { comment_count } })
          );
        }

        // Reverse to oldest->newest for the drawer
        comments = newestComments.map(serializeInboxComment);
      } else {
        const active = (Array.isArray(doc.comments) ? doc.comments : [])
          .filter((c: any) => c.status !== 'under_review' && c.status !== 'removed');

        if (typeof doc.comment_count === 'number') {
          comment_count = doc.comment_count;
        } else {
          comment_count = active.length;
          backfillPromises.push(
            inbox_model.updateOne({ _id: doc._id }, { $set: { comment_count } })
          );
        }

        comments = active
          .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime())
          .slice(0, GALLERY_COMMENT_LIMIT)
          .reverse()
          .map(serializeInboxComment);
      }

      return {
        ...doc,
        comments,
        comment_count,
        _id: doc._id.toString(),
        sender: doc.sender.toString(),
        date: doc.date.toISOString()
      };
    }) as unknown as InboxItem[];

    // 5. Fire and forget the background migrations so we don't delay the API response
    if (backfillPromises.length > 0) {
      Promise.all(backfillPromises).catch(err => {
        console.error('Failed to backfill missing comment_counts during getInboxItemsV2:', err);
      });
    }

    const uniqueUserIds = Array.from(new Set(
      inboxItems.reduce((acc: string[], curr) => acc.concat(curr.original_followers), [])
    ));
    const userInfo = await getPartialUsers(uniqueUserIds);

    return { inboxItems, userInfo };
  } catch (e) {
    throw new Error('Failed to fetch inbox batch');
  }
}

export async function getInboxCommentsV2(params: {
  inbox_id: string,
  limit: number,
  beforeDate?: Date
}): Promise<GetInboxCommentsRes> {
  try {
    const doc = await inbox_model
      .findById(params.inbox_id).select('comments comments_migrated').lean() as any;
    if (!doc) throw new Error('Inbox item not found');

    if (doc.comments_migrated) {
      const q: any = { inbox_id: new Types.ObjectId(params.inbox_id), status: 'active' };
      if (params.beforeDate) q.date = { $lte: params.beforeDate }; // <= so boundary re-included; client de-dupes by _id

      const rows = await inbox_comment_model
        .find(q).sort({ date: -1 }).limit(params.limit + 1).lean();
      const hasMore = rows.length > params.limit;
      const ordered = rows.slice(0, params.limit).reverse().map((c) => serializeInboxComment(c, doc._id.toString()));
      return { comments: ordered, hasMore };
    }

    // --- legacy embedded path (unchanged) ---
    let comments = (Array.isArray(doc.comments) ? doc.comments : [])
      .filter((c: any) => c.status !== 'under_review' && c.status !== 'removed');
    comments.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
    if (params.beforeDate) {
      const cursor = params.beforeDate.getTime();
      comments = comments.filter((c: any) => new Date(c.date).getTime() <= cursor);
    }
    const hasMore = comments.length > params.limit;
    const ordered = comments.slice(0, params.limit).reverse().map(serializeInboxComment);

    return { comments: ordered, hasMore };
  } catch (e) {
    throw new Error('Failed to fetch comments batch');
  }
}

export function serializeInboxComment(c: any, inboxId?: string): InboxComment {
  return {
    _id: c._id.toString(),
    inbox_id: (c.inbox_id ?? inboxId)?.toString(),
    sender: c.sender,
    message: c.message,
    ...(c.message_filtered && { message_filtered: c.message_filtered }),
    date: (c.date instanceof Date ? c.date : new Date(c.date)).toISOString(),
    status: c.status === 'removed' ? 'removed' : 'active',
    reports_count: c.reports_count ?? 0
  };
}

export async function createInboxComment(params: CommentParams): Promise<InboxComment> {
  const inboxObjectId = new Types.ObjectId(params.inbox_id);

  const doc = await inbox_model
    .findById(inboxObjectId).select('comments comments_migrated comment_count').lean() as any;
  if (!doc) throw new Error('Inbox item not found');

  if (!doc.comments_migrated) {
    const legacy = (Array.isArray(doc.comments) ? doc.comments : []).map((c: any) => ({
      _id: c._id ?? new Types.ObjectId(),
      inbox_id: inboxObjectId,
      sender: c.sender,
      message: c.message,
      date: c.date ?? new Date(),
      status: c.status === 'removed' ? 'removed' : 'active',
      reports_count: c.reports_count ?? 0
    }));

    if (legacy.length) {
      await inbox_comment_model.insertMany(legacy, { ordered: false });
    }

    await inbox_model.updateOne(
      { _id: inboxObjectId },
      {
        $set: {
          comments_migrated: true,
          comments: [],
          comment_count: legacy.length // Initialize to current array length when migrating
        }
      }
    );
  }

  const message_filtered = censorText(params.message);

  const created = await inbox_comment_model.create({
    inbox_id: inboxObjectId,
    sender: params.sender,
    message: params.message,
    ...(message_filtered && { message_filtered }),
    date: new Date(),
    status: 'active',
    reports_count: 0
  });

  // Increment the native count
  await inbox_model.updateOne(
    { _id: inboxObjectId },
    { $inc: { comment_count: 1 } }
  );

  return serializeInboxComment(created.toObject());
}

// Reads: find a reported inbox comment in whichever store holds it.
export async function findInboxComment(
  oid: Types.ObjectId
): Promise<{ sender: Types.ObjectId; message: string } | null> {
  const fromCollection = await inbox_comment_model
    .findById(oid).select('sender message').lean() as any;
  return { sender: fromCollection.sender, message: fromCollection.message };
}

/** @return true if the comment's status actually changed. */
export async function setInboxCommentStatus(
  oid: Types.ObjectId,
  from: 'active' | 'removed' | null,
  to: 'active' | 'removed'
): Promise<boolean> {
  // collection store (migrated)
  const collMatch: any = { _id: oid };
  if (from) collMatch.status = from;

  const prev = await inbox_comment_model
    .findOneAndUpdate(collMatch, { $set: { status: to } }, { new: false })
    .select('inbox_id status').lean() as any;

  if (prev) {
    if (prev.status !== to) {
      await adjustInboxCommentCount(prev.inbox_id, to === 'active' ? 1 : -1);
      return true;
    }
  }
  return false;
}

async function adjustInboxCommentCount(inboxId: Types.ObjectId | string, delta: number) {
  const filter: any = { _id: inboxId, comment_count: { $exists: true } };
  if (delta < 0) filter.comment_count.$gt = 0;
  await inbox_model.updateOne(filter, { $inc: { comment_count: delta } });
}

export async function deleteInboxComment(params: {
  inbox_id: string;
  comment_id: string;
  requester_id: string;
}): Promise<void> {
  const cid = new Types.ObjectId(params.comment_id);

  const collComment = await inbox_comment_model
    .findById(cid).select('sender inbox_id status').lean() as any;

  if (collComment) {
    if (collComment.sender.toString() !== params.requester_id) throw new Error('FORBIDDEN');
    await inbox_comment_model.deleteOne({ _id: cid });
    if (collComment.status === 'active') await adjustInboxCommentCount(collComment.inbox_id, -1);
    return;
  }
}