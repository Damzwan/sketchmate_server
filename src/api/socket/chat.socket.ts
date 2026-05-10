import { Server, Socket } from 'socket.io';
import { saveMessageLogic } from '../services/chat.service';
import { user_model } from '../../models/user.model';

export function registerChatHandlers(io: Server, socket: Socket) {

  // --- SEND MESSAGE VIA SOCKET ---
  socket.on('chat:send_message', async (payload: { receiver_id: string, content: string }, callback) => {
    try {
      const sender_id = socket.data.user?._id?.toString();

      if (!sender_id) {
        return callback({ error: 'Not authenticated' });
      }

      // --- FIREWALL START ---
      // Check if the receiver has blocked the sender
      const receiver = await user_model.findById(payload.receiver_id).select('blocked_users').lean();

      const isBlocked = receiver?.blocked_users?.some(
        (id: any) => id.toString() === sender_id
      );

      if (isBlocked) {
        // SILENT DROP: We acknowledge success to the sender's UI
        // but we do NOT save to DB and do NOT emit to the receiver.
        return callback({
          success: true,
          // We return a mock message object so the sender's UI can "fake" the entry
          message: {
            sender_id,
            content: payload.content,
            createdAt: new Date().toISOString()
          }
        });
      }
      // --- FIREWALL END ---

      // 1. Run DB service logic (only reached if NOT blocked)
      const { message, conversation } = await saveMessageLogic(
        sender_id,
        payload.receiver_id,
        payload.content
      );

      if (!conversation) return;

      // 2. Emit to the receiver instantly
      io.to(payload.receiver_id).emit('chat:receive_message', {
        message,
        conversation,
        conversation_id: conversation._id
      });

      // 3. Acknowledge back to the sender
      callback({
        success: true,
        message,
        conversation
      });

    } catch (error: any) {
      console.error('Socket Chat Error:', error.message);
      callback({ error: error.message || 'Failed to send message' });
    }
  });

  // --- TYPING INDICATOR ---
  socket.on('chat:typing', (payload: { receiver_id: string, is_typing: boolean }) => {
    const sender_id = socket.data.user?._id?.toString();

    if (sender_id) {
      // Use socket.to() to send to everyone in the receiver's room except the sender
      io.to(payload.receiver_id).emit('chat:typing_status', {
        sender_id,
        is_typing: payload.is_typing
      });
    }
  });


  // --- DISCONNECT / LEAVE LOGIC (Optional) ---
  socket.on('disconnect', () => {
    // Logic for cleaning up if a user drops while typing
  });
}