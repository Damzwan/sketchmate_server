import { Server, Socket } from 'socket.io';
import { SOCKET_ENDPONTS } from '../../types/types';
import { userSocketMap } from './socket';
import { v4 as uuidv4 } from 'uuid';
import { sendNotificationUser } from '../../notifications';
import { lobbyInvitationNotification } from '../../config/notification.config';
import { mixpanelEvents, trackEvent } from '../../mixpanel';
import { s3Creator } from '../../mongodb';
import { checkSocketCapability } from '../../middleware/moderation.middleware';
import { Capability } from '../../types/moderation.policy';
import { dispatchNotification } from '../services/notification.service';

interface PublicLobby {
  id: string;
  name: string;
  maxUsers: number;
  thumbnailUrl?: string;
  premiumSlots: number;
}

const PUBLIC_LOBBY_ROOMS = new Map<string, PublicLobby>([
  ['lobby-1', { id: 'lobby-1', name: 'Pizza', maxUsers: 5, premiumSlots: 2 }],
  ['lobby-2', { id: 'lobby-2', name: 'Banana', maxUsers: 5, premiumSlots: 2 }],
  ['lobby-3', { id: 'lobby-3', name: 'Noodle', maxUsers: 7, premiumSlots: 3 }],
  ['lobby-4', { id: 'lobby-4', name: 'Dino', maxUsers: 4, premiumSlots: 2 }],
  ['lobby-5', { id: 'lobby-5', name: 'Pixel', maxUsers: 8, premiumSlots: 3 }],
  ['lobby-6', { id: 'lobby-6', name: 'Bubble', maxUsers: 6, premiumSlots: 3 }],
  ['lobby-7', { id: 'lobby-7', name: 'Toast', maxUsers: 5, premiumSlots: 2 }],
  ['lobby-8', { id: 'lobby-8', name: 'Kitty', maxUsers: 7, premiumSlots: 3 }],
  ['lobby-9', { id: 'lobby-9', name: 'Cactus', maxUsers: 4, premiumSlots: 2 }],
  ['lobby-10', { id: 'lobby-10', name: 'Robot', maxUsers: 6, premiumSlots: 3 }]
]);

const ROOM_STATES = new Map();
const MAX_BUFFER_SIZE = 100;
const DISCONNECT_GRACE_PERIOD_MS = 15000;
const MAX_MESSAGE_BUFFER = 50;
const ROOM_CLEANUP_TIMEOUT_MS = 30000;
const THUMBNAIL_UPDATE_INTERVAL_MS = 15000;

const LEGACY_MODE = process.env.LEGACY_MODE === 'true';


function getOrCreateRoomState(roomId: any) {
  if (!ROOM_STATES.has(roomId)) {
    ROOM_STATES.set(roomId, {
      sessionId: uuidv4(),
      currentSequenceId: 0,
      actionBuffer: [],
      cachedSnapshot: null,
      cachedSnapshotSequenceId: 0,
      isRequestingSnapshot: false,
      cleanupTimeout: null,

      messageBuffer: [],
      ghostUsers: new Map(),

      lastThumbnailTime: 0,
      lastThumbnailSequenceId: 0,
      isRequestingThumbnail: false

    });
  }
  return ROOM_STATES.get(roomId);
}

