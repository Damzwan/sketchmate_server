import { Server, Socket } from 'socket.io';
import zlib from 'zlib';
import { promisify } from 'util';
import {
  CommentParams,
  CommentRes,
  MatchParams,
  SendMateRequestParams,
  SendParams,
  SOCKET_ENDPONTS,
  UnMatchParams
} from '../../types/types';
import {
  cancelSendMateRequest,
  comment,
  getUserSubscription,
  match,
  refuseSendMateRequest,
  sendMateRequest,
  storeMessage,
  unMatch
} from '../../mongodb';
import {
  sendNotification,
  sendNotificationIncludingSilent,
  sendSilentNotification
} from '../../notifications';
import {
  commentReceivedNotification,
  drawingReceivedNotification, drawingReceivedNotificationV1,
  matchNotification,
  sendFriendRequestNotification,
  unmatchNotification
} from '../../config/notification.config';
import { checkSocketCapability } from '../../middleware/moderation.middleware';
import { Capability } from '../../types/moderation.policy';
import { userSocketMap } from './socket';
import { createInboxComment } from '../services/inbox.service';

const inflateAsync = promisify(zlib.inflate);

/**
 * LEGACY (v1) socket handlers — kept for backwards compatibility with old clients.
 *
 * v2 clients use HTTP routes for these flows:
 *   - Inbox item creation: POST /inbox (client-side S3 upload + JSON publish)
 *   - Inbox comments:      POST /inbox/:inboxId/comment
 *   - Friend requests:     handled via the relationship/friend HTTP routes
 *
 * Everything in this file should be considered frozen — bug fixes only.
 */
