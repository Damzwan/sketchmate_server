import { Server, Socket } from 'socket.io';
import {
  AcceptBalloonParams,
  AcceptBalloonRes,
  Balloon,
  CancelBalloonParams,
  RejectBalloonRes,
  SOCKET_ENDPONTS
} from '../../types/types';
import {
  acceptBalloon,
  acceptBalloonCleanUp,
  cancelBalloon,
  refuseBalloon,
  rejectBalloonCleanUp,
  triageWaitingRoom
} from '../balloon';
import { match } from '../../mongodb';
import {
  balloonAcceptNotification,
  balloonMatchNotification,
  balloonRejectNotification
} from '../../config/notification.config';
import { sendNotification, sendNotificationUser } from '../../notifications';
import { userSocketMap } from './socket';
import { checkSocketCapability } from '../../middleware/moderation.middleware';
import { Capability } from '../../types/moderation.policy';
import { acceptBalloonV2, cancelBalloonV2, refuseBalloonV2 } from '../services/balloon.service';

/**
 * V2 balloon socket handlers — kept for backwards compatibility with
 * pre-HTTP-migration clients. New clients use the balloon HTTP routes
 * directly. Both paths delegate to the same service functions, so the
 * server state is identical regardless of how the request arrived.
 *
 * Push-only events (server → client) still live here and stay sockets:
 *   - receive_new_balloon
 *   - balloon_missed
 *   - balloon_expired
 *   - v2_accept_balloon (emitted from the service after either entry point)
 */
export function registerV2BalloonHandlers(io: Server, socket: Socket) {

  // --- V2 REFUSE BALLOON (legacy socket path) ---
  socket.on(SOCKET_ENDPONTS.v2_refuse_balloon, async (params: {
    balloon_id: string,
    sender_id: string,
    user_id: string,
    disable: boolean,
  }) => {
    try {
      await refuseBalloonV2({
        balloon_id: params.balloon_id,
        sender_id: params.sender_id,
        user_id: params.user_id,
        disable: params.disable
      });
    } catch (err) {
      console.error('Socket refuse balloon error:', err);
    }
  });

  // --- BALLOON WAITING ROOM CHECK ---
  socket.on(SOCKET_ENDPONTS.balloon_check, async (params: { user_id: string }) => {
    void triageWaitingRoom(params.user_id, socket);
  });

  // --- V2 ACCEPT BALLOON (legacy socket path) ---
  socket.on(SOCKET_ENDPONTS.v2_accept_balloon, async (params: {
    balloon_id: string,
    sender_id: string,
    user_id: string
  }) => {
    const check = await checkSocketCapability(params.user_id, Capability.RECEIVE_BALLOON);
    if (check.blocked) {
      socket.emit('capability-blocked', {
        action: 'accept-balloon',
        restriction: check.restriction
      });
      return;
    }

    try {
      await acceptBalloonV2({
        balloon_id: params.balloon_id,
        sender_id: params.sender_id,
        user_id: params.user_id
      });
      // Service emits to both parties on its own — no extra emits needed here.
    } catch (err) {
      console.error('Socket accept balloon error:', err);
    }
  });

  // --- V2 CANCEL BALLOON (legacy socket path) ---
  socket.on(SOCKET_ENDPONTS.v2_cancel_balloon, async (params: { balloon_id: string, user_id: string }) => {
    try {
      await cancelBalloonV2({ balloon_id: params.balloon_id, user_id: params.user_id });
    } catch (err) {
      console.error('Socket cancel balloon error:', err);
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // V1 LEGACY (untouched) — kept for very old clients still in the wild.
  // ──────────────────────────────────────────────────────────────────────

  socket.on(SOCKET_ENDPONTS.accept_balloon, async (params: AcceptBalloonParams) => {
    const res = await acceptBalloon(params);
    if (!res) return;
    const [otherBalloon, balloon] = res;

    if (otherBalloon && otherBalloon.status == 'accepted') {
      await acceptBalloonCleanUp({
        balloon: balloon as unknown as Balloon,
        otherBalloon: otherBalloon as unknown as Balloon
      });

      const matchRes = await match({ _id: params.user_id, mate_id: params.sender });
      if (!matchRes) return;

      userSocketMap[params.user_id]?.forEach((s) => s.emit(SOCKET_ENDPONTS.match, { mate: matchRes.mate }));
      userSocketMap[params.sender]?.forEach((s) => s.emit(SOCKET_ENDPONTS.match, { mate: matchRes.user }));
      userSocketMap[params.sender]?.forEach((s) =>
        s.emit(SOCKET_ENDPONTS.accept_balloon, { isMatch: true, acceptor: params.user_id } as AcceptBalloonRes)
      );
      userSocketMap[params.user_id]?.forEach((s) =>
        s.emit(SOCKET_ENDPONTS.accept_balloon, { isMatch: true, acceptor: params.user_id } as AcceptBalloonRes)
      );

      if (matchRes.mate.subscriptions?.length > 0) {
        await sendNotification(matchRes.mate.subscriptions, balloonMatchNotification(matchRes.user.name));
      }
    } else {
      await sendNotificationUser(params.sender, balloonAcceptNotification());
      userSocketMap[params.sender]?.forEach((s) =>
        s.emit(SOCKET_ENDPONTS.accept_balloon, { isMatch: false, acceptor: params.user_id } as AcceptBalloonRes)
      );
      userSocketMap[params.user_id]?.forEach((s) =>
        s.emit(SOCKET_ENDPONTS.accept_balloon, { isMatch: false, acceptor: params.user_id } as AcceptBalloonRes)
      );
    }
  });

  socket.on(SOCKET_ENDPONTS.refuse_balloon, async (params: AcceptBalloonParams) => {
    const res = await refuseBalloon(params);
    if (!res) return;
    const [otherBalloon, balloon] = res;

    await sendNotificationUser(params.sender, balloonRejectNotification());
    void rejectBalloonCleanUp({
      balloon: balloon as unknown as Balloon,
      otherBalloon: otherBalloon as unknown as Balloon
    });

    userSocketMap[params.user_id]?.forEach((s) =>
      s.emit(SOCKET_ENDPONTS.refuse_balloon, { refuser: params.user_id } as RejectBalloonRes)
    );
    userSocketMap[params.sender]?.forEach((s) =>
      s.emit(SOCKET_ENDPONTS.refuse_balloon, { refuser: params.user_id } as RejectBalloonRes)
    );
  });

  socket.on(SOCKET_ENDPONTS.cancel_balloon, async (params: CancelBalloonParams) => {
    const otherBalloon = await cancelBalloon(params);
    if (!otherBalloon) return;

    await sendNotificationUser(otherBalloon.sender, balloonRejectNotification());
    userSocketMap[otherBalloon.sender]?.forEach((s) =>
      s.emit(SOCKET_ENDPONTS.refuse_balloon, { refuser: params.user_id })
    );
  });
}