export function registerDrawSyncingHandlers(io: Server, socket: Socket) {

  socket.on('join-room', async ({ roomId, intent, lastSequenceId, lastSessionId }) => {

    // 1. Identify the client version (defaults to '1' for existing users)
    const clientVersion = socket.handshake.query.clientVersion || '1';
    socket.data.version = clientVersion;

    const publicRoom = PUBLIC_LOBBY_ROOMS.get(roomId);
    const isPublic = !!publicRoom;
    const clients = await io.in(roomId).fetchSockets();

    if (isPublic) {
      const totalAllowed = publicRoom.maxUsers + publicRoom.premiumSlots;

      if (clients.length >= totalAllowed) {
        socket.emit('join-error', { reason: 'ROOM_FULL' });
        return;
      }
      if (clients.length >= publicRoom.maxUsers) {
        const tier = socket.data.user?.subscription_tier || 'free';
        if (tier !== 'pro') {
          socket.emit('join-error', { reason: 'ROOM_FULL' });
          return;
        }
      }
    }


    if (!isPublic && intent == 'join' && clients.length === 0) {
      socket.emit('join-error', { reason: 'ROOM_NOT_FOUND' });
      return;
    }

    const userId = socket.data.user?._id.toString();


    if (intent === 'create' && !isPublic) {
      const check = await checkSocketCapability(userId, Capability.CREATE_LOBBY);
      if (check.blocked) {
        socket.emit('join-error', {
          reason: 'CAPABILITY_BLOCKED',
          restriction: check.restriction
        });
        return;
      }
    }

    const existingSocket = clients.find(
      s => s.data.user?._id.toString() === userId && s.id !== socket.id
    );

    if (existingSocket) {
      existingSocket.emit('join-error', { reason: 'DOUBLE_JOIN' });
      existingSocket.leave(roomId);
    }

    const potentialHosts = clients.filter(s => s.id !== socket.id);


    if (LEGACY_MODE) {
      if (clientVersion === '1') {
        if (potentialHosts.find(s => s.handshake.query.clientVersion === '2')) {
          socket.join(roomId);
          socket.emit('room-joined', {
            roomId,
            users: [],
            isCreator: intent === 'create' || (isPublic && potentialHosts.length == 0),
            isPublic
          });
          setTimeout(() => {
            sendLegacyMessage(socket, `⚠️ Compatibility Check: This room is running a newer version of the
             app that isn't public yet. To avoid glitches and crashes, we've disconnected you from this lobby. Please try a different room for now—the official update drops very soon!`);
          }, 500);
          setTimeout(() => {
            socket.emit('join-error', { reason: 'OUTDATED', message: 'Please update your app' });
          }, 5000);
          return;
        }
      } else {
        const v1Hosts = potentialHosts.filter(s => s.data.version !== '2');
        if (v1Hosts.length > 0) {
          setTimeout(() => {
            socket.emit('join-error', {
              reason: 'MIGRATION',
              message: 'This lobby has v1 users, try another lobby please'
            });
          }, 500);
          return;
        }
      }

    }


    // Join the room
    socket.join(roomId);
    socket.data.currentLobbyId = roomId;
    if (isPublic) broadcastLobbyOccupancy(io);

    const roomState = getOrCreateRoomState(roomId);
    const isSessionMismatch = lastSessionId && lastSessionId !== roomState.sessionId;
    if (isSessionMismatch) {
      lastSequenceId = undefined;
    }

    // ABORT ROOM DESTRUCTION: If the room was empty and ticking down, rescue it
    if (roomState.cleanupTimeout) {
      clearTimeout(roomState.cleanupTimeout);
      roomState.cleanupTimeout = null;
    }


    // ---- THE VERSIONING SPLIT ----
    // TODO this should be cleaned up sometime
    if (clientVersion === '1') {
      if (LEGACY_MODE) {
        if (potentialHosts.length > 0) {
          const host = potentialHosts[0];
          io.to(host.id).emit('request-canvas-state', { targetSocketId: socket.id });
        }
      } else {
        setTimeout(() => {
          sendLegacyMessage(socket);
        }, 500);
        setTimeout(() => {
          socket.emit('join-error', { reason: 'OUTDATED', message: 'Please update your app' });
        }, 5000);
      }
    } else {
      // V2 MODERN USER
      const v2Hosts = potentialHosts.filter(s => s.data.version === '2');
      const v1Hosts = potentialHosts.filter(s => s.data.version !== '2');


      const effectiveLastSeq = lastSequenceId !== undefined ? lastSequenceId : 0;
      const oldestAvailableSeq = roomState.actionBuffer.length > 0 ? roomState.actionBuffer[0].sequenceId : 1;

      // 1. BRAND NEW JOIN (Cold Start)
      if (lastSequenceId === undefined) {
        if (roomState.cachedSnapshot) {
          // If we have a snapshot (from a V1 creator or previous V2 sync), use it!
          sendFullSnapshot(socket, roomId, roomState, v2Hosts, true);
        } else if (intent === 'create' && !isPublic) {
          io.to(socket.id).emit('request-canvas-state', {
            snapshotSequenceId: roomState.currentSequenceId,
            isBackgroundUpdate: true
          });
        } else if (v1Hosts.length > 0) {
          // BRIDGE: V1 user is here, but hasn't finished 'Genius Idea' upload yet
          const legacyHost = v1Hosts[0];
          console.log(`[Bridge] Asking V1 Host ${legacyHost.id} for state for V2 Joiner`);
          requestSnapshotWithTimeout(socket, roomId, roomState, [legacyHost], 0);
        } else if (effectiveLastSeq >= oldestAvailableSeq - 1) {
          const missedActions = roomState.actionBuffer.filter((a: any) => a.sequenceId > effectiveLastSeq);
          socket.emit('missed-actions', {
            actions: missedActions,
            isInitialSync: true
          });
        } else {
          socket.emit('missed-actions', { actions: [], isInitialSync: true });
        }
      }
      // 2. RECONNECTING USER (Warm Start)
      else {
        if (effectiveLastSeq >= oldestAvailableSeq - 1) {
          // FAST SYNC: They just blipped, give them the delta
          const missedActions = roomState.actionBuffer.filter((a: any) => a.sequenceId > effectiveLastSeq);
          socket.emit('missed-actions', {
            actions: missedActions,
            isInitialSync: false
          });
        } else {
          // Too far behind, give them the full snapshot
          sendFullSnapshot(socket, roomId, roomState, v2Hosts, false);
        }
      }
    }

    // ---- GHOST RESCUE & MISSED MESSAGES ----
    let isGhostRescue = false;

    if (userId && roomState.ghostUsers && roomState.ghostUsers.has(userId)) {
      isGhostRescue = true;
      const ghostData = roomState.ghostUsers.get(userId);

      // 1. Cancel the delayed "user-left" broadcast!
      clearTimeout(ghostData.timeoutId);
      roomState.ghostUsers.delete(userId);

      // 2. Send missed messages
      if (roomState.messageBuffer) {
        const missedMessages = roomState.messageBuffer
          .filter((m: any) => m.timestampMs > ghostData.disconnectTimeMs)
          .map((m: any) => m.payload);

        if (missedMessages.length > 0) {
          // Send directly to this specific socket, not the whole room
          socket.emit('missed-lobby-messages', missedMessages);
        }
      }
    }

    // ---- BROADCASTS & TRACKING ----

    const updatedSockets = await io.in(roomId).fetchSockets();
    socket.emit('room-joined', {
      roomId,
      users: updatedSockets.map(s => s.data.user),
      isCreator: intent === 'create' || (isPublic && potentialHosts.length == 0),
      sessionId: roomState.sessionId,
      isPublic
    });

    // Only announce "user-joined" if they weren't a ghost.
    // If they were a ghost, nobody knew they left, so we don't announce they joined!
    if (!isGhostRescue) {
      io.to(roomId).emit('user-joined', {
        user: socket.data.user,
        timestamp: new Date().toISOString(),
        id: uuidv4()
      });
    }

    trackEvent(userId, mixpanelEvents.joinLobby, { isPublic });
  });

// Helper function to handle sending the snapshot
  function sendFullSnapshot(socket: any, roomId: any, roomState: any, potentialHosts: any, isInitialSync: boolean) {
    const oldestAvailableSeq = roomState.actionBuffer.length > 0
      ? roomState.actionBuffer[0].sequenceId
      : roomState.currentSequenceId;

    const hasUnbridgeableGap = roomState.cachedSnapshotSequenceId < (oldestAvailableSeq - 1);
    const isCacheValid = roomState.cachedSnapshot && !hasUnbridgeableGap;

    if (isCacheValid) {
      const missedActions = roomState.actionBuffer.filter(
        (a: any) => a.sequenceId > roomState.cachedSnapshotSequenceId
      );
      socket.emit('initial-canvas-state', {
        canvasState: roomState.cachedSnapshot,
        sequenceId: roomState.cachedSnapshotSequenceId,
        missedActions: missedActions,
        isInitialSync
      });
    } else if (potentialHosts.length > 0) {
      // START THE TIMEOUT LOOP
      requestSnapshotWithTimeout(socket, roomId, roomState, potentialHosts, 0);
    }
  }


  socket.on('disconnecting', () => {
    const roomId = socket.data.currentLobbyId;
    const userId = socket.data.user?._id.toString();

    if (!roomId) return;

    const roomState = ROOM_STATES.get(roomId);
    if (!roomState) return;

    const timeoutId = setTimeout(() => {
      roomState.ghostUsers.delete(userId);

      io.to(roomId).emit('user-left', {
        user: socket.data.user,
        timestamp: new Date().toISOString(),
        id: uuidv4()
      });

      if (PUBLIC_LOBBY_ROOMS.has(roomId)) {
        broadcastLobbyOccupancy(io);
      }
    }, DISCONNECT_GRACE_PERIOD_MS);

    if (userId) {
      roomState.ghostUsers.set(userId, {
        disconnectTimeMs: Date.now(),
        timeoutId: timeoutId
      });
    }

    const room = io.sockets.adapter.rooms.get(roomId);
    if (room && room.size === 1) {
      scheduleRoomCleanup(roomId);
    }
  });

  socket.on('leave-room', async ({ roomId }) => {
    socket.leave(roomId);
    socket.data.currentLobbyId = null;

    socket.to(roomId).emit('user-left', {
      user: socket.data.user,
      timestamp: new Date().toISOString(),
      id: uuidv4()
    });

    if (PUBLIC_LOBBY_ROOMS.has(roomId)) {
      broadcastLobbyOccupancy(io);
    }

    // Since they already left, the room might not exist anymore, or its size is 0.
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room || room.size === 0) {
      scheduleRoomCleanup(roomId);
    }
  });

  socket.on('send-canvas-state', ({ targetSocketId, canvasState, snapshotSequenceId, isBackgroundUpdate }) => {
    const roomId = socket.data.currentLobbyId;

    if (!roomId) return;

    const roomState = getOrCreateRoomState(roomId);

    // FIX: If the sequence ID is missing (V1 user),
    // we assume the snapshot represents the room "Right Now"
    const effectiveSequenceId = snapshotSequenceId !== undefined
      ? snapshotSequenceId
      : roomState.currentSequenceId;

    roomState.cachedSnapshot = canvasState;
    roomState.cachedSnapshotSequenceId = effectiveSequenceId;
    roomState.isRequestingSnapshot = false;


    if (targetSocketId && roomState.pendingTimeouts?.has(targetSocketId)) {
      clearTimeout(roomState.pendingTimeouts.get(targetSocketId));
      roomState.pendingTimeouts.delete(targetSocketId);
    }

    // Guard: targetSocketId !== socket.id prevents an infinite loop for the V1 creator
    if (targetSocketId && targetSocketId !== socket.id && !isBackgroundUpdate) {
      const missedActions = roomState.actionBuffer.filter(
        (a: any) => a.sequenceId > effectiveSequenceId
      );

      io.to(targetSocketId).emit('initial-canvas-state', {
        canvasState,
        sequenceId: effectiveSequenceId,
        missedActions
      });
    }
  });

  socket.on('send-lobby-thumbnail', async ({ thumbnailBuffer, roomId }) => {
    if (!roomId) return;

    const roomState = getOrCreateRoomState(roomId);

    try {
      const cdnUrl = await s3Creator.uploadLobbyThumbnail(thumbnailBuffer, roomId);

      roomState.lastThumbnailTime = Date.now();
      roomState.lastThumbnailSequenceId = roomState.currentSequenceId;

      const cacheBustedUrl = `${cdnUrl}?t=${Date.now()}`;

      const room = PUBLIC_LOBBY_ROOMS.get(roomId);
      if (room) {
        room.thumbnailUrl = cacheBustedUrl;
        io.to('public-lobby-watchers').emit('lobby-thumbnail-pulsed', {
          roomId: roomId,
          thumbnailUrl: cacheBustedUrl
        });
      }

    } catch (e) {
      console.error('Failed to process lobby thumbnail:', e);
    } finally {
      roomState.isRequestingThumbnail = false;
    }
  });

  socket.on('draw-event', async ({ roomId, action }) => {
    const roomState = getOrCreateRoomState(roomId);

    roomState.currentSequenceId += 1;

    roomState.actionBuffer.push({ sequenceId: roomState.currentSequenceId, ...action, userId: socket.data.user._id });
    if (roomState.actionBuffer.length > MAX_BUFFER_SIZE) {
      roomState.actionBuffer.shift();
    }

    socket.to(roomId).emit('draw-event', {
      sequenceId: roomState.currentSequenceId,
      action,
      creator: socket.data.user._id
    });

    // --- NEW: The Background Trigger ---
    const actionsSinceLastSnapshot = roomState.currentSequenceId - roomState.cachedSnapshotSequenceId;

    // Ask for an update when we reach 75% of our buffer capacity
    if (actionsSinceLastSnapshot >= (MAX_BUFFER_SIZE * 0.75) && !roomState.isRequestingSnapshot) {
      roomState.isRequestingSnapshot = true;
      const clients = await io.in(roomId).fetchSockets();

      if (clients.length > 0) {
        io.to(clients[0].id).emit('request-canvas-state', {
          snapshotSequenceId: roomState.currentSequenceId,
          isBackgroundUpdate: true
        });
      } else {
        roomState.isRequestingSnapshot = false;
      }
    }

    // --- 2. THE THUMBNAIL TRIGGER (Time & Public-lobby based) ---
    const isPublic = PUBLIC_LOBBY_ROOMS.has(roomId);

    if (isPublic && !roomState.isRequestingThumbnail) {
      const now = Date.now();
      const timeSinceLastThumbnail = now - roomState.lastThumbnailTime;
      const actionsSinceLastThumbnail = roomState.currentSequenceId - roomState.lastThumbnailSequenceId;

      // Only trigger if enough time has passed AND the canvas actually changed
      if (timeSinceLastThumbnail >= THUMBNAIL_UPDATE_INTERVAL_MS && actionsSinceLastThumbnail > 0) {
        roomState.isRequestingThumbnail = true;
        roomState.lastThumbnailTime = now;
        roomState.lastThumbnailSequenceId = roomState.currentSequenceId;

        const clients = await io.in(roomId).fetchSockets();

        if (clients.length > 0) {
          // Load balance: pick the second client if available
          const thumbnailClient = clients.length > 1 ? clients[1] : clients[0];
          io.to(thumbnailClient.id).emit('request-lobby-thumbnail');
        } else {
          roomState.isRequestingThumbnail = false;
        }
      }
    }
  });


  // socket handler
  socket.on('friend-invite', ({ roomId, friendId }) => {
    dispatchNotification({
      recipient_id: friendId,
      type: 'lobby_invitation',
      actor: {
        _id: socket.data.user._id,
        name: socket.data.user.name,
        img: socket.data.user.img
      },
      channels: {
        in_app: false,
        socket: {
          event: SOCKET_ENDPONTS.friend_invitation,
          data: { friend: socket.data.user, roomId }
        },
        push: lobbyInvitationNotification(socket.data.user.name, socket.data.user.img, roomId)
      }
    }).catch(err => console.error('Lobby invite dispatch failed:', err));

    trackEvent(socket.data.user._id, mixpanelEvents.inviteLobby);
  });

  socket.on('lobby-message', ({ roomId, message, tempId }) => {
    const roomState = getOrCreateRoomState(roomId);

    const payload = {
      message,
      member: socket.data.user,
      timestamp: new Date().toISOString(),
      id: tempId ? tempId : uuidv4()
    };

    // Add to buffer and enforce size limit
    roomState.messageBuffer.push({
      payload: payload,
      timestampMs: Date.now()
    });
    if (roomState.messageBuffer.length > MAX_MESSAGE_BUFFER) {
      roomState.messageBuffer.shift();
    }

    io.to(roomId).emit('lobby-message', payload);
    trackEvent(socket.data.user._id, mixpanelEvents.messageLobby);
  });


  function scheduleRoomCleanup(roomId: string) {
    const roomState = ROOM_STATES.get(roomId);
    if (!roomState) return;

    if (roomState.cleanupTimeout) {
      clearTimeout(roomState.cleanupTimeout);
    }

    roomState.cleanupTimeout = setTimeout(() => {
      const publicLobby = PUBLIC_LOBBY_ROOMS.get(roomId);
      if (publicLobby) {
        publicLobby.thumbnailUrl = undefined;
        io.to('public-lobby-watchers').emit('lobby-thumbnail-pulsed', {
          roomId: roomId,
          thumbnailUrl: undefined
        });
      }

      ROOM_STATES.delete(roomId);

      console.log(`Lobby ${roomId} cleared from memory. S3 file left for overwrite.`);
    }, ROOM_CLEANUP_TIMEOUT_MS);
  }

  function requestSnapshotWithTimeout(targetSocket: any, roomId: any, roomState: any, potentialHosts: any, attemptIndex: any) {
    // 1. Check if we've run out of hosts to ask
    if (attemptIndex >= potentialHosts.length) {
      console.warn(`[Room ${roomId}] All hosts timed out. Using Fallback.`);

      if (roomState.cachedSnapshot) {
        targetSocket.emit('initial-canvas-state', {
          canvasState: roomState.cachedSnapshot,
          sequenceId: roomState.cachedSnapshotSequenceId,
          missedActions: [], // We accept the gap. Better than a dead UI.
          warning: 'Network unstable: Some recent drawings may be missing.'
        });
      } else {
        targetSocket.emit('join-error', { reason: 'ROOM_UNRESPONSIVE' });
      }
      return;
    }

    // 2. Ask the current host in the list
    const host = potentialHosts[attemptIndex];
    io.to(host.id).emit('request-canvas-state', {
      targetSocketId: targetSocket.id,
      snapshotSequenceId: roomState.currentSequenceId,
      isBackgroundUpdate: false
    });

    // 3. Set a strict 4-second timeout
    const timeoutId = setTimeout(() => {
      // If this triggers, the host failed us. Try the next one!
      requestSnapshotWithTimeout(targetSocket, roomId, roomState, potentialHosts, attemptIndex + 1);
    }, 4000);

    // 4. Save the timeout ID so we can cancel it if the host DOES reply
    roomState.pendingTimeouts = roomState.pendingTimeouts || new Map();
    roomState.pendingTimeouts.set(targetSocket.id, timeoutId);
  }

  socket.on('watch-public-lobbies', () => {
    socket.join('public-lobby-watchers');


    const lobbies = Array.from(PUBLIC_LOBBY_ROOMS.values()).map(room => {
      const clients = io.sockets.adapter.rooms.get(room.id);

      return {
        id: room.id,
        name: room.name,
        users: clients ? clients.size : 0,
        maxUsers: room.maxUsers,
        thumbnailUrl: room.thumbnailUrl,
        premiumSlots: room.premiumSlots,
      };
    });

    socket.emit('public-lobbies-update', lobbies);
  });

  socket.on('unwatch-public-lobbies', () => {
    socket.leave('public-lobby-watchers');
  });


}

