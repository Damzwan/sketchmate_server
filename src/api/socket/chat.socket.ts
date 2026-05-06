import { Server, Socket } from 'socket.io';
import { saveMessageLogic } from '../services/chat.service';

export function registerChatHandlers(io: Server, socket: Socket) {

  // --- SEND MESSAGE VIA SOCKET ---
  socket.on('chat:send_message', async (payload: { receiver_id: string, content: string }, callback) => {
    try {
      // Assuming socket.data.user is populated via your auth middleware
      const sender_id = socket.data.user?._id?.toString();

      if (!sender_id) {
        return callback({ error: 'Not authenticated' });
      }

      // 1. Run DB service logic to save the message and update conversation
      const { message, conversation } = await saveMessageLogic(
        sender_id,
        payload.receiver_id,
        payload.content
      );

      // 2. Emit to the receiver's private room instantly
      // Note: Make sure users join a room named after their _id on connection
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