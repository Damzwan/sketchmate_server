import { user_model } from '../../models/user.model';
import { conversation_model } from '../../models/conversation.model';
import { message_model } from '../../models/message.model';

export const saveMessageLogic = async (sender_id: string, receiver_id: string, content: string) => {
  // 1. Fetch both users in a single round-trip to the DB
  const [sender, receiver] = await Promise.all([
    user_model.findById(sender_id),
    user_model.findById(receiver_id)
  ]);

  if (!receiver) throw new Error('User not found');
  if (receiver.blocked_users.includes(sender_id as any)) {
    throw new Error('Cannot send message to this user');
  }

  let conversation = await conversation_model.findOne({
    participants: { $all: [sender_id, receiver_id], $size: 2 }
  });

  // Backward compatible friend check
  const isFriend = sender?.friends.some(id => id.toString() === receiver_id) ||
    sender?.mates.some(m => (typeof m === 'string' ? m === receiver_id : (m as any)._id.toString() === receiver_id));

  if (conversation) {
    // Lock logic for pending requests
    if (conversation.status === 'pending' && conversation.initiator_id?.toString() === sender_id) {
      throw new Error('You can only send one message until they accept your invite.');
    }
    // If they were pending and you reply, they become "active" (or "temporary" based on your preference)
    if (conversation.status === 'pending' && conversation.initiator_id?.toString() !== sender_id) {
      conversation.status = 'active';
    }
  } else {
    // NEW CONVERSATION
    conversation = new conversation_model({
      participants: [sender_id, receiver_id],
      status: isFriend ? 'active' : 'pending',
      initiator_id: sender_id,
      unread_counts: { [receiver_id]: 1 }
    });
  }

  const message = new message_model({
    conversation_id: conversation._id,
    sender_id,
    content,
    is_invite: !isFriend && conversation.status === 'pending'
  });

  await message.save();
  conversation.last_message = message._id as any;

  // Handle Unreads
  const unreadMap = conversation.unread_counts as any;
  const currentUnread = (unreadMap.get ? unreadMap.get(receiver_id) : unreadMap[receiver_id]) || 0;
  if (unreadMap.set) unreadMap.set(receiver_id, currentUnread + 1);
  else {
    unreadMap[receiver_id] = currentUnread + 1;
    conversation.markModified('unread_counts');
  }

  await conversation.save();

  // 5. THE CRITICAL PART: Return a populated object for the Frontend
  // This ensures resolvePartnerInfo(convoId) works instantly without a refresh.
  const finalConvo = await conversation_model.findById(conversation._id)
    .populate('participants', 'name img _id')
    .populate('last_message')
    .lean();

  return { message, conversation: finalConvo };
};