export function registerV1Handlers(io: Server, socket: Socket) {
  // ─────────────────────────────────────────────────────────────
  // MATCH / UNMATCH
  // ─────────────────────────────────────────────────────────────

  socket.on(SOCKET_ENDPONTS.match, async (params: MatchParams) => {
    try {
      const res = await match(params);
      if (!res) return;

      if (userSocketMap[params._id]) {
        userSocketMap[params._id].forEach((associatedSocket) => {
          associatedSocket.emit(SOCKET_ENDPONTS.match, { mate: res.mate });
        });
      }

      if (userSocketMap[params.mate_id]) {
        userSocketMap[params.mate_id].forEach((associatedSocket) => {
          associatedSocket.emit(SOCKET_ENDPONTS.match, { mate: res.user });
        });
      }
      if (res.mate.subscriptions.length > 0)
        await sendNotification(res.mate.subscriptions, matchNotification(res.user.name));
    } catch (error: any) {
      if (!error || !error.message) return;
      socket.emit(SOCKET_ENDPONTS.match, { error: error.message });
      if (userSocketMap[params.mate_id]) {
        userSocketMap[params.mate_id].forEach((mateSocket) => {
          mateSocket.emit(SOCKET_ENDPONTS.match, { error: error.message });
        });
      }
    }
  });

  socket.on(SOCKET_ENDPONTS.unmatch, async (params: UnMatchParams) => {
    try {
      await unMatch(params);

      if (userSocketMap[params._id]) {
        userSocketMap[params._id].forEach((mateSocket) => {
          mateSocket.emit(SOCKET_ENDPONTS.unmatch, {
            unMatchedMateID: params.mate_id,
            gotUnMatched: false
          });
        });
      }

      if (userSocketMap[params.mate_id]) {
        userSocketMap[params.mate_id].forEach((mateSocket) => {
          mateSocket.emit(SOCKET_ENDPONTS.unmatch, {
            unMatchedMateID: params._id,
            gotUnMatched: true
          });
        });
      }

      getUserSubscription({ _id: params._id }).then(user => {
        if (user && user.subscriptions.length > 0)
          sendSilentNotification(user.subscriptions, unmatchNotification(params.name, params.mate_id, params._id));
      });

      const mate = await getUserSubscription({ _id: params.mate_id });
      if (mate && mate.subscriptions.length > 0)
        await sendNotificationIncludingSilent(mate.subscriptions, unmatchNotification(params.name, params._id, params._id));
    } catch (e) {
      console.log(e);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // LEGACY CHUNKED DRAWING UPLOAD (v1)
  // v2 clients upload directly to S3 and POST /inbox instead.
  // ─────────────────────────────────────────────────────────────

  let imageChunks: Buffer[] = [];
  let isImageDataCompleted = false;

  let textChunks: Buffer[] = [];
  let isTextDataCompleted = false;

  const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024; // 10MB safety limit
  let currentTextSize = 0;
  let currentImageSize = 0;

  const resetChunkState = () => {
    textChunks = [];
    imageChunks = [];
    isTextDataCompleted = false;
    isImageDataCompleted = false;
    currentTextSize = 0;
    currentImageSize = 0;
  };

  socket.on(`${SOCKET_ENDPONTS.send}text_chunk`, (chunk) => {
    currentTextSize += chunk.byteLength;
    if (currentTextSize > MAX_PAYLOAD_SIZE) {
      textChunks = [];
      currentTextSize = 0;
      return socket.emit('error', 'Payload too large');
    }
    textChunks.push(Buffer.from(chunk));
  });

  socket.on(`${SOCKET_ENDPONTS.send}text_end`, async () => {
    isTextDataCompleted = true;
    await handleSendDataCompletion();
  });

  socket.on(`${SOCKET_ENDPONTS.send}img_chunk`, (chunk) => {
    currentImageSize += chunk.byteLength;
    if (currentImageSize > MAX_PAYLOAD_SIZE) {
      imageChunks = [];
      currentImageSize = 0;
      return socket.emit('error', 'Payload too large');
    }
    imageChunks.push(Buffer.from(chunk));
  });

  socket.on(`${SOCKET_ENDPONTS.send}img_end`, async () => {
    isImageDataCompleted = true;
    await handleSendDataCompletion();
  });

  async function handleSendDataCompletion() {
    if (!isImageDataCompleted || !isTextDataCompleted) return;

    try {
      const imageBuffer = Buffer.concat(imageChunks);

      let compressedData = Buffer.concat(textChunks);
      textChunks = [];

      let decompressedBuffer = await inflateAsync(compressedData);
      compressedData = null as any;

      let dataString = decompressedBuffer.toString('utf-8');
      decompressedBuffer = null as any;

      const params: SendParams = JSON.parse(dataString);
      dataString = null as any;

      params.img = imageBuffer;

      const check = await checkSocketCapability(params._id, Capability.SEND_INBOX_DRAWING);
      if (check.blocked) {
        socket.emit('capability-blocked', {
          action: 'send-inbox-drawing',
          restriction: check.restriction
        });
        resetChunkState();
        return;
      }

      resetChunkState();

      let inboxItem: any = await storeMessage(params);
      inboxItem = {...inboxItem, comment_count: 0}
      if (!inboxItem) return;

      for (const follower of inboxItem.followers) {
        if (userSocketMap[follower]) {
          userSocketMap[follower].forEach((mateSocket) => {
            mateSocket.emit(SOCKET_ENDPONTS.send, inboxItem);
          });
        }

        if (follower == params._id) continue;
        const retrievedFollower = await getUserSubscription({ _id: follower });
        if (retrievedFollower && retrievedFollower.subscriptions.length > 0) {
          await sendNotificationIncludingSilent(
            retrievedFollower.subscriptions,
            drawingReceivedNotificationV1(params._id, params.name, inboxItem!.thumbnail, inboxItem!._id)
          );
        }
      }
    } catch (error) {
      console.error('Data processing failed:', error);
      resetChunkState();
    }
  }

  // Hook chunk-state cleanup into disconnect — the main handler in socket.handler.ts
  // is responsible for online/offline broadcasting; this is just memory cleanup.
  socket.on(SOCKET_ENDPONTS.disconnect, () => {
    resetChunkState();
  });

  // ─────────────────────────────────────────────────────────────
  // LEGACY COMMENT (v1)
  // v2 clients POST /inbox/:inboxId/comment instead.
  // ─────────────────────────────────────────────────────────────

  socket.on(SOCKET_ENDPONTS.comment, async (params: CommentParams) => {
    const check = await checkSocketCapability(params.sender, Capability.COMMENT_ON_INBOX);
    if (check.blocked) {
      socket.emit('capability-blocked', {
        action: 'comment-on-inbox',
        restriction: check.restriction
      });
      return;
    }

    try {
      // collection write — lazy-migrates the item's embedded comments on first write
      const createdComment = await createInboxComment(params);
      const commentRes: CommentRes = {
        comment: createdComment,
        inbox_item_id: params.inbox_id
      };

      for (const follower of params.followers) {
        if (userSocketMap[follower]) {
          userSocketMap[follower].forEach((mateSocket) => {
            mateSocket.emit(SOCKET_ENDPONTS.comment, commentRes);
          });
        }

        if (follower == params.sender) continue;
        const retrievedFollower = await getUserSubscription({ _id: follower });
        if (retrievedFollower && retrievedFollower.subscriptions.length > 0)
          await sendNotification(
            retrievedFollower.subscriptions,
            commentReceivedNotification(params.name, params.inbox_id)
          );
      }
    } catch (err) {
      // new write can throw (e.g. item not found) — old handler swallowed this silently
      console.error('inbox comment (v2) failed:', err);
      socket.emit('comment-error', { inbox_id: params.inbox_id });
    }
  });


  // ─────────────────────────────────────────────────────────────
  // LEGACY MATE REQUESTS (v1)
  // v2 clients use the HTTP friend/relationship routes instead.
  // ─────────────────────────────────────────────────────────────

  socket.on(SOCKET_ENDPONTS.mate_request, async (params: SendMateRequestParams) => {
    await sendMateRequest(params);

    if (userSocketMap[params.sender]) {
      userSocketMap[params.sender].forEach((mateSocket) => {
        mateSocket.emit(SOCKET_ENDPONTS.mate_request, params);
      });
    }
    if (userSocketMap[params.receiver]) {
      userSocketMap[params.receiver].forEach((mateSocket) => {
        mateSocket.emit(SOCKET_ENDPONTS.mate_request, params);
      });
    }
    const retrievedReceiver = await getUserSubscription({ _id: params.receiver });
    if (retrievedReceiver && retrievedReceiver.subscriptions.length > 0)
      await sendNotification(retrievedReceiver.subscriptions, sendFriendRequestNotification(params.sender_name));
  });

  socket.on(SOCKET_ENDPONTS.cancel_mate_request, async (params: SendMateRequestParams) => {
    await cancelSendMateRequest(params);
    if (userSocketMap[params.sender]) {
      userSocketMap[params.sender].forEach((mateSocket) => {
        mateSocket.emit(SOCKET_ENDPONTS.cancel_mate_request, params);
      });
    }
    if (userSocketMap[params.receiver]) {
      userSocketMap[params.receiver].forEach((mateSocket) => {
        mateSocket.emit(SOCKET_ENDPONTS.cancel_mate_request, params);
      });
    }
  });

  socket.on(SOCKET_ENDPONTS.refuse_mate_request, async (params: SendMateRequestParams) => {
    await refuseSendMateRequest(params);
    if (userSocketMap[params.sender]) {
      userSocketMap[params.sender].forEach((mateSocket) => {
        mateSocket.emit(SOCKET_ENDPONTS.refuse_mate_request, params);
      });
    }
    if (userSocketMap[params.receiver]) {
      userSocketMap[params.receiver].forEach((mateSocket) => {
        mateSocket.emit(SOCKET_ENDPONTS.refuse_mate_request, params);
      });
    }
  });
}