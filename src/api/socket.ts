import { Server, Socket } from 'socket.io';
import {
  CommentParams,
  CommentRes,
  GetUserParams,
  MatchParams, SendMateRequestParams,
  SendParams,
  SOCKET_ENDPONTS,
  UnMatchParams
} from '../types/types';
import {
  cancelSendMateRequest,
  comment,
  getUserSubscription,
  match, refuseSendMateRequest,
  sendMateRequest,
  storeMessage,
  unMatch
} from '../mongodb';
import {
  sendNotification,
  sendNotificationIncludingSilent,
  sendNotificationUser,
  sendSilentNotification
} from '../notifications';
import {
  commentReceivedNotification,
  drawingReceivedNotification,
  matchNotification, sendFriendRequestNotification,
  unmatchNotification
} from '../config/notification.config';
import pako from 'pako';
import { silentNotification } from '../helper';

interface UserSocketMap {
  [userId: string]: Socket[];
}

const userSocketMap: UserSocketMap = {};


export function registerSocketHandlers(io: Server) {
  io.on('connection', (socket) => {
    socket.on(SOCKET_ENDPONTS.login, (params: { _id: string }) => {
      // Initialize array if not exists
      if (!userSocketMap[params._id]) {
        userSocketMap[params._id] = [];
      }

      // Add the new socket to the array
      userSocketMap[params._id].push(socket);

      // Store the socket id in the socketToUserId map
      socket.on(SOCKET_ENDPONTS.disconnect, () => {
        const index = userSocketMap[params._id].indexOf(socket);
        if (index !== -1) {
          userSocketMap[params._id].splice(index, 1);
        }

        if (userSocketMap[params._id].length === 0) {
          // If no more sockets for the user, remove the user entry
          delete userSocketMap[params._id];
        }
      });

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
    let isTextDataCompleted = false;
    socket.on(`${SOCKET_ENDPONTS.send}text_chunk`, (chunk) => {
      // Combine the chunks into one Uint8Array
      const temp = new Uint8Array(compressedData.length + chunk.length);
      temp.set(compressedData, 0);
      temp.set(chunk, compressedData.length);
      compressedData = temp;
    });

    socket.on(`${SOCKET_ENDPONTS.send}text_end`, async () => {
      isTextDataCompleted = true;
      await handleSendDataCompletion();
    });

    let imageBuffer = Buffer.alloc(0);
    let isImageDataCompleted = false;
    socket.on(`${SOCKET_ENDPONTS.send}img_chunk`, (chunk) => {
      imageBuffer = Buffer.concat([imageBuffer, Buffer.from(chunk)]);
    });

    socket.on(`${SOCKET_ENDPONTS.send}img_end`, async () => {
      isImageDataCompleted = true;
      await handleSendDataCompletion();
    });

    async function handleSendDataCompletion() {
      if (!isImageDataCompleted || !isTextDataCompleted) return;
      const decompressedTextData = pako.inflate(compressedData);
      const decoder = new TextDecoder(); // Use TextDecoder to convert Uint8Array to string
      const dataString = decoder.decode(decompressedTextData);
      const params: SendParams = JSON.parse(dataString);
      params.img = imageBuffer;
      resetBinaryData();

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
    }

    function resetBinaryData() {
      isImageDataCompleted = false;
      isTextDataCompleted = false;
      compressedData = new Uint8Array();
      imageBuffer = Buffer.alloc(0);
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
