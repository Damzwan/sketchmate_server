import { Server, Socket } from 'socket.io';
import {
  AcceptBalloonParams,
  AcceptBalloonRes, Balloon,
  CancelBalloonParams,
  RejectBalloonRes,
  SOCKET_ENDPONTS
} from '../../types/types';
import { user_model } from '../../models/user.model';
import {
  acceptBalloon,
  acceptBalloonCleanUp,
  activeBalloonHolders,
  activeBalloonSkips,
  activeBalloonTimeouts,
  cancelBalloon,
  refuseBalloon,
  rejectBalloonCleanUp,
  routeBalloonToOnlineUser,
  triageWaitingRoom,
  v2AcceptBalloonCleanUp,
  deleteBalloonS3
} from '../balloon';
import { match } from '../../mongodb';
import {
  balloonAcceptNotification,
  balloonMatchNotification,
  balloonRejectNotification
} from '../../config/notification.config';
import { sendNotification, sendNotificationUser } from '../../notifications';
import { balloon_model } from '../../models/balloon.model';
import { userSocketMap } from './socket';
import { mixpanelEvents, trackEvent } from '../../mixpanel';


export function registerV2BalloonHandlers(io: Server, socket: Socket) {

  socket.on(SOCKET_ENDPONTS.v2_refuse_balloon, async (params: {
    balloon_id: string,
    sender_id: string,
    user_id: string,
    disable: boolean,
  }) => {
    // 1. Clear in-memory locks
    if (activeBalloonTimeouts.has(params.balloon_id)) {
      clearTimeout(activeBalloonTimeouts.get(params.balloon_id)!);
      activeBalloonTimeouts.delete(params.balloon_id);
    }
    activeBalloonHolders.delete(params.balloon_id);

    // 2. Update the user's rate limit
    user_model.findByIdAndUpdate(params.user_id, {
      $set: {
        'balloon.last_received_at': new Date(),
        'balloon.disabled': params.disable ?? false
      }
    }).catch(err => console.error('Rate limit error:', err));

    // 3. NEW: Permanently add this user to the balloon's rejected list
    const balloon = await balloon_model.findByIdAndUpdate(
      params.balloon_id,
      { $addToSet: { rejected_by: params.user_id } },
      { new: true } // Returns the updated document
    );

    // 4. Reroute (The skip list in RAM is optional now, but good for speed)
    if (!activeBalloonSkips.has(params.balloon_id)) {
      activeBalloonSkips.set(params.balloon_id, new Set());
    }
    activeBalloonSkips.get(params.balloon_id)!.add(params.user_id);

    if (balloon && balloon.status === 'pending') {
      await routeBalloonToOnlineUser(params.sender_id, params.balloon_id, userSocketMap, 0, balloon);
    }
    if (params.disable) trackEvent(params.user_id, mixpanelEvents.balloon_v2_stop);
    else trackEvent(params.user_id, mixpanelEvents.balloon_v2_refuse);
  });

  socket.on(SOCKET_ENDPONTS.balloon_check, async (params: { user_id: string }) => {
    void triageWaitingRoom(params.user_id, socket);
  });

  socket.on(SOCKET_ENDPONTS.v2_accept_balloon, async (params: {
    balloon_id: string,
    sender_id: string,
    user_id: string
  }) => {
    // 1. Stabilize the patient (Clear the timer)
    if (activeBalloonTimeouts.has(params.balloon_id)) {
      clearTimeout(activeBalloonTimeouts.get(params.balloon_id)!);
      activeBalloonTimeouts.delete(params.balloon_id);
    }

    // 2. Update acceptor's rate-limiting vital signs
    activeBalloonHolders.delete(params.balloon_id);
    activeBalloonSkips.delete(params.balloon_id);

    void user_model.findByIdAndUpdate(params.user_id, {
      $set: {
        'balloon.last_received_at': new Date()
      }
    }).catch(err => console.error('error:', err));

    // 3. Secure the balloon record
    const balloon = await balloon_model.findByIdAndUpdate(params.balloon_id, {
      $set: {
        status: 'accepted',
        matchedAt: new Date(),
        pairedUser: params.user_id
      }
    }, { new: true });

    if (!balloon) return;

    // 4. Execute the Match Procedure
    const matchRes = await match({ _id: params.user_id, mate_id: params.sender_id });
    if (!matchRes) return;

    // 5. Fetch the acceptor to extract their name for the notification
    const acceptor = await user_model.findById(params.user_id);
    if (!acceptor) return;

    // 6. Perform the Inbox Transplant (Cleanup)
    const inboxItem = await v2AcceptBalloonCleanUp(balloon, params.user_id);

    // 7. Send Push Notification to the Sender
    await sendNotificationUser(
      params.sender_id,
      balloonMatchNotification(`${acceptor.name} caught your balloon!`)
    );


    // -> Alert the SENDER
    if (userSocketMap[params.sender_id]) {
      userSocketMap[params.sender_id].forEach((s: any) => {
        s.emit(SOCKET_ENDPONTS.v2_accept_balloon, { mate: matchRes.user, acceptorId: params.user_id, inboxItem });
      });
    }

    // -> Alert the ACCEPTOR
    if (userSocketMap[params.user_id]) {
      userSocketMap[params.user_id].forEach((s: any) => {
        s.emit(SOCKET_ENDPONTS.v2_accept_balloon, { mate: matchRes.mate, acceptorId: params.user_id, inboxItem });
      });
    }

    trackEvent(params.user_id, mixpanelEvents.balloon_v2_accept);
  });


  socket.on(SOCKET_ENDPONTS.accept_balloon, async (params: AcceptBalloonParams) => {
    const res = await acceptBalloon(params);
    if (!res) return;
    const [otherBalloon, balloon] = res;
    if (otherBalloon && otherBalloon.status == 'accepted') {
      await acceptBalloonCleanUp({ balloon, otherBalloon });

      const res = await match({ _id: params.user_id, mate_id: params.sender });
      if (!res) return;

      if (userSocketMap[params.user_id]) {
        userSocketMap[params.user_id].forEach((associatedSocket) => {
          associatedSocket.emit(SOCKET_ENDPONTS.match, { mate: res.mate });
        });
      }

      if (userSocketMap[params.sender]) {
        userSocketMap[params.sender].forEach((associatedSocket) => {
          associatedSocket.emit(SOCKET_ENDPONTS.match, { mate: res.user });
        });
      }
      if (userSocketMap[params.sender]) {
        userSocketMap[params.sender].forEach((associatedSocket) => {
          associatedSocket.emit(SOCKET_ENDPONTS.accept_balloon, {
            isMatch: true,
            acceptor: params.user_id
          } as AcceptBalloonRes);
        });
      }

      if (userSocketMap[params.user_id]) {
        userSocketMap[params.user_id].forEach((associatedSocket) => {
          associatedSocket.emit(SOCKET_ENDPONTS.accept_balloon, {
            isMatch: true,
            acceptor: params.user_id
          } as AcceptBalloonRes);
        });
      }
      if (res.mate.subscriptions.length > 0)
        await sendNotification(res.mate.subscriptions, balloonMatchNotification(res.user.name));
    } else {
      await sendNotificationUser(params.sender, balloonAcceptNotification());
      if (userSocketMap[params.sender]) {
        userSocketMap[params.sender].forEach((associatedSocket) => {
          associatedSocket.emit(SOCKET_ENDPONTS.accept_balloon, {
            isMatch: false,
            acceptor: params.user_id
          } as AcceptBalloonRes);
        });
      }
      if (userSocketMap[params.user_id]) {
        userSocketMap[params.user_id].forEach((associatedSocket) => {
          associatedSocket.emit(SOCKET_ENDPONTS.accept_balloon, {
            isMatch: false,
            acceptor: params.user_id
          } as AcceptBalloonRes);
        });
      }
    }
  });

  socket.on(SOCKET_ENDPONTS.refuse_balloon, async (params: AcceptBalloonParams) => {
    const res = await refuseBalloon(params);
    if (!res) return;
    const [otherBalloon, balloon] = res;

    await sendNotificationUser(params.sender, balloonRejectNotification());
    void rejectBalloonCleanUp({ balloon, otherBalloon });

    if (userSocketMap[params.user_id]) {
      userSocketMap[params.user_id].forEach((associatedSocket) => {
        associatedSocket.emit(SOCKET_ENDPONTS.refuse_balloon, { refuser: params.user_id } as RejectBalloonRes);
      });
    }

    if (userSocketMap[params.sender]) {
      userSocketMap[params.sender].forEach((associatedSocket) => {
        associatedSocket.emit(SOCKET_ENDPONTS.refuse_balloon, { refuser: params.user_id } as RejectBalloonRes);
      });
    }
  });

  socket.on(SOCKET_ENDPONTS.cancel_balloon, async (params: CancelBalloonParams) => {
    const otherBalloon = await cancelBalloon(params);
    if (!otherBalloon) return;

    await sendNotificationUser(otherBalloon.sender, balloonRejectNotification());
    if (userSocketMap[otherBalloon.sender]) {
      userSocketMap[otherBalloon.sender].forEach((associatedSocket) => {
        associatedSocket.emit(SOCKET_ENDPONTS.refuse_balloon, { refuser: params.user_id });
      });
    }
  });

  socket.on(SOCKET_ENDPONTS.v2_cancel_balloon, async (params: { balloon_id: string, user_id: string }) => {
    if (activeBalloonTimeouts.has(params.balloon_id)) {
      clearTimeout(activeBalloonTimeouts.get(params.balloon_id)!);
      activeBalloonTimeouts.delete(params.balloon_id);
    }

    const currentHolderId = activeBalloonHolders.get(params.balloon_id);
    if (currentHolderId && userSocketMap[currentHolderId]) {
      userSocketMap[currentHolderId].forEach((s: any) => {
        s.emit(SOCKET_ENDPONTS.balloon_expired, { balloonId: params.balloon_id });
      });

      activeBalloonHolders.delete(params.balloon_id);
      activeBalloonSkips.delete(params.balloon_id);
    }

    const balloonToDelete: Balloon | null = await balloon_model.findOne({ _id: params.balloon_id, sender: params.user_id });
    await Promise.all([
      user_model.updateOne(
        { _id: params.user_id },
        { $set: { 'balloon.sent': null } }
      ),
      ...(balloonToDelete
        ? [deleteBalloonS3(balloonToDelete), balloon_model.findByIdAndDelete(balloonToDelete._id)]
        : [])
    ]);

    trackEvent(params.user_id, mixpanelEvents.balloon_v2_cancel);

  });
}

