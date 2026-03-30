import { Server, Socket } from 'socket.io';
import { SOCKET_ENDPONTS } from '../../types/types';
import { userSocketMap } from './socket';
import { v4 as uuidv4 } from 'uuid';
import { sendNotificationUser } from '../../notifications';
import { lobbyInvitationNotification } from '../../config/notification.config';
import { mixpanelEvents, trackEvent } from '../../mixpanel';

type PublicLobby = {
  id: string;
  name: string;
  maxUsers: number;
};

const PUBLIC_LOBBY_ROOMS = new Map<string, PublicLobby>([
  ['lobby-1', { id: 'lobby-1', name: 'Pizza', maxUsers: 4 }],
  ['lobby-2', { id: 'lobby-2', name: 'Banana', maxUsers: 5 }],
  ['lobby-3', { id: 'lobby-3', name: 'Noodle', maxUsers: 7 }],
  ['lobby-4', { id: 'lobby-4', name: 'Dino', maxUsers: 4 }],
  ['lobby-5', { id: 'lobby-5', name: 'Pixel', maxUsers: 8 }],
  ['lobby-6', { id: 'lobby-6', name: 'Bubble', maxUsers: 6 }],
  ['lobby-7', { id: 'lobby-7', name: 'Toast', maxUsers: 5 }],
  ['lobby-8', { id: 'lobby-8', name: 'Kitty', maxUsers: 7 }],
  ['lobby-9', { id: 'lobby-9', name: 'Cactus', maxUsers: 4 }],
  ['lobby-10', { id: 'lobby-10', name: 'Robot', maxUsers: 6 }]
]);

export function registerDrawSyncingHandlers(io: Server, socket: Socket) {

  socket.on('join-room', async ({ roomId, intent }) => {
    const publicRoom = PUBLIC_LOBBY_ROOMS.get(roomId);
    const isPublic = !!publicRoom;
    const clients = await io.in(roomId).fetchSockets();

    if (isPublic) {
      const clients = await io.in(roomId).fetchSockets();

      if (clients.length >= publicRoom.maxUsers) {
        socket.emit('join-error', { reason: 'ROOM_FULL' });
        return;
      }
    }

    if (!isPublic && intent == 'join') {
      if (clients.length === 0) {
        socket.emit('join-error', { reason: 'ROOM_NOT_FOUND' });
        return;
      }
    }

    const existingSocket = clients.find(
      s => s.data.user?._id.toString() === socket.data.user._id.toString() && s.id !== socket.id
    );

    if (existingSocket) {
      existingSocket.emit('join-error', { reason: 'DOUBLE_JOIN' });
      existingSocket.leave(roomId);
    }

    socket.join(roomId);
    if (isPublic) broadcastLobbyOccupancy(io);

    const potentialHosts = clients.filter(s => s.id !== socket.id);
    if (potentialHosts.length > 0) {
      const host = potentialHosts[0];
      io.to(host.id).emit('request-canvas-state', {
        targetSocketId: socket.id
      });
    }

    const updatedSockets = await io.in(roomId).fetchSockets();
    socket.emit('room-joined', {
      roomId,
      users: updatedSockets.map(s => s.data.user),
      isCreator: intent === 'create' || isPublic && potentialHosts.length == 0 // first one joining public lobby
    });

    io.to(roomId).emit('user-joined', {
      user: socket.data.user,
      timestamp: new Date().toISOString(),
      id: uuidv4()
    });

    trackEvent(socket.data.user._id, mixpanelEvents.joinLobby, { isPublic: isPublic });
  });

  socket.on('disconnecting', () => {
    const rooms = Array.from(socket.rooms);
    rooms.forEach((roomId) => {
      socket.to(roomId).emit('user-left', {
        user: socket.data.user,
        timestamp: new Date().toISOString(),
        id: uuidv4()
      });

      if (PUBLIC_LOBBY_ROOMS.has(roomId)) {
        broadcastLobbyOccupancy(io);
      }

    });
  });

  socket.on('leave-room', async ({ roomId }) => {
    socket.leave(roomId);

    socket.to(roomId).emit('user-left', {
      user: socket.data.user,
      timestamp: new Date().toISOString(),
      id: uuidv4()
    });

    if (PUBLIC_LOBBY_ROOMS.has(roomId)) {
      broadcastLobbyOccupancy(io);
    }
  });

  socket.on('send-canvas-state', ({ targetSocketId, canvasState }) => {
    io.to(targetSocketId).emit('initial-canvas-state', { canvasState });

    setImmediate(() => {
      try {
        const sizeBytes = canvasState.length;
        const dataSizeKB = sizeBytes / 1024;

        trackEvent(socket.data.user._id, mixpanelEvents.canvasSize, {
          size: Math.round(dataSizeKB)
        });
      } catch (e) {
        console.error('Tracking error', e);
      }
    });
  });

  socket.on('draw-event', ({ roomId, action }) => {
    socket.to(roomId).emit('draw-event', {
      action
    });
  });

  socket.on('friend-invite', ({ roomId, friendId }) => {
    if (userSocketMap[friendId]) {
      userSocketMap[friendId].forEach((mateSocket) => {
        mateSocket.emit(SOCKET_ENDPONTS.friend_invitation, {
          friend: socket.data.user,
          roomId: roomId
        });
      });
    }
    sendNotificationUser(friendId, lobbyInvitationNotification(socket.data.user.name, roomId));
    trackEvent(socket.data.user._id, mixpanelEvents.inviteLobby);
  });

  socket.on('lobby-message', ({ roomId, message }) => {
    io.to(roomId).emit('lobby-message', {
      message,
      member: socket.data.user,
      timestamp: new Date().toISOString(),
      id: uuidv4()
    });
    trackEvent(socket.data.user._id, mixpanelEvents.messageLobby);
  });

  socket.on('watch-public-lobbies', () => {
    socket.join('public-lobby-watchers');


    // Send initial snapshot immediately
    const lobbies = Array.from(PUBLIC_LOBBY_ROOMS.values()).map(room => {
      const clients = io.sockets.adapter.rooms.get(room.id);

      return {
        id: room.id,
        name: room.name,
        users: clients ? clients.size : 0,
        maxUsers: room.maxUsers
      };
    });

    socket.emit('public-lobbies-update', lobbies);
  });

  socket.on('unwatch-public-lobbies', () => {
    socket.leave('public-lobby-watchers');
  });


}

function broadcastLobbyOccupancy(io: Server) {
  const watchers = io.sockets.adapter.rooms.get('public-lobby-watchers');

  // No one is watching → do nothing
  if (!watchers || watchers.size === 0) return;

  const lobbies = Array.from(PUBLIC_LOBBY_ROOMS.values()).map(room => {
    const clients = io.sockets.adapter.rooms.get(room.id);

    return {
      id: room.id,
      name: room.name,
      users: clients ? clients.size : 0,
      maxUsers: room.maxUsers
    };
  });

  io.to('public-lobby-watchers').emit('public-lobbies-update', lobbies);
}