let lobbyUpdateTimeout: any | null = null;

function broadcastLobbyOccupancy(io: Server) {
  if (lobbyUpdateTimeout) return;

  lobbyUpdateTimeout = setTimeout(() => {
    lobbyUpdateTimeout = null;

    const watchers = io.sockets.adapter.rooms.get('public-lobby-watchers');
    if (!watchers || watchers.size === 0) return;

    const lobbies = Array.from(PUBLIC_LOBBY_ROOMS.values()).map(room => {
      const clients = io.sockets.adapter.rooms.get(room.id);
      return {
        id: room.id,
        name: room.name,
        users: clients ? clients.size : 0,
        maxUsers: room.maxUsers,
        thumbnailUrl: room.thumbnailUrl,
        premiumSlots: room.premiumSlots,
      };
    });

    io.to('public-lobby-watchers').emit('public-lobbies-update', lobbies);
  }, 1000); // 1-second debounce
}

function sendLegacyMessage(socket: any, message?: string) {
  const payload = {
    message: message ? message : `⚠️ SYSTEM:
Your app version is outdated.

Please update the app or refresh the page to join this lobby.
You will be disconnected. I am sorry :(`,
    member: {
      _id: 'system',
      name: 'Creator',
      img: 'https://sketchmate-account.s3.eu-west-3.amazonaws.com/stock_4.webp'
    },
    timestamp: new Date().toISOString(),
    id: uuidv4()
  };

  socket.emit('lobby-message', payload);
}

export function getPublicLobbiesSnapshot(io: Server) {
  return Array.from(PUBLIC_LOBBY_ROOMS.values()).map(room => {
    const clients = io.sockets.adapter.rooms.get(room.id);
    return {
      id: room.id,
      name: room.name,
      users: clients ? clients.size : 0,
      maxUsers: room.maxUsers,
      premiumSlots: room.premiumSlots,
      thumbnailUrl: room.thumbnailUrl,
    };
  });
}

