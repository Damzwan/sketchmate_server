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

      const isBlocked = rel && rel.chat_status === 'blocked';
      const isExpired = rel && rel.chat_status === 'expired';

      if (isBlocked) {
        return callback({ error: 'You cannot message this artist.' });
      }

      if (isExpired) {
        return callback({ error: 'Trial expired. Send a Mate request to continue sketching.' });
      }

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