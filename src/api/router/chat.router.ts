import { conversation_model } from '../../models/conversation.model';
import { requireAuth } from '../../middleware/auth';
import Router from 'koa-router';
import { message_model } from '../../models/message.model'; // Adjust path
import dayjs from 'dayjs';
import { user_model } from '../../models/user.model';
import { isUserOnline } from '../socket/socket';

export const chatRouter = new Router();

chatRouter.use(requireAuth);

chatRouter.get('/active', async (ctx) => {
  const user_id = ctx.state.user._id.toString();

  ctx.body = await conversation_model.find({
    participants: user_id,
    status: { $in: ['active', 'temporary', 'mate_pending', 'expired'] }
  })
    .populate('last_message')
    .populate('participants', 'name img _id')
    .sort({ updatedAt: -1 })
    .lean();
});

chatRouter.get('/requests', async (ctx) => {
  const user_id = ctx.state.user._id.toString();

  try {
    const requests = await conversation_model.find({
      participants: user_id,
      status: 'pending'
    })
      .populate('last_message')
      .populate('participants', 'name img _id')
      .sort({ updatedAt: -1 })
      .lean();

    ctx.body = requests;
  } catch (error) {
    console.error('Failed to fetch chat requests:', error);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error' };
  }
});

chatRouter.get('/:id/messages', async (ctx) => {
  const { id } = ctx.params;
  const { before } = ctx.query; // A timestamp to fetch messages older than this

  const query: any = { conversation_id: id };
  if (before) {
    query.createdAt = { $lt: new Date(before as string) };
  }

  const messages = await message_model
    .find(query)
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  ctx.body = messages.reverse();
});


// POST /chats/:id/read
chatRouter.post('/:id/read', async (ctx) => {
  const user_id = ctx.state.user._id.toString();
  const conversation_id = ctx.params.id;

  await conversation_model.updateOne(
    { _id: conversation_id },
    { $set: { [`unread_counts.${user_id}`]: 0 } }
  );

  ctx.status = 204;
});

chatRouter.post('/:id/respond', async (ctx) => {
  const { id } = ctx.params;
  const user_id = ctx.state.user._id.toString();
  const { action } = ctx.request.body as { action: 'accept' | 'decline' };

  // 1. Find and ensure the user is actually a participant
  const conversation = await conversation_model.findOne({
    _id: id,
    participants: user_id
  });

  if (!conversation) {
    ctx.status = 404;
    ctx.body = { error: 'Conversation not found or access denied' };
    return;
  }

  const initiatorId = conversation.initiator_id?.toString();
  const io = ctx.app.context.io;

  if (action === 'accept') {
    // 2. Prevent the initiator from accepting their own request
    if (initiatorId === user_id) {
      ctx.status = 400;
      ctx.body = { error: 'You cannot accept your own request' };
      return;
    }

    const expiresAt = dayjs().add(24, 'hours').toDate();

    // 3. Update the document status to temporary trial
    await conversation_model.updateOne(
      { _id: id },
      {
        $set: {
          status: 'temporary',
          trial_expires_at: expiresAt
        }
      }
    );

    // 4. Fetch fully populated version for UI and Sockets
    const populatedConvo = await conversation_model.findById(id)
      .populate('participants', 'name img _id')
      .populate('last_message')
      .lean();

    // --- 5. DYNAMIC WATCHER & ONLINE SYNC ---
    if (io && initiatorId) {
      const initiatorRoom = initiatorId;
      const acceptorRoom = user_id;

      // A. Dynamic Room Joining (Set up the "Watcher" state mid-session)
      // This ensures if one goes offline, the other gets the notification
      const initiatorSockets = io.sockets.adapter.rooms.get(initiatorRoom);
      const acceptorSockets = io.sockets.adapter.rooms.get(acceptorRoom);

      if (acceptorSockets) {
        acceptorSockets.forEach((socketId: any) => {
          const s = io.sockets.sockets.get(socketId);
          if (s) s.join(initiatorRoom); // Acceptor starts watching Initiator
        });
      }

      if (initiatorSockets) {
        initiatorSockets.forEach((socketId: any) => {
          const s = io.sockets.sockets.get(socketId);
          if (s) s.join(acceptorRoom); // Initiator starts watching Acceptor
        });
      }

      // B. Immediate Online Status Sync
      // Check current status and emit manually so green dots appear instantly
      const [isInitiatorOnline, isAcceptorOnline] = await Promise.all([
        isUserOnline(io, initiatorId),
        isUserOnline(io, user_id)
      ]);

      if (isInitiatorOnline) {
        io.to(acceptorRoom).emit('friend:online', { user_id: initiatorId });
      }
      if (isAcceptorOnline) {
        io.to(initiatorRoom).emit('friend:online', { user_id: user_id });
      }

      // C. Notify the initiator that the trial has officially started
      io.to(initiatorRoom).emit('chat:request_accepted', {
        conversation_id: id,
        conversation: populatedConvo
      });
    }

    ctx.body = {
      success: true,
      status: 'temporary',
      trial_expires_at: expiresAt,
      conversation: populatedConvo
    };

  } else if (action === 'decline') {
    // 6. Notify the initiator before deletion so they can clear the UI
    if (initiatorId && io) {
      io.to(initiatorId).emit('chat:request_declined', {
        conversation_id: id
      });
    }

    // 7. Cleanly remove the pending request and its messages
    await Promise.all([
      conversation_model.deleteOne({ _id: id }),
      message_model.deleteMany({ conversation_id: id })
    ]);

    ctx.body = { success: true, message: 'Conversation declined' };
  } else {
    ctx.status = 400;
    ctx.body = { error: 'Invalid action' };
  }
});

