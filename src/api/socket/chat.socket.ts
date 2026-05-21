import { Server, Socket } from 'socket.io';
import { saveMessageLogic } from '../services/chat.service';
import { relationship_model } from '../../models/relationship.model';
import { Types } from 'mongoose';
import { RelationshipDocument } from '../../types/mongoose.types';

export function registerChatHandlers(io: Server, socket: Socket) {

  socket.on('chat:send_message', async (payload: { receiver_id: string, content: string }, callback) => {
    try {
      const sender_id = socket.data.user?._id?.toString();
      if (!sender_id) return callback({ error: 'Not authenticated' });

      const { receiver_id, content } = payload;

      if (sender_id === receiver_id) {
        return callback({ error: 'Cannot send a message to yourself.' });
      }

      const rel = await relationship_model.findOne({
        users: {
          $all: [new Types.ObjectId(sender_id), new Types.ObjectId(receiver_id)]
        }
      }).lean() as RelationshipDocument | null;

      if (rel && rel.chat_status === 'blocked') {
        return callback({
          success: true,
          message: {
            _id: new Types.ObjectId().toString(),
            content,
            sender_id,
            createdAt: new Date().toISOString(),
            status: 'sent'
          },
          conversation: {
            _id: rel.conversation_id?.toString() || new Types.ObjectId().toString()
          }
        });
      }

      // --- 2. ENFORCE PENDING INVITE LIMIT ---
      if (rel && rel.chat_status === 'pending_invite') {
        return callback({
          error: 'You must wait for the artist to accept your request before sending more messages.'
        });
      }

      // --- 3. STANDARD CHECKS ---
      if (rel && rel.chat_status === 'expired') {
        return callback({
          error: 'Trial expired. Send a Mate request to continue sketching.'
        });
      }

      // --- 4. EXECUTE NORMAL LOGIC ---
      const { message, conversation } = await saveMessageLogic(
        sender_id,
        receiver_id,
        content,
        rel
      );

      io.to(receiver_id).emit('chat:receive_message', {
        message,
        conversation,
        conversation_id: conversation._id
      });

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

  socket.on('chat:typing', (payload: { receiver_id: string, is_typing: boolean }) => {
    const sender_id = socket.data.user?._id?.toString();
    if (sender_id) {
      io.to(payload.receiver_id).emit('chat:typing_status', {
        sender_id,
        is_typing: payload.is_typing
      });
    }
  });
}