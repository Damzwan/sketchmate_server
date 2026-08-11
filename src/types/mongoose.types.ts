import { Types } from 'mongoose';
import {
  Balloon,
  BaseConversation,
  BaseMessage,
  BasePost,
  BasePostComment,
  BasePostReaction,
  BaseRelationship, BaseSavedDrawing, Comment, InboxComment, InboxItem,
  User
} from './types';
import { Document } from 'mongodb';

export interface PostDocument extends Document, Omit<BasePost, '_id' | 'author_id' | 'reaction_counts' | 'createdAt' | 'updatedAt'> {
  _id: Types.ObjectId;
  author_id: Types.ObjectId;
  reaction_counts: Map<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeanPost extends Omit<PostDocument, 'reaction_counts'> {
  reaction_counts: Record<string, number>;
}

export interface PostCommentDocument extends Document, Omit<BasePostComment, '_id' | 'post_id' | 'author_id' | 'createdAt' | 'updatedAt'> {
  _id: Types.ObjectId;
  post_id: Types.ObjectId;
  author_id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface PostReactionDocument extends Document, Omit<BasePostReaction, '_id' | 'post_id' | 'user_id'> {
  _id: Types.ObjectId;
  post_id: Types.ObjectId;
  user_id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface PostViewDocument extends Document {
  _id: Types.ObjectId;
  post_id: Types.ObjectId;
  user_id: Types.ObjectId;
  seen_count: number;
  last_seen_at: Date;
}

export interface UserDocument extends Omit<User, '_id' | 'date_of_birth' | 'last_name_change' | 'balloon'> {
  _id: Types.ObjectId;
  date_of_birth?: Date;
  last_name_change?: Date;
  balloon?: {
    sent?: Types.ObjectId;
    received?: Types.ObjectId;
    last_received_at?: Date;
    disabled?: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationDocument extends Document, Omit<BaseConversation,
  | '_id'
  | 'participants'
  | 'last_message'
  | 'unread_counts'
  | 'createdAt'
  | 'updatedAt'
> {
  _id: Types.ObjectId;
  participants: Types.ObjectId[];
  last_message?: Types.ObjectId;
  unread_counts: Map<string, number>; // Live Mongoose Map
  createdAt: Date;
  updatedAt: Date;
}

export interface LeanConversation extends Omit<ConversationDocument,
  | 'unread_counts'
  | 'last_message'
  | 'participants'
> {
  unread_counts: Record<string, number>;
  participants: Types.ObjectId[];
  last_message?: Types.ObjectId;
}

export interface PopulatedConversation extends Omit<LeanConversation,
  | 'participants'
  | 'last_message'
> {
  participants: {
    _id: string;
    name: string;
    img: string;
  }[];
  last_message?: {
    _id: string;
    sender_id: string;
    content: string;
    createdAt: string;
  };
}

export interface RelationshipDocument extends Omit<BaseRelationship, '_id' | 'users' | 'conversation_id' | 'action_user_id' | 'expires_at' | 'cooldown_until' | 'follows' | 'deleted_at' | 'createdAt' | 'updatedAt' | 'blocked_by'> {
  _id: Types.ObjectId;
  users: [Types.ObjectId, Types.ObjectId];
  conversation_id?: Types.ObjectId;
  action_user_id?: Types.ObjectId;
  expires_at?: Date;
  cooldown_until?: Date;
  follows: {
    follower: Types.ObjectId;
    followed: Types.ObjectId;
  }[];
  deleted_at?: Date;
  createdAt: Date;
  updatedAt: Date;
  blocked_by?: Types.ObjectId;
  mate_requests?: {
    requester: Types.ObjectId;
    declines: number;
    attempts: number;
    last_requested_at?: Date;
    cooldown_until?: Date;
  }[];
}

export interface MessageDocument extends Document, Omit<BaseMessage, '_id' | 'sender_id' | 'conversation_id' | 'createdAt' | 'updatedAt' | 'shared_post_id'> {
  _id: Types.ObjectId;
  sender_id: Types.ObjectId;
  conversation_id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  shared_post_id?: Types.ObjectId | null;
}

export interface InboxCommentDocument extends Omit<Comment, '_id' | 'date'> {
  date: Date;
}

export interface InboxDocument extends Omit<InboxItem, '_id' | 'sender' | 'reply' | 'comments' | 'date' | 'seen_by' | 'comments_seen_by'> {
  _id: Types.ObjectId;
  sender: Types.ObjectId;
  reply?: Types.ObjectId;
  comments: InboxCommentDocument[];
  seen_by: Types.ObjectId[];
  comments_seen_by: Types.ObjectId[];
  date: Date;
  comments_migrated?: boolean;
}

export interface BalloonDocument extends Omit<Balloon, '_id' | 'sender' | 'pairedUser' | 'pairedBalloon' | 'cancelledBalloons' | 'rejected_by' | 'createdAt' | 'matchedAt' | 'lastActivityAt'> {
  _id: Types.ObjectId;
  sender: Types.ObjectId;

  // Timestamps
  createdAt: Date;
  matchedAt?: Date; // @deprecated
  lastActivityAt: Date;

  // Matching / Legacy
  pairedUser?: Types.ObjectId; // @deprecated
  pairedBalloon?: Types.ObjectId; // @deprecated
  cancelledBalloons: Types.ObjectId[];
  rejected_by: Types.ObjectId[];
}

import { Notification, NotificationActor } from './types';

export interface NotificationDocument
  extends Omit<Notification, '_id' | 'recipient_id' | 'target_id' | 'actors' | 'createdAt' | 'updatedAt'> {
  _id: Types.ObjectId;
  recipient_id: Types.ObjectId;
  target_id?: Types.ObjectId;
  actors: Array<Omit<NotificationActor, '_id'> & { _id: Types.ObjectId }>;
  createdAt: Date;
  updatedAt: Date;
}

export interface InboxCommentDocumentV2 extends Omit<InboxComment, '_id' | 'sender' | 'inbox_id' | 'date'> {
  _id: Types.ObjectId;
  inbox_id: Types.ObjectId;
  sender: Types.ObjectId;
  date: Date;
}

export interface SavedDrawingDocument extends Document, Omit<BaseSavedDrawing, 'user_id'> {
  _id: Types.ObjectId;
  user_id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface CloudDraftDocument extends Document {
  _id: Types.ObjectId;
  user_id: Types.ObjectId;
  draft_id: string;
  /** Client clock, milliseconds. The value devices compare to resolve conflicts. */
  updated_at: number;
  drawing_key: string;
  thumbnail_key: string;
  bytes: number;
  deleted_at: number | null;
  createdAt: Date;
  updatedAt: Date;
}