chatRouter.post('/:id/mate-request', async (ctx) => {
  const { id } = ctx.params;
  const user_id = ctx.state.user._id.toString();

  const conversation = await conversation_model.findOne({
    _id: id,
    participants: user_id
  });

  if (!conversation) {
    ctx.status = 404;
    ctx.body = { error: 'Conversation not found' };
    return;
  }

  // Check if we are in trial OR if we are expired but past the cooldown
  const isTrial = conversation.status === 'temporary';
  const isExpired = conversation.status === 'expired';
  const cooldownOver = !conversation.cooldown_until || dayjs().isAfter(dayjs(conversation.cooldown_until));

  if (!isTrial && !(isExpired && cooldownOver)) {
    ctx.status = 400;
    const errorMessage = (isExpired && !cooldownOver)
      ? 'Relationship is cooling down. Try again later!'
      : 'Must be in trial or post-cooldown to request Mates';

    ctx.body = { error: errorMessage };
    return;
  }

  // Update State
  const wasExpired = conversation.status === 'expired';
  conversation.status = 'mate_pending';
  conversation.initiator_id = user_id;
  conversation.set('cooldown_until', undefined); // Clear cooldown since they are trying again
  await conversation.save();

  // Fetch populated version for the socket
  const populated = await conversation_model.findById(id)
    .populate('participants', 'name img _id')
    .populate('last_message')
    .lean();

  const partnerId = conversation.participants.find(p => p.toString() !== user_id);

  if (ctx.app.context.io && partnerId) {
    ctx.app.context.io.to(partnerId.toString()).emit('chat:mate_requested', {
      conversation_id: id,
      conversation: populated,
      wasExpired: wasExpired
    });
  }

  // Return full status to frontend
  ctx.body = {
    success: true,
    status: 'mate_pending',
    conversation: populated
  };
});

/**
 * POST /chat/:id/mate-accept
 * Moves from 'mate_pending' to 'active' (Permanent)
 */
// chat.router.ts
// chat.router.ts

chatRouter.post('/:id/mate-accept', async (ctx) => {
  const { id } = ctx.params;
  const user_id = ctx.state.user._id.toString();

  const conversation = await conversation_model.findOne({ _id: id, participants: user_id });

  if (!conversation) {
    ctx.status = 404;
    ctx.body = { error: 'Conversation not found' };
    return;
  }

  // Safety: Only the person who DIDN'T initiate the request can accept it
  if (conversation.initiator_id?.toString() === user_id) {
    ctx.status = 400;
    ctx.body = { error: 'Waiting for your partner to accept.' };
    return;
  }

  const partnerId = conversation.participants.find(p => p.toString() !== user_id)?.toString();

  // 1. Update Conversation Status
  conversation.status = 'active';
  conversation.set('trial_expires_at', undefined);
  conversation.set('deleted_at', undefined); // CRITICAL: Stop the auto-delete timer!
  conversation.set('cooldown_until', undefined); // Clear any lingering cooldown
  await conversation.save();

  if (partnerId) {
    await Promise.all([
      user_model.updateOne({ _id: user_id }, { $addToSet: { friends: partnerId } }),
      user_model.updateOne({ _id: partnerId }, { $addToSet: { friends: user_id } })
    ]);
  }

  const populated = await conversation_model.findById(id)
    .populate('participants', 'name img _id')
    .lean();

  // 3. Socket notification for the partner
  if (ctx.app.context.io && partnerId) {
    ctx.app.context.io.to(partnerId).emit('chat:mate_matched', {
      conversation_id: id,
      conversation: populated
    });
  }

  ctx.body = { success: true, conversation: populated };
});

chatRouter.post('/:id/mate-decline', async (ctx) => {
  const { id } = ctx.params;
  const user_id = ctx.state.user._id.toString();

  const conversation = await conversation_model.findOne({
    _id: id,
    participants: user_id
  });

  if (!conversation || conversation.status !== 'mate_pending') {
    ctx.status = 400;
    ctx.body = { error: 'No pending mate request found' };
    return;
  }

  // 1. Determine fallback status
  const isTrialValid = conversation.trial_expires_at && dayjs().isBefore(dayjs(conversation.trial_expires_at));
  const fallbackStatus = isTrialValid ? 'temporary' : 'expired';

  // 2. Update State
  conversation.status = fallbackStatus;
  conversation.initiator_id = undefined; // Reset proposal state

  if (fallbackStatus === 'expired') {
    // Start the 30-day countdown for the TTL index to delete the document
    conversation.set('deleted_at', dayjs().add(30, 'days').toDate());
  } else {
    // If we are back in a valid trial, ensure the delete timer is cleared
    conversation.set('deleted_at', undefined);
  }

  await conversation.save();

  // 3. Fetch populated version for the socket and response
  const populated = await conversation_model.findById(id)
    .populate('participants', 'name img _id')
    .populate('last_message')
    .lean();

  const partnerId = conversation.participants.find(p => p.toString() !== user_id);
  const io = ctx.app.context.io;

  // 4. SOCKET EMISSION: Notify the partner
  if (partnerId && io) {
    io.to(partnerId.toString()).emit('chat:mate_declined', {
      conversation_id: id,
      conversation: populated,
      status: fallbackStatus
    });
  }

  ctx.body = {
    success: true,
    status: fallbackStatus,
    conversation: populated
  };
});