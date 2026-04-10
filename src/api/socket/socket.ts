import { Server, Socket } from 'socket.io';
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
import { sendNotification, sendNotificationIncludingSilent, sendSilentNotification } from '../../notifications';
import {
  commentReceivedNotification,
  drawingReceivedNotification,
  matchNotification,
  sendFriendRequestNotification,
  unmatchNotification
} from '../../config/notification.config';
import { registerDrawSyncingHandlers } from './drawSyncing';
import { registerV2BalloonHandlers } from './balloon.socket';
import { user_model } from '../../models/user.model';
import zlib from 'zlib';
import { promisify } from 'util';

const inflateAsync = promisify(zlib.inflate);

interface UserSocketMap {
  [userId: string]: Socket[];
}

export const userSocketMap: UserSocketMap = {};


export function registerSocketHandlers(io: Server) {
  io.on('connection', (socket) => {
    registerDrawSyncingHandlers(io, socket);
    registerV2BalloonHandlers(io, socket);

    socket.on(SOCKET_ENDPONTS.login, async (params: { _id: string, version: string }) => {
      // Initialize array if not exists
      if (!userSocketMap[params._id]) {
        userSocketMap[params._id] = [];
      }
      // Add the new socket to the array
      userSocketMap[params._id].push(socket);

      const user = await user_model.findById(params._id, {
        _id: 1,
        img: 1,
        name: 1,
        date_of_birth: 1
      }).lean();
      if (!user) return;
      socket.data.user = {
        _id: user._id,
        name: user.name,
        img: user.img,
        date_of_birth: user.date_of_birth,
        version: params.version || null
      };
      socket.emit(SOCKET_ENDPONTS.login);
    });

    // Store the socket id in the socketToUserId map
    socket.on(SOCKET_ENDPONTS.disconnect, () => {
      const userId = socket.data.userId;
      if (userId && userSocketMap[userId]) {
        const index = userSocketMap[userId].indexOf(socket);
        if (index !== -1) userSocketMap[userId].splice(index, 1);

        if (userSocketMap[userId].length === 0) {
          delete userSocketMap[userId];
        }
      }

      textChunks = [];
      imageChunks = [];
      isTextDataCompleted = false;
      isImageDataCompleted = false;
    });


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
          if (user && user.subscriptions.length > 0) sendSilentNotification(user.subscriptions, unmatchNotification(params.name, params.mate_id, params._id));
        });

        const mate = await getUserSubscription({ _id: params.mate_id });
        if (mate && mate.subscriptions.length > 0)
          await sendNotificationIncludingSilent(mate.subscriptions, unmatchNotification(params.name, params._id, params._id));
      } catch (e) {
        console.log(e);
      }
    });

    let compressedData = new Uint8Array();

    let imageChunks: Buffer[] = [];
    let isImageDataCompleted = false;

    let textChunks: Buffer[] = [];
    let isTextDataCompleted = false;

    socket.on(`${SOCKET_ENDPONTS.send}text_chunk`, (chunk) => {
      // HEALTHY: Just push to an array. Almost zero CPU/Memory overhead.
      textChunks.push(Buffer.from(chunk));
    });

    socket.on(`${SOCKET_ENDPONTS.send}text_end`, async () => {
      isTextDataCompleted = true;
      await handleSendDataCompletion();
    });

    socket.on(`${SOCKET_ENDPONTS.send}img_chunk`, (chunk) => {
      imageChunks.push(Buffer.from(chunk));
    });

    socket.on(`${SOCKET_ENDPONTS.send}img_end`, async () => {
      isImageDataCompleted = true;
      await handleSendDataCompletion();
    });

    async function handleSendDataCompletion() {
      if (!isImageDataCompleted || !isTextDataCompleted) return;

      try {
        // 1. Efficiently stitch the buffers together exactly once
        const compressedData = Buffer.concat(textChunks);
        const imageBuffer = Buffer.concat(imageChunks);

        // 2. Native Decompression (Handles V1 Pako and V2 Native effortlessly)
        const decompressedBuffer = await inflateAsync(compressedData);

        // 3. Node Buffers can parse directly to string, no TextDecoder needed!
        const dataString = decompressedBuffer.toString('utf-8');
        const params: SendParams = JSON.parse(dataString);

        params.img = imageBuffer;

        // 4. Clear the arrays to free up the RAM immediately
        textChunks = [];
        imageChunks = [];
        isTextDataCompleted = false;
        isImageDataCompleted = false;

        const inboxItem = await storeMessage(params);
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
              drawingReceivedNotification(params._id, params.name, inboxItem!.thumbnail, inboxItem!._id)
            );

          }
        }

      } catch (error) {
        console.error('Data processing failed:', error);
        // Don't forget to reset state on error!
        textChunks = [];
        imageChunks = [];
      }
    }


    socket.on(SOCKET_ENDPONTS.comment, async (params: CommentParams) => {
      const createdComment = await comment(params);
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
        if (retrievedFollower && retrievedFollower.subscriptions.length > 0) await sendNotification(retrievedFollower.subscriptions, commentReceivedNotification(params.name, params.inbox_id));
      }
    });

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
      if (retrievedReceiver && retrievedReceiver.subscriptions.length > 0) await sendNotification(retrievedReceiver.subscriptions, sendFriendRequestNotification(params.sender_name));
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


  });
}

export function sendSocketNotificationToUser(userId: string, socketEndpoint: string, data: any): void {
  if (!userSocketMap[userId]) return;
  userSocketMap[userId].forEach((associatedSocket) => {
    associatedSocket.emit(socketEndpoint, data);
  });
}
