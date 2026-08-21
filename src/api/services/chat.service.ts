import { Types } from 'mongoose';
import { message_model } from '../../models/message.model';
import { relationship_model } from '../../models/relationship.model';
import { conversation_model } from '../../models/conversation.model';
import { RelationshipDocument } from '../../types/mongoose.types';
import { PUBLIC_USER_FIELDS } from '../../types/projections';
import { censorText } from './profanity.service';

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

/**
 * The pair's conversation, created on their first message.
 *
 * Matched with `$all` + `$size` and not with an exact array equality, because
 * equality on an array is ORDER SENSITIVE. `participants` has only been written
 * sorted since the relationship rework, so any older document holding the pair
 * the other way round was invisible to the equality form and this upsert
 * inserted a SECOND conversation for the same two people. The unique index on
 * (participants.0, participants.1) does not catch it either — reversed order is
 * a different key. What the user sees is a split thread: the history before the
 * duplicate under one id, everything after it under another.
 *
 * `deleted_at` is cleared on every send. It sits on a TTL index, so it is a
 * scheduled deletion rather than a flag, and a message is proof the thread is
 * live — see reviveConversation in api/router/relationship.router.ts for the
 * fallout when a tombstone outlives the fallout it was set for.
 */
async function findOrCreateConversation(
  sortedParticipants: Types.ObjectId[],
  sender_id: string,
  receiver_id: string
) {
  const pairFilter = { participants: { $all: sortedParticipants, $size: 2 } };

  // Find-then-create, NOT an upsert.
  //
  // The upsert this replaces could never insert. Mongo builds an upserted
  // document from the equality fields of the query, and `$all`/`$size` are not
  // equality constraints; combined with a `$setOnInsert` that also writes
  // `participants`, the server rejects the whole operation with "cannot infer
  // query fields to set, path 'participants' is matched twice". It threw on
  // exactly one case — the one where no conversation existed yet — so every
  // FIRST message between two people failed while every subsequent one worked.
  // The 11000 guard below did not catch it either: a plan-executor error is not
  // a duplicate-key error, so it propagated out of the send.
  //
  // Splitting the two halves keeps what the order-insensitive lookup was for
  // (an exact array match on `participants` is order sensitive, and the unique
  // index on participants.0/participants.1 does not save you, because reversed
  // order is a different key) without asking Mongo to infer anything.
  const existing = await conversation_model.findOneAndUpdate(
    pairFilter,
    // A message is proof the thread is live, so any scheduled deletion is
    // cancelled on the way through.
    { $unset: { deleted_at: '' } },
    { new: true }
  );
  if (existing) return existing;

  try {
    return await conversation_model.create({
      participants: sortedParticipants,
      unread_counts: new Map([
        [receiver_id, 0],
        [sender_id, 0]
      ])
    });
  } catch (err: any) {
    // Two first messages racing: both miss the read, both insert, and the
    // unique index rejects the loser. The winner's document is the one both
    // sides should be writing into, so read it back instead of failing a send.
    if (err?.code !== 11000) throw err;
    const winner = await conversation_model.findOne(pairFilter);
    if (!winner) throw new Error('Could not resolve a conversation for these participants');
    return winner;
  }
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

  const conversation = await findOrCreateConversation(sortedParticipants, sender_id, receiver_id);

  // Scanned once, here, and only when there is text to scan. Clean messages
  // store nothing extra; see services/profanity.service for why the filter is a
  // write-time job rather than a read-time one.
  const content_filtered = content ? censorText(content) : null;

  // Create first so the conversation can point at the real message in the same
  // write that increments unread state. The old placeholder briefly stored the
  // conversation id in `last_message`, then needed a second metadata write.
  const message = await message_model.create({
    conversation_id: conversation._id,
    sender_id,
    content,
    ...(content_filtered && { content_filtered }),
    ...(shared_post_id && { shared_post_id: new Types.ObjectId(shared_post_id) }),
    ...(options.shared_inbox_item_id && { shared_inbox_item_id: new Types.ObjectId(options.shared_inbox_item_id) }),
    ...(options.messageMeta && {
      type: options.messageMeta.type,
      system_kind: options.messageMeta.system_kind,
      system_payload: options.messageMeta.system_payload
    })
  });
  await conversation_model.updateOne(
    { _id: conversation._id },
    {
      $set: { last_message: message._id },
      $inc: { [`unread_counts.${receiver_id}`]: 1 }
    }
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

    // Target the relationship we already resolved by _id. The caller finds it
    // with an order-insensitive `users: { $all: [...] }` query, but this write
    // used to upsert on `{ users: sortedUsers }` — an EXACT, order-sensitive
    // array match. Any pair document whose `users` array isn't in sorted order
    // was therefore found by the read and missed by the write, so the upsert
    // inserted a SECOND relationship for the same two people. Two relationships
    // for one pair means two 'pending_invite' rows, i.e. duplicate invitations.
    updatedRel = rel?._id
      ? await relationship_model.findByIdAndUpdate(
        rel._id,
        { $set: setBlock, $unset: { deleted_at: '' } },
        { new: true }
      ).lean()
      : await relationship_model.findOneAndUpdate(
        { users: sortedUsers },
        {
          $setOnInsert: { users: sortedUsers },
          $set: setBlock,
          // Same reason the conversation's tombstone is cleared above: a new
          // message restarts the thread, and `deleted_at` is a TTL deletion.
          $unset: { deleted_at: '' }
        },
        { upsert: true, new: true }
      ).lean();
  }

  // The relationship's `conversation_id` is the ONLY route /chats/shell has from
  // a person to their thread, and the block above only runs when the status
  // itself changes. An established relationship — a `mate` in particular — could
  // therefore message forever without that link ever being written, and its chat
  // stayed missing from the overview on every startup while working perfectly
  // inside the session that sent the message. Repair it on every send: it is one
  // guarded write, and it is what makes the thread findable again tomorrow.
  if (
    updatedRel &&
    updatedRel.conversation_id?.toString() !== conversation._id.toString()
  ) {
    await relationship_model.updateOne(
      { _id: updatedRel._id },
      { $set: { conversation_id: conversation._id } }
    );
    updatedRel.conversation_id = conversation._id;
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
