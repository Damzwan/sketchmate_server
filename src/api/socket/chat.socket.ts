import { Server, Socket } from 'socket.io';
import { saveMessageLogic } from '../services/chat.service';
import { relationship_model } from '../../models/relationship.model';
import { Types } from 'mongoose';
import { RelationshipDocument } from '../../types/mongoose.types';
import { checkSocketCapability } from '../../middleware/moderation.middleware';
import { Capability } from '../../types/moderation.policy';
import { dispatchNotification } from '../services/notification.service';
import { dmPushNotification } from '../../config/notification.config';


export function registerChatHandlers(io: Server, socket: Socket) {

  socket.on('chat:send_message', async (
    payload: { receiver_id: string, content: string, shared_post_id?: string, shared_inbox_item_id?: string },
    callback
  ) => {
    try {
      const sender_id = socket.data.user?._id?.toString();
      if (!sender_id) return callback({ error: 'Not authenticated' });

      const { receiver_id, content, shared_post_id, shared_inbox_item_id} = payload;

      // 1. Basic Validations
      if (sender_id === receiver_id) {
        return callback({ error: 'Cannot send a message to yourself.' });
      }

      if (!content?.trim() && !shared_post_id && !shared_inbox_item_id) {
        return callback({ error: 'Message cannot be empty.' });
      }

      // 2. Moderation Check
      const check = await checkSocketCapability(sender_id, Capability.SEND_DM);
      if (check.blocked) {
        return callback({ error: 'capability_blocked', restriction: check.restriction });
      }

      // 3. Relationship Logic
      const rel = await relationship_model.findOne({
        users: { $all: [new Types.ObjectId(sender_id), new Types.ObjectId(receiver_id)] }
      }).lean() as RelationshipDocument | null;

      // Shadowban handling: Fake success, avoid notification dispatch
      if (rel && rel.chat_status === 'blocked') {
        return callback({
          success: true,
          message: {
            _id: new Types.ObjectId().toString(),
            content: content || '',
            shared_post_id: shared_post_id || null,
            shared_inbox_item_id: shared_inbox_item_id || null,
            sender_id,
            createdAt: new Date().toISOString(),
            status: 'sent'
          },
          conversation: { _id: rel.conversation_id?.toString() || new Types.ObjectId().toString() }
        });
      }

      // State restrictions
      if (rel && rel.chat_status === 'pending_invite') {
        return callback({ error: 'You must wait for the artist to accept your request before sending more messages.' });
      }

      if (rel && rel.chat_status === 'expired') {
        return callback({ error: 'Trial expired. Send a Mate request to continue sketching.' });
      }

      // 4. Persistence
      const { message, conversation } = await saveMessageLogic(
        sender_id,
        receiver_id,
        content || '',
        rel,
        shared_post_id,
        {shared_inbox_item_id}
      );

      // 5. Dispatch Notification via new Architecture
      // We wrap this in a fire-and-forget call (handled by the catch block below)
      dispatchNotification({
        recipient_id: receiver_id,
        type: 'dm_message',
        actor: {
          _id: sender_id,
          name: socket.data.user.name,
          img: socket.data.user.img
        },
        channels: {
          in_app: false,
          socket: {
            event: 'chat:receive_message',
            data: { message, conversation, conversation_id: conversation._id }
          },
          push: dmPushNotification(
            sender_id.toString(),
            socket.data.user.name,
            content || '[Shared a drawing]',
            socket.data.user.img,
            conversation._id.toString(),
          )
        }
      }).catch(err => console.error('DM dispatch failed:', err));

      callback({ success: true, message, conversation });

    } catch (error: any) {
      console.error('Socket Chat Error:', error.message);
      callback({ error: error.message || 'Failed to send message' });
    }
  });

  socket.on('chat:typing', (payload: { receiver_id: string, is_typing: boolean }) => {
    const sender_id = socket.data.user?._id?.toString();
    if (sender_id) {
      // Typing status is ephemeral and doesn't require push notifications
      io.to(payload.receiver_id).emit('chat:typing_status', {
        sender_id,
        is_typing: payload.is_typing
      });
    }
  });
}