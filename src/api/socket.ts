import { Server } from 'socket.io';
import { GetUserParams, MatchParams, NotificationType, SendParams, SOCKET_ENDPONTS, UnMatchParams } from '../types';
import { match, storeMessage, unMatch } from '../mongodb';
import { sendNotification, sendNotificationToMate, sendNotificationToUser } from '../helper';

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
        await Promise.all([
          sendNotification(res.user, NotificationType.match, 'Matched!'),
          sendNotification(res.mate, NotificationType.match, 'Matched!'),
        ]);
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
        await Promise.all([
          sendNotificationToUser(params._id, NotificationType.unmatched),
          sendNotificationToUser(params.mate_id, NotificationType.unmatched),
        ]);
      } catch (e) {
        socket.emit(SOCKET_ENDPONTS.unmatch, false);
        if (userIdToSocket[params.mate_id]) io.to(userIdToSocket[params.mate_id]).emit(SOCKET_ENDPONTS.unmatch, false);
      }
    });

    socket.on(SOCKET_ENDPONTS.send, async (params: SendParams) => {
      try {
        const inboxItem = await storeMessage(params);
        socket.emit(SOCKET_ENDPONTS.send, inboxItem);
        if (userIdToSocket[params.mate_id]) io.to(userIdToSocket[params.mate_id]).emit(SOCKET_ENDPONTS.send, inboxItem);
        await sendNotificationToMate(params._id, NotificationType.message, {
          img: inboxItem,
          item: inboxItem?._id,
        });
      } catch (e) {
        console.log(e);
      }
    });

    socket.on(SOCKET_ENDPONTS.disconnect, () => {
      delete userIdToSocket[socketToUserId[socket.id]];
      delete socketToUserId[socket.id];
    });
  });
}
