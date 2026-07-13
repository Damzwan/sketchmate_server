// services/notification.service.ts
import dayjs from 'dayjs';
import { Types } from 'mongoose';
import { notification_model } from '../../models/notification.model';
import { userSocketMap } from '../socket/socket';
import { sendNotificationUser } from '../../notifications';
import { FBNotification } from '../../types/notification.type';
import { NotificationActor, NotificationKind } from '../../types/types';

const AGGREGATION_WINDOW_HOURS = 24;
const MAX_STORED_ACTORS = 3;

interface DispatchParams {
  recipient_id: string;
  type: NotificationKind;

  actor?: { _id: string; name: string; img: string };

  target_type?: string;
  target_id?: string;
  target_preview?: { thumbnail?: string; text?: string };

  aggregation_key?: string;
  payload?: any;
  aggregation_mode?: 'merge_dedupe' | 'merge_count';

  // Delivery channels — opt-in per call
  channels: {
    in_app?: boolean;
    socket?: boolean | { event: string; data: any };  // custom event override
    push?: FBNotification | false;
  };

  // Skip in-app/push if user is actively viewing this thing
  // (e.g. they're on the conversation screen for this DM)
  suppress_if_viewing?: string;  // e.g. conversation_id or post_id
}

export async function dispatchNotification(params: DispatchParams) {
  const { recipient_id, type, channels, actor } = params;

  // Don't notify yourself
  if (actor && actor._id === recipient_id) return;

  const isOnline = !!userSocketMap[recipient_id]?.length;
  const isViewing = params.suppress_if_viewing
    ? await isUserViewing(recipient_id, params.suppress_if_viewing)
    : false;

  let notification: any = null;

  // 1. In-app feed (the persistent record)
  if (channels.in_app && !isViewing) {
    notification = await upsertNotification(params);
  }

  // 2. Socket emits — bell update AND/OR legacy live-patch event
  if (isOnline) {
    const sockets = userSocketMap[recipient_id] ?? [];


    if (notification) {
      sockets.forEach((s: any) =>
        s.emit('notification:new', { notification })
      );
    }

    if (channels.socket && typeof channels.socket === 'object') {
      sockets.forEach((s: any) => {
          if (channels.socket && typeof channels.socket === 'object' && channels.socket?.event && channels.socket.data) s.emit(channels.socket.event, channels.socket.data);
        }
      );
    } else if (channels.socket === true && !notification) {
      sockets.forEach((s: any) =>
        s.emit('notification:new', { notification: null })
      );
    }
  }

  // 3. Push — send if they aren't actively viewing the specific content, regardless of online status
  if (channels.push && !isViewing) {
    await sendNotificationUser(recipient_id, channels.push);
  }

  return notification;
}

async function upsertNotification(params: DispatchParams) {
  const { recipient_id, type, actor, aggregation_key } = params;

  // No aggregation key → just insert
  if (!aggregation_key) {
    return notification_model.create({
      recipient_id: new Types.ObjectId(recipient_id),
      type,
      actors: actor ? [actor] : [],
      actor_count: actor ? 1 : 0,
      target_type: params.target_type,
      target_id: params.target_id ? new Types.ObjectId(params.target_id) : undefined,
      target_preview: params.target_preview,
      payload: params.payload,
      read: false,
      seen: false
    });
  }

  // Aggregation: find recent matching entry, merge actor into it
  const cutoff = dayjs().subtract(AGGREGATION_WINDOW_HOURS, 'hour').toDate();
  const existing = await notification_model.findOne({
    recipient_id: new Types.ObjectId(recipient_id),
    aggregation_key,
    createdAt: { $gte: cutoff }
  });

  if (existing && actor) {
    const alreadyHas = existing.actors.some(a => a._id.toString() === actor._id);

    if (alreadyHas && (params.aggregation_mode ?? 'merge_dedupe') === 'merge_dedupe') {
      return existing;  // legacy reaction behavior
    }

    if (!alreadyHas) {
      existing.actors = [toActorDoc(actor), ...existing.actors].slice(0, MAX_STORED_ACTORS);
    } else {
      existing.actors = [
        toActorDoc(actor),
        ...existing.actors.filter(a => a._id.toString() !== actor._id)
      ].slice(0, MAX_STORED_ACTORS);
    }

    existing.actor_count = (existing.actor_count || 0) + 1;
    existing.read = false;
    existing.seen = false;

    // Refresh the preview text to the latest comment
    if (params.target_preview) {
      existing.target_preview = params.target_preview;
    }

    await existing.save();
    return existing;
  }

  return notification_model.create({
    recipient_id: new Types.ObjectId(recipient_id),
    type,
    aggregation_key,
    actors: actor ? [actor] : [],
    actor_count: actor ? 1 : 0,
    target_type: params.target_type,
    target_id: params.target_id ? new Types.ObjectId(params.target_id) : undefined,
    target_preview: params.target_preview,
    payload: params.payload,
    read: false,
    seen: false
  });
}

// Stub — wire this to whatever presence/active-screen tracking you have.
// If you don't track active screen, just return false and accept some duplicate noise.
async function isUserViewing(user_id: string, target_id: string): Promise<boolean> {
  return false;
}

function toActorDoc(actor: NotificationActor) {
  return { ...actor, _id: new Types.ObjectId(actor._id) };
}