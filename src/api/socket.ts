import { Server } from 'socket.io';
import {
  CommentParams,
  CommentRes,
  GetUserParams,
  MatchParams,
  SendParams,
  SOCKET_ENDPONTS,
  UnMatchParams,
} from '../types/types';
import { comment, getUserSubscription, match, storeMessage, unMatch } from '../mongodb';
import { sendNotification, sendNotificationUser } from '../notifications';
import {
  commentReceivedNotification,
  drawingReceivedNotification,
  matchNotification,
  unmatchNotification,
} from '../config/notification.config';
import pako from 'pako';

const socketToUserId: Record<string, string> = {};
const userIdToSocket: Record<string, string> = {};

export function registerSocketHandlers(io: Server) {
  io.on('connection', (socket) => {
    socket.on(SOCKET_ENDPONTS.login, (params: GetUserParams) => {
      socketToUserId[socket.id] = params._id;
      userIdToSocket[params._id] = socket.id;
    });

    socket.on(SOCKET_ENDPONTS.match, async (params: MatchParams) => {
      try {
        const res = await match(params);
        socket.emit(SOCKET_ENDPONTS.match, res.user);
        if (userIdToSocket[params.mate_id]) io.to(userIdToSocket[params.mate_id]).emit(SOCKET_ENDPONTS.match, res.mate);
        if (res.mate.subscription) await sendNotification(res.mate.subscription, matchNotification(res.user.name));
      } catch (e) {
        socket.emit(SOCKET_ENDPONTS.match);
        if (userIdToSocket[params.mate_id]) io.to(userIdToSocket[params.mate_id]).emit(SOCKET_ENDPONTS.match);
      }
    });

    socket.on(SOCKET_ENDPONTS.unmatch, async (params: UnMatchParams) => {
      try {
        await unMatch(params);
        socket.emit(SOCKET_ENDPONTS.unmatch, true);
        if (userIdToSocket[params.mate_id]) io.to(userIdToSocket[params.mate_id]).emit(SOCKET_ENDPONTS.unmatch, true);
        const mate = await getUserSubscription({ _id: params.mate_id });
        if (mate && mate.subscription) await sendNotification(mate.subscription, unmatchNotification(params.name));
      } catch (e) {
        socket.emit(SOCKET_ENDPONTS.unmatch, false);
        if (userIdToSocket[params.mate_id]) io.to(userIdToSocket[params.mate_id]).emit(SOCKET_ENDPONTS.unmatch, false);
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
      socket.emit(SOCKET_ENDPONTS.send, inboxItem);
      if (userIdToSocket[params.mate_id]) io.to(userIdToSocket[params.mate_id]).emit(SOCKET_ENDPONTS.send, inboxItem);
      const mate = await getUserSubscription({ _id: params.mate_id });
      if (mate && mate.subscription) {
        const notification = drawingReceivedNotification(params.name, inboxItem!.thumbnail, inboxItem!._id);
        delete notification.notification;

        await Promise.all([
          sendNotification(mate.subscription, notification),
          sendNotification(
            mate.subscription,
            drawingReceivedNotification(params.name, inboxItem!.thumbnail, inboxItem!._id)
          ),
        ]);

        // We send a data message which is always received by firebase onMessageReceive
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
        inbox_item_id: params.inbox_id,
      };
      socket.emit(SOCKET_ENDPONTS.comment, commentRes);
      if (userIdToSocket[params.mate_id])
        io.to(userIdToSocket[params.mate_id]).emit(SOCKET_ENDPONTS.comment, commentRes);
      const mate = await getUserSubscription({ _id: params.mate_id });
      if (mate && mate.subscription)
        await sendNotification(mate.subscription, commentReceivedNotification(params.name, params.inbox_id));
    });

    socket.on(SOCKET_ENDPONTS.disconnect, () => {
      delete userIdToSocket[socketToUserId[socket.id]];
      delete socketToUserId[socket.id];
    });
  });
}
