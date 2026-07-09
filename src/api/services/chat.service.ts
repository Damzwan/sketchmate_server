import { Types } from 'mongoose';
import { message_model } from '../../models/message.model';
import { relationship_model } from '../../models/relationship.model';
import { conversation_model } from '../../models/conversation.model';
import { RelationshipDocument } from '../../types/mongoose.types';
import { PUBLIC_USER_FIELDS } from '../../types/projections';

export interface SaveMessageOptions {
  /**
   * Override the default 'pending_invite' chat_status set on first contact.
   * Used by the balloon flow which goes straight to 'temporary'.
   */
  relationshipOverride?: {
    chat_status: string;
    expires_at?: Date;
    action_user_id?: Types.ObjectId;
  };

  /**
   * Tag the message as a system message. The frontend renders these
   * differently (centered row, no avatar bubble) based on system_kind.
   */
  messageMeta?: {
    type: 'user' | 'system';
    system_kind?: string;
    system_payload?: any;
  };

  /**
   * Include an inbox item (gallery drawing) shared directly in the chat.
   */
  shared_inbox_item_id?: string;
}

export const saveMessageLogic = async (
  sender_id: string,
  receiver_id: string,
  content: string,
  rel: RelationshipDocument | null,
  shared_post_id?: string,
  options: SaveMessageOptions = {}
) => {
  const sorted = [sender_id, receiver_id].sort();
  const sortedUsers = sorted;
  const senderOID = new Types.ObjectId(sender_id);
  const sortedParticipants = sorted.map((id) => new Types.ObjectId(id));

  const conversation = await conversation_model.findOneAndUpdate(
    { participants: sortedParticipants },
    {
      $setOnInsert: {
        participants: sortedParticipants,
        unread_counts: new Map([
          [receiver_id, 0],
          [sender_id, 0]
        ])
      }
    },
    { upsert: true, new: true }
  );

  // 2. Message + conversation meta update — run in parallel
  const [message] = await Promise.all([
    message_model.create({
      conversation_id: conversation._id,
      sender_id,
      content,
      ...(shared_post_id && { shared_post_id: new Types.ObjectId(shared_post_id) }),
      ...(options.shared_inbox_item_id && { shared_inbox_item_id: new Types.ObjectId(options.shared_inbox_item_id) }),
      ...(options.messageMeta && {
        type: options.messageMeta.type,
        system_kind: options.messageMeta.system_kind,
        system_payload: options.messageMeta.system_payload
      })
    }),
    conversation_model.updateOne(
      { _id: conversation._id },
      {
        $set: { last_message: conversation._id },
        $inc: { [`unread_counts.${receiver_id}`]: 1 }
      }
    )
  ]);

  await conversation_model.updateOne(
    { _id: conversation._id },
    { $set: { last_message: message._id } }
  );

  // 4. Social graph — caller can override the default 'pending_invite' default
  let updatedRel = rel;
  const needsRelationshipWrite =
    !rel ||
    rel.chat_status === 'none' ||
    !!options.relationshipOverride;

  if (needsRelationshipWrite) {
    const override = options.relationshipOverride;
    const setBlock: any = override
      ? {
        chat_status: override.chat_status,
        action_user_id: override.action_user_id ?? senderOID,
        conversation_id: conversation._id,
        ...(override.expires_at && { expires_at: override.expires_at })
      }
      : {
        chat_status: 'pending_invite',
        action_user_id: senderOID,
        conversation_id: conversation._id
      };

    updatedRel = await relationship_model.findOneAndUpdate(
      { users: sortedUsers },
      {
        $setOnInsert: { users: sortedUsers },
        $set: setBlock
      },
      { upsert: true, new: true }
    ).lean();
  }

  const finalConvo = await conversation_model
    .findById(conversation._id)
    .populate('participants', PUBLIC_USER_FIELDS + ' last_seen_version')
    .populate('last_message')
    .lean() as any;

  if (updatedRel) {
    finalConvo.status = updatedRel.chat_status;
    finalConvo.initiator_id = updatedRel.action_user_id?.toString();
    finalConvo.trial_expires_at = updatedRel.expires_at;
    finalConvo.cooldown_until = updatedRel.cooldown_until;
    finalConvo.relationship_id = updatedRel._id?.toString();
  }

  return {
    message: { ...message.toObject(), isOptimistic: false },
    conversation: finalConvo
  };
};