import { Server, Socket } from 'socket.io';
import { SOCKET_ENDPONTS } from '../../types/types';
import { user_model } from '../../models/user.model';
import { registerDrawSyncingHandlers } from './drawSyncing';
import { registerV2BalloonHandlers } from './balloon.socket';
import { registerChatHandlers } from './chat.socket';
import { registerV1Handlers } from './v1.socket';
import { RelationshipDocument, UserDocument } from '../../types/mongoose.types';
import { relationship_model } from '../../models/relationship.model';
import { Types } from 'mongoose';
import { PUBLIC_USER_FIELDS } from '../../types/projections';

interface UserSocketMap {
  [userId: string]: Socket[];
}

export const userSocketMap: UserSocketMap = {};

export function registerSocketHandlers(io: Server) {
  io.on('connection', (socket) => {
    registerDrawSyncingHandlers(io, socket);
    registerV2BalloonHandlers(io, socket);
    registerChatHandlers(io, socket);
    registerV1Handlers(io, socket);

    socket.on(SOCKET_ENDPONTS.login, async (params: { _id: string, version: string }) => {
      const userIdString = params._id;

      try {
        if (!userSocketMap[userIdString]) {
          userSocketMap[userIdString] = [];
        }
        userSocketMap[userIdString].push(socket);

        const [user, relationships] = await Promise.all([
          user_model.findById(userIdString)
            .select(PUBLIC_USER_FIELDS + ' date_of_birth')
            .lean() as unknown as UserDocument | null,
          relationship_model.find({
            users: new Types.ObjectId(userIdString),
            chat_status: { $in: ['mate', 'temporary', 'pending_mate', 'expired'] }
          }).select('users').lean() as unknown as RelationshipDocument[]
        ]);

        if (!user) {
          socket.emit(SOCKET_ENDPONTS.login, { status: 'error', message: 'User not found' });
          return;
        }

        socket.data.user = {
          _id: userIdString,
          name: user.name,
          img: user.img,
          date_of_birth: user.date_of_birth,
          version: params.version || null,
          customization: user.customization
        };
        socket.join(userIdString);

        const watcherSet = new Set<string>();
        relationships.forEach(rel => {
          rel.users.forEach(p => {
            const pId = p.toString();
            if (pId !== userIdString) watcherSet.add(pId);
          });
        });

        const watcherRooms = Array.from(watcherSet);

        if (watcherRooms.length > 0) {
          socket.to(watcherRooms).emit('friend:online', {
            user_id: userIdString,
            status: 'online',
            last_seen_version: user.last_seen_version
          });
        }

        socket.emit(SOCKET_ENDPONTS.login, { status: 'success' });

      } catch (error: any) {
        console.error('Login Socket Error:', error);
        socket.emit(SOCKET_ENDPONTS.login, { status: 'error', message: error.message });
      }
    });

    socket.on(SOCKET_ENDPONTS.disconnect, async () => {
      const userId = socket.data.user?._id?.toString();

      if (userId && userSocketMap[userId]) {
        const index = userSocketMap[userId].indexOf(socket);
        if (index !== -1) userSocketMap[userId].splice(index, 1);

        // If this was their LAST active socket, tell friends they are offline
        if (userSocketMap[userId].length === 0) {
          delete userSocketMap[userId];

          try {
            const relationships = await relationship_model.find({
              users: new Types.ObjectId(userId),
              chat_status: { $in: ['mate', 'temporary', 'pending_mate', 'expired'] }
            }).select('users').lean();

            const watcherSet = new Set<string>();
            relationships.forEach(rel => {
              rel.users.forEach(p => {
                const pId = p.toString();
                if (pId !== userId) watcherSet.add(pId);
              });
            });

            const watcherRooms = Array.from(watcherSet);

            if (watcherRooms.length > 0) {
              socket.to(watcherRooms).emit('friend:offline', { user_id: userId });
            }
          } catch (error) {
            console.error('Error broadcasting offline status:', error);
          }
        }
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

export async function isUserOnline(io: Server, userId: string): Promise<boolean> {
  if (!io) return false;
  const sockets = await io.in(userId.toString()).fetchSockets();
  return sockets.length > 0;
}