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
import { isPaidTier } from '../../config/catalog.config';

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


// ---------------------------------------------------------------------------
// SNAPSHOT TRANSPORT HELPERS (v3 migration)
//
// The snapshot cache can now hold EITHER an inline gzip buffer (produced by a
// v1/v2 host) OR a CDN url (produced by a v3 host that uploaded straight to S3).
// `cachedSnapshotFormat` records which one we're holding. Delivery picks the
// right wire shape per recipient: a v3 client gets the url as-is; everyone else
// gets a buffer (fetched down from the CDN if we only have a url — the "bridge").
// ---------------------------------------------------------------------------

function hasCachedSnapshot(roomState: any): boolean {
  return roomState.cachedSnapshotFormat === 'url'
    ? !!roomState.cachedSnapshotUrl
    : !!roomState.cachedSnapshot;
}

// Bridge helper: pull a gzipped snapshot down from the CDN as a Buffer so we can
// hand it to a legacy (v1/v2) client that still expects inline bytes. Requires a
// global fetch (Node 18+). As old clients disappear this path stops being hit.
async function fetchUrlAsBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[Bridge] Snapshot fetch ${url} -> ${res.status}`);
      return null;
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    console.error('[Bridge] Failed to fetch snapshot url -> buffer:', e);
    return null;
  }
}

// Cluster-safe lookup of a socket's client version by id.
async function resolveSocketVersion(io: Server, socketId: string): Promise<string> {
  try {
    const sockets = await io.in(socketId).fetchSockets();
    return (sockets[0]?.data?.version as string) || '1';
  } catch {
    return '1';
  }
}

// Single delivery path for `initial-canvas-state`. `target` may be a socket
// object (we read .data.version directly) or a socket id string (we resolve it).
async function deliverSnapshot(
  io: Server,
  target: any,
  roomState: any,
  missedActions: any[],
  isInitialSync?: boolean,
  extra: Record<string, any> = {}
): Promise<void> {
  const targetId = typeof target === 'string' ? target : target.id;
  const version =
    typeof target !== 'string' && target.data
      ? (target.data.version || '1')
      : await resolveSocketVersion(io, targetId);

  const payload: Record<string, any> = {
    sequenceId: roomState.cachedSnapshotSequenceId,
    missedActions: missedActions || [],
    isInitialSync,
    ...extra
  };

  if (roomState.cachedSnapshotFormat === 'url') {
    if (version === '3') {
      // Modern client fetches the CDN url itself.
      payload.canvasStateUrl = roomState.cachedSnapshotUrl;
    } else {
      // BRIDGE: legacy client needs raw bytes, we only have a url.
      const buf = await fetchUrlAsBuffer(roomState.cachedSnapshotUrl);
      if (!buf) {
        io.to(targetId).emit('join-error', { reason: 'SNAPSHOT_UNAVAILABLE' });
        return;
      }
      payload.canvasState = buf;
    }
  } else {
    // Cache is a buffer; every client version can consume a buffer directly.
    payload.canvasState = roomState.cachedSnapshot;
  }

  io.to(targetId).emit('initial-canvas-state', payload);
}


function getOrCreateRoomState(roomId: any) {
  if (!ROOM_STATES.has(roomId)) {
    ROOM_STATES.set(roomId, {
      sessionId: uuidv4(),
      currentSequenceId: 0,
      actionBuffer: [],

      // Snapshot cache: buffer (v1/v2) OR url (v3). See helpers above.
      cachedSnapshot: null,
      cachedSnapshotUrl: null,
      cachedSnapshotFormat: null, // 'buffer' | 'url' | null
      cachedSnapshotSequenceId: 0,
      isRequestingSnapshot: false,
      cleanupTimeout: null,

      messageBuffer: [],
      ghostUsers: new Map(),

      // Claimed areas: lobby-scoped read-only regions, max 2 per user. Cleared
      // when the owner leaves. See claim-area / release-area handlers.
      claimedAreas: [],

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
        if (!isPaidTier(tier)) {
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
        const v1Hosts = potentialHosts.filter(s => s.data.version === '1');
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
          // The host may be v3 and will upload to S3; the resulting url is
          // bridged back to a buffer for this v1 joiner in `send-canvas-state`.
          const uploadTarget = await s3Creator.getLobbySnapshotUploadTarget(roomId);
          io.to(host.id).emit('request-canvas-state', {
            targetSocketId: socket.id,
            ...uploadTarget
          });
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
      // V2 / V3 MODERN USER
      // "modern" = anything that speaks the current sync protocol (v2 buffer or
      // v3 url). v1 hosts are handled via the legacy bridge path below.
      const modernHosts = potentialHosts.filter(s => s.data.version !== '1');
      const v1Hosts = potentialHosts.filter(s => s.data.version === '1');


      const effectiveLastSeq = lastSequenceId !== undefined ? lastSequenceId : 0;
      const oldestAvailableSeq = roomState.actionBuffer.length > 0 ? roomState.actionBuffer[0].sequenceId : 1;

      // 1. BRAND NEW JOIN (Cold Start)
      if (lastSequenceId === undefined) {
        if (hasCachedSnapshot(roomState)) {
          // We have a snapshot (buffer or url) — deliver it in the joiner's format.
          await sendFullSnapshot(socket, roomId, roomState, modernHosts, true);
        } else if (intent === 'create' && !isPublic) {
          // Seed the cache by asking the creator for a background snapshot.
          const uploadTarget = await s3Creator.getLobbySnapshotUploadTarget(roomId);
          io.to(socket.id).emit('request-canvas-state', {
            snapshotSequenceId: roomState.currentSequenceId,
            isBackgroundUpdate: true,
            ...uploadTarget
          });
        } else if (v1Hosts.length > 0) {
          // BRIDGE: only a V1 host is here. It will reply with a buffer.
          const legacyHost = v1Hosts[0];
          console.log(`[Bridge] Asking V1 Host ${legacyHost.id} for state for modern joiner`);
          const uploadTarget = await s3Creator.getLobbySnapshotUploadTarget(roomId);
          requestSnapshotWithTimeout(socket, roomId, roomState, [legacyHost], 0, uploadTarget);
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
          await sendFullSnapshot(socket, roomId, roomState, modernHosts, false);
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
      isPublic,
      claimedAreas: roomState.claimedAreas || []
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
  async function sendFullSnapshot(socket: any, roomId: any, roomState: any, modernHosts: any, isInitialSync: boolean) {
    const oldestAvailableSeq = roomState.actionBuffer.length > 0
      ? roomState.actionBuffer[0].sequenceId
      : roomState.currentSequenceId;

    const hasUnbridgeableGap = roomState.cachedSnapshotSequenceId < (oldestAvailableSeq - 1);
    const isCacheValid = hasCachedSnapshot(roomState) && !hasUnbridgeableGap;

    if (isCacheValid) {
      const missedActions = roomState.actionBuffer.filter(
        (a: any) => a.sequenceId > roomState.cachedSnapshotSequenceId
      );
      // deliverSnapshot picks buffer vs url based on the joiner's version.
      await deliverSnapshot(io, socket, roomState, missedActions, isInitialSync);
    } else if (modernHosts.length > 0) {
      // START THE TIMEOUT LOOP — generate one presigned upload target and reuse
      // it across host attempts (only the host that actually answers uses it).
      const uploadTarget = await s3Creator.getLobbySnapshotUploadTarget(roomId);
      requestSnapshotWithTimeout(socket, roomId, roomState, modernHosts, 0, uploadTarget);
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

      // Owner is really gone now — free their claimed areas for everyone.
      releaseUserAreas(roomId, userId);

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

  // ── Claimed areas ─────────────────────────────────────────────────────────
  const MAX_AREAS_PER_USER = 2;

  function releaseUserAreas(roomId: string, userId?: string) {
    if (!userId) return;
    const rs = ROOM_STATES.get(roomId);
    if (!rs || !rs.claimedAreas?.length) return;
    const uid = userId.toString();
    const removed = rs.claimedAreas.filter((a: any) => a.userId.toString() === uid);
    if (!removed.length) return;
    rs.claimedAreas = rs.claimedAreas.filter((a: any) => a.userId.toString() !== uid);
    for (const a of removed) io.to(roomId).emit('area-released', { areaId: a.id });
  }

  socket.on('claim-area', ({ roomId, area }) => {
    const userId = socket.data.user?._id?.toString();
    if (!userId || !roomId || !area) return;
    if (area.userId?.toString() !== userId) return;

    const rs = getOrCreateRoomState(roomId);
    if (!rs) return;

    const mine = rs.claimedAreas.filter((a: any) => a.userId.toString() === userId);
    if (mine.length >= MAX_AREAS_PER_USER) return;

    const x = Number(area.x), y = Number(area.y), w = Number(area.w), h = Number(area.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return;

    const clean = {
      id: String(area.id),
      userId,
      userName: socket.data.user?.name,
      x, y, w, h
    };
    // Idempotent: ignore a duplicate id (client already rendered it optimistically).
    if (rs.claimedAreas.some((a: any) => a.id === clean.id)) return;

    rs.claimedAreas.push(clean);
    io.to(roomId).emit('area-claimed', { area: clean });
  });

  socket.on('release-area', ({ roomId, areaId }) => {
    const userId = socket.data.user?._id?.toString();
    const rs = ROOM_STATES.get(roomId);
    if (!rs || !userId) return;
    const before = rs.claimedAreas.length;
    rs.claimedAreas = rs.claimedAreas.filter(
      (a: any) => !(a.id === areaId && a.userId.toString() === userId)
    );
    if (rs.claimedAreas.length !== before) io.to(roomId).emit('area-released', { areaId });
  });

  socket.on('leave-room', async ({ roomId }) => {
    releaseUserAreas(roomId, socket.data.user?._id?.toString());
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

  // A host answers a snapshot request with EITHER `url` (v3, already uploaded to
  // S3) or `canvasState` (v1/v2 buffer). We cache whichever we got and forward.
  socket.on('send-canvas-state', async ({ targetSocketId, canvasState, url, snapshotSequenceId, isBackgroundUpdate }) => {
    const roomId = socket.data.currentLobbyId;

    if (!roomId) return;

    const roomState = getOrCreateRoomState(roomId);

    // FIX: If the sequence ID is missing (V1 user),
    // we assume the snapshot represents the room "Right Now"
    const effectiveSequenceId = snapshotSequenceId !== undefined
      ? snapshotSequenceId
      : roomState.currentSequenceId;

    // Only accept into cache if newer than what we hold. Stops a slow/out-of-order
    // upload from clobbering a fresher snapshot.
    const isStale = effectiveSequenceId < roomState.cachedSnapshotSequenceId;

    if (!isStale) {
      if (url) {
        roomState.cachedSnapshotFormat = 'url';
        roomState.cachedSnapshotUrl = url;
        roomState.cachedSnapshot = null;
      } else {
        roomState.cachedSnapshotFormat = 'buffer';
        roomState.cachedSnapshot = canvasState;
        roomState.cachedSnapshotUrl = null;
      }
      roomState.cachedSnapshotSequenceId = effectiveSequenceId;
    }

    roomState.isRequestingSnapshot = false;


    if (targetSocketId && roomState.pendingTimeouts?.has(targetSocketId)) {
      clearTimeout(roomState.pendingTimeouts.get(targetSocketId));
      roomState.pendingTimeouts.delete(targetSocketId);
    }

    // Guard: targetSocketId !== socket.id prevents an infinite loop for the V1 creator
    if (targetSocketId && targetSocketId !== socket.id && !isBackgroundUpdate) {
      const missedActions = roomState.actionBuffer.filter(
        (a: any) => a.sequenceId > roomState.cachedSnapshotSequenceId
      );

      // Deliver the freshest cached snapshot in the target's expected format.
      await deliverSnapshot(io, targetSocketId, roomState, missedActions, undefined);
    }
  });

  socket.on('send-lobby-thumbnail', async ({ thumbnailBuffer, url, roomId }) => {
    if (!roomId) return;

    const roomState = getOrCreateRoomState(roomId);

    try {
      let cdnUrl: string;

      if (url) {
        // v3: client already uploaded straight to S3 with a unique key.
        cdnUrl = url;
      } else if (thumbnailBuffer) {
        // Legacy: client relayed the buffer; we upload it (old fixed-key path).
        const uploaded = await s3Creator.uploadLobbyThumbnail(thumbnailBuffer, roomId);
        cdnUrl = `${uploaded}?t=${Date.now()}`;
      } else {
        return;
      }

      roomState.lastThumbnailTime = Date.now();
      roomState.lastThumbnailSequenceId = roomState.currentSequenceId;

      const room = PUBLIC_LOBBY_ROOMS.get(roomId);
      if (room) {
        room.thumbnailUrl = cdnUrl;
        io.to('public-lobby-watchers').emit('lobby-thumbnail-pulsed', {
          roomId: roomId,
          thumbnailUrl: cdnUrl
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

    // --- The Background Snapshot Trigger ---
    const actionsSinceLastSnapshot = roomState.currentSequenceId - roomState.cachedSnapshotSequenceId;

    // Ask for an update when we reach 75% of our buffer capacity
    if (actionsSinceLastSnapshot >= (MAX_BUFFER_SIZE * 0.75) && !roomState.isRequestingSnapshot) {
      roomState.isRequestingSnapshot = true;
      const clients = await io.in(roomId).fetchSockets();

      if (clients.length > 0) {
        // Prefer a modern host so the cache becomes a lightweight url when possible.
        const host = clients.find(c => c.data.version !== '1') || clients[0];
        const uploadTarget = await s3Creator.getLobbySnapshotUploadTarget(roomId);
        io.to(host.id).emit('request-canvas-state', {
          snapshotSequenceId: roomState.currentSequenceId,
          isBackgroundUpdate: true,
          ...uploadTarget
        });
      } else {
        roomState.isRequestingSnapshot = false;
      }
    }

    // --- The Thumbnail Trigger (Time & Public-lobby based) ---
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
          const thumbTarget = await s3Creator.getLobbyThumbnailUploadTarget(roomId);
          io.to(thumbnailClient.id).emit('request-lobby-thumbnail', thumbTarget);
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

      // Snapshot/thumbnail objects in S3 are left for the lifecycle rule to
      // expire (they use unique keys). See the S3 lifecycle note.
      console.log(`Lobby ${roomId} cleared from memory.`);
    }, ROOM_CLEANUP_TIMEOUT_MS);
  }

  function requestSnapshotWithTimeout(targetSocket: any, roomId: any, roomState: any, potentialHosts: any, attemptIndex: any, uploadTarget: any) {
    // 1. Check if we've run out of hosts to ask
    if (attemptIndex >= potentialHosts.length) {
      console.warn(`[Room ${roomId}] All hosts timed out. Using Fallback.`);

      if (hasCachedSnapshot(roomState)) {
        // Deliver whatever we have cached, translated to the joiner's format.
        deliverSnapshot(io, targetSocket, roomState, [], undefined, {
          warning: 'Network unstable: Some recent drawings may be missing.'
        }).catch(e => console.error('Fallback snapshot delivery failed:', e));
      } else {
        targetSocket.emit('join-error', { reason: 'ROOM_UNRESPONSIVE' });
      }
      return;
    }

    // 2. Ask the current host in the list. v3 hosts use uploadUrl to PUT to S3;
    //    v1/v2 hosts ignore it and relay a buffer.
    const host = potentialHosts[attemptIndex];
    io.to(host.id).emit('request-canvas-state', {
      targetSocketId: targetSocket.id,
      snapshotSequenceId: roomState.currentSequenceId,
      isBackgroundUpdate: false,
      uploadUrl: uploadTarget?.uploadUrl,
      key: uploadTarget?.key,
      fetchUrl: uploadTarget?.fetchUrl
    });

    // 3. Set a strict 4-second timeout
    const timeoutId = setTimeout(() => {
      // If this triggers, the host failed us. Try the next one!
      requestSnapshotWithTimeout(targetSocket, roomId, roomState, potentialHosts, attemptIndex + 1, uploadTarget);
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