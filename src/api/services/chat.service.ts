import { Types } from 'mongoose';
import { message_model } from '../../models/message.model';
import { relationship_model } from '../../models/relationship.model';
import { conversation_model } from '../../models/conversation.model';
import { RelationshipDocument } from '../../types/mongoose.types';

export const saveMessageLogic = async (
  sender_id: string,
  receiver_id: string,
  content: string,
  rel: RelationshipDocument | null  // pass the full rel, not just the status string
) => {
  const sorted = [sender_id, receiver_id].sort();
  const sortedUsers = sorted;
  const senderOID = new Types.ObjectId(sender_id);

  const sortedParticipants = sorted.map(id => new Types.ObjectId(id));


  const conversation = await conversation_model.findOneAndUpdate(
    { participants: sortedParticipants },  // exact match on sorted array
    {
      $setOnInsert: {
        participants: sortedParticipants,
        unread_counts: new Map([[receiver_id, 0], [sender_id, 0]])
      }
    },
    { upsert: true, new: true }
  );

  // 2. Message + conversation meta update — run in parallel
  const [message] = await Promise.all([
    message_model.create({
      conversation_id: conversation._id,
      sender_id: senderOID,
      content
    }),
    conversation_model.updateOne(
      { _id: conversation._id },
      {
        $set: { last_message: conversation._id }, // will be overwritten below after create
        $inc: { [`unread_counts.${receiver_id}`]: 1 }
      }
    )
  ]);

  // 3. Now that we have the message _id, set last_message correctly
  await conversation_model.updateOne(
    { _id: conversation._id },
    { $set: { last_message: message._id } }
  );

  // 4. Social graph: only on first contact
  let updatedRel = rel;
  if (!rel || rel.chat_status === 'none') {
    updatedRel = await relationship_model.findOneAndUpdate(
      { users: sortedUsers },
      {
        $setOnInsert: { users: sortedUsers },
        $set: {
          chat_status: 'pending_invite',
          action_user_id: senderOID,
          conversation_id: conversation._id
        }
      },
      { upsert: true, new: true }
    ).lean();
  }

  // 5. Single hydrated fetch — populate here instead of two separate queries
  const finalConvo = await conversation_model
    .findById(conversation._id)
    .populate('participants', 'name img _id last_seen_version')
    .populate('last_message')
    .lean() as any;

  // 6. Merge rel data — no extra DB call, we already have it
  if (updatedRel) {
    finalConvo.status = updatedRel.chat_status;
    finalConvo.initiator_id = updatedRel.action_user_id?.toString();
    finalConvo.trial_expires_at = updatedRel.expires_at;
    finalConvo.cooldown_until = updatedRel.cooldown_until;
    finalConvo.relationship_id = updatedRel._id?.toString();

    console.log('sender:', sender_id)
    console.log('action_user_id from rel:', updatedRel.action_user_id?.toString())
    console.log('initiator_id on finalConvo:', finalConvo.initiator_id)
    console.log('participants order:', finalConvo.participants.map((p: any) => p._id.toString()))
  }

  return {
    message: { ...message.toObject(), isOptimistic: false },
    conversation: finalConvo
  };
};