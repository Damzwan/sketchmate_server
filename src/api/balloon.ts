// The life-support monitor for active balloons
import { user_model } from '../models/user.model';
import mongoose from 'mongoose';
import { SOCKET_ENDPONTS } from '../types/types';
import { balloon_model } from '../models/balloon.model';


export const activeBalloonTimeouts = new Map<string, any>();

export async function routeBalloonToOnlineUser(
  senderId: string,
  balloonId: string,
  userSocketMap: any,
  attempts = 0
) {
  const MAX_ATTEMPTS = 5;

  if (attempts >= MAX_ATTEMPTS) {
    console.log(`Balloon ${balloonId} exhausted live attempts. Moving to Waiting Room.`);
    return false; // Status remains 'pending' in DB
  }

  const onlineUserIds = Object.keys(userSocketMap);
  const potentialCandidates = onlineUserIds.filter(id => id !== senderId.toString());

  if (potentialCandidates.length === 0) {
    console.log('No candidates online. Moving to Waiting Room.');
    return false;
  }

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Query for a healthy candidate
  const eligibleUser = await user_model.aggregate([
    {
      $match: {
        _id: { $in: potentialCandidates.map(id => new mongoose.Types.ObjectId(id)) },
        balloon_opt_in: true,
        $or: [
          { 'balloon.last_received_at': { $lte: oneDayAgo } },
          { 'balloon.last_received_at': null },
          { 'balloon.last_received_at': { $exists: false } }
        ]
      }
    },
    { $sample: { size: 1 } }
  ]);

  if (!eligibleUser || eligibleUser.length === 0) {
    return false;
  }

  const matchedUserId = eligibleUser[0]._id.toString();

  // Administer the balloon
  if (userSocketMap[matchedUserId]) {
    userSocketMap[matchedUserId].forEach((socket: any) => {
      socket.emit(SOCKET_ENDPONTS.receive_new_balloon, { balloonId });
    });
  }

  // Start the Hot Potato Timer
  const timeout = setTimeout(async () => {
    console.log(`User ${matchedUserId} timed out. Rerouting balloon ${balloonId}...`);
    activeBalloonTimeouts.delete(balloonId);

    const currentBalloon = await balloon_model.findById(balloonId);
    if (currentBalloon && currentBalloon.status === 'pending') {
      if (userSocketMap[matchedUserId]) {
        userSocketMap[matchedUserId].forEach((socket: any) => {
          socket.emit(SOCKET_ENDPONTS.balloon_missed, { balloonId });
        });
      }
      // Recursion: Try the next person
      routeBalloonToOnlineUser(senderId, balloonId, userSocketMap, attempts + 1);
    }
  }, 30000); // 30s timeout

  activeBalloonTimeouts.set(balloonId, timeout);
  return true;
}

