import {
  Balloon,
  ChangeUserNameParams,
  Comment,
  CommentParams,
  CreateBalloonPostParams,
  CreateSavedParams,
  CreateStickerParams,
  DeleteEmblemParams,
  DeleteSavedParams,
  DeleteStickerParams, GetInboxCommentsRes,
  GetInboxItemsParams,
  GetInboxRes,
  GetUserParams,
  GetUserRes, InboxComment,
  InboxItem,
  MatchParams,
  Mate,
  OnLoginEventParams,
  RegisterNotificationParams,
  RemoveFromInboxParams,
  Res,
  Saved,
  SeeInboxParams,
  SendMateRequestParams,
  SendParams,
  UnMatchParams,
  UnRegisterNotificationParams,
  UpdateUserParams,
  UploadProfileImgParams,
  User
} from './types/types';
import {
  UserDocument,
  InboxDocument,
  BalloonDocument,
  InboxCommentDocument
} from './types/mongoose.types';
import { CONTAINER, S3Creator } from './s3';
import mongoose, { Types } from 'mongoose';
import { user_model } from './models/user.model';
import { createThumbnail, escapeRegExp, imgToEmblem, removeBackground } from './helper';
import { inbox_model } from './models/inbox.model';
import * as fs from 'fs';
import { minimum_online_version, minimum_supported_version } from './main';
import { balloon_model } from './models/balloon.model';
import { mixpanelEvents, trackEvent } from './mixpanel';
import { PUBLIC_USER_FIELDS } from './types/projections';
import { inbox_comment_model } from './models/inbox-comment.model';
import { serializeInboxComment } from './api/services/inbox.service';
import { invalidateParentalCache, sanitizeParental } from './api/services/parental.service';

export let s3Creator: S3Creator;

export async function connectDb(): Promise<void> {
  try {
    const url = process.env.mongo;
    if (!url) throw Error('No url available');
    await mongoose.connect(url, { dbName: 'prod' });
    console.log('Connected to database 👻');
    s3Creator = new S3Creator();
  } catch (e) {
    console.log(e);
  }
}

export async function createUser(auth_id: string): Promise<Res<User>> {
  try {
    const user = await user_model.create({
      auth_id,
      stickers: [],
      emblems: [],
      saved: [],
      name: 'Anonymous',
      img: s3Creator.getRandomStockProfileImg(),
      migration_version: 1,
      subscriptions: [],
      mates: [], // @deprecated
      inbox: [], // @deprecated
      mate_requests_sent: [], // @deprecated
      mate_requests_received: [] // @deprecated
    });

    if (user._id) trackEvent(user._id.toString(), mixpanelEvents.create_account);

    return {
      ...user.toObject(),
      _id: user._id.toString()
    } as unknown as User;
  } catch (e) {
    console.log(e);
  }
}

export async function getUser(params: GetUserParams): Promise<Res<GetUserRes>> {
  try {
    if (!params.auth_id) return undefined;
    let user: UserDocument | null = null;

    user = await user_model.findOne({ auth_id: params.auth_id }).lean() as UserDocument | null;

    if (user) {
      return {
        user: { ...user, _id: user._id.toString() } as unknown as User,
        new_account: false,
        minimum_supported_version,
        minimum_online_version

      };
    }


    // NO _id FALLBACK. This used to look the account up by a caller-supplied
    // _id and rebind its auth_id to whoever was asking — an unauthenticated
    // account takeover, since _id is public (it comes back from /partial_users,
    // posts and mates). Recovering a guest account onto a new Firebase uid is
    // guest-recovery.router's job, and it does it by minting a custom token for
    // the ORIGINAL uid, so the auth_id lookup above already succeeds. Nothing
    // legitimate needs to rewrite auth_id here.

    const newUser = await createUser(params.auth_id);
    return { user: newUser!, new_account: true, minimum_supported_version, minimum_online_version };

  } catch (e) {
    throw new Error('User not found');
  }
}

export async function getInboxItems(params: GetInboxItemsParams): Promise<GetInboxRes> {
  try {
    const docs = await inbox_model
      .find({ _id: { $in: params._ids } })
      .lean() as InboxDocument[];

    const migratedIds = docs.filter((d: any) => d.comments_migrated).map((d: any) => d._id);

    const grouped = migratedIds.length
      ? await inbox_comment_model.aggregate([
        { $match: { inbox_id: { $in: migratedIds }, status: 'active' } },
        { $sort: { date: 1 } },
        { $group: { _id: '$inbox_id', comments: { $push: '$$ROOT' } } }
      ])
      : [];
    const byInbox = new Map(grouped.map((g: any) => [g._id.toString(), g.comments]));

    const inboxItems: InboxItem[] = docs.map((doc: any) => {
      const comments: InboxComment[] = doc.comments_migrated
        ? (byInbox.get(doc._id.toString()) ?? []).map((c: any) => serializeInboxComment(c))
        : (Array.isArray(doc.comments) ? doc.comments : [])
          .filter((c: any) => c.status !== 'under_review' && c.status !== 'removed')
          .map((c: any) => serializeInboxComment(c, doc._id.toString()));

      return {
        ...doc,
        comments,
        comment_count: comments.length, // extra field, old clients ignore it
        _id: doc._id.toString(),
        sender: doc.sender.toString(),
        date: doc.date.toISOString(),
        reply: doc.reply ? (doc.reply as any) : undefined
      };
    }) as unknown as InboxItem[];

    const uniqueUserIds = Array.from(new Set(
      inboxItems.reduce((acc: string[], curr) => acc.concat(curr.original_followers), [])
    ));
    const userInfo = await getPartialUsers(uniqueUserIds);

    return { inboxItems, userInfo };
  } catch (e) {
    throw new Error('Inbox item not found');
  }
}

export async function comment(params: CommentParams) {
  try {
    const commentId = new Types.ObjectId();
    const commentData: InboxCommentDocument = {
      date: new Date(),
      message: params.message,
      sender: params.sender
    };

    await inbox_model.updateOne(
      { _id: params.inbox_id },
      {
        $set: {
          comments_seen_by: [new Types.ObjectId(params.sender)]
        },
        $push: {
          comments: commentData
        }
      }
    );

    trackEvent(params.sender, mixpanelEvents.drawing_comment);

    return {
      ...commentData,
      _id: commentId.toString(),
      date: commentData.date.toISOString()
    } as Comment;
  } catch (e) {
    console.log(e);
    throw new Error('Cannot place comment');
  }
}

export async function removeFromInbox(params: RemoveFromInboxParams) {
  try {
    trackEvent(params.user_id, mixpanelEvents.drawing_deleted);

    const inboxItem = await inbox_model.findByIdAndUpdate(
      params.inbox_id,
      { $pull: { followers: params.user_id } },
      { new: true }
    ).lean() as InboxDocument | null;

    // Legacy support for user document inbox array
    await user_model.findByIdAndUpdate(
      params.user_id,
      { $pull: { inbox: params.inbox_id } }
    );

    if (inboxItem && inboxItem.followers.length === 0) {
      await Promise.all([
        s3Creator.deleteBlob(inboxItem.thumbnail, CONTAINER.drawings),
        s3Creator.deleteBlob(inboxItem.image, CONTAINER.drawings),
        s3Creator.deleteBlob(inboxItem.drawing, CONTAINER.drawings),
        inbox_model.deleteOne({ _id: params.inbox_id }),
        // migrated items keep their comments here — clean them up too
        inbox_comment_model.deleteMany({ inbox_id: new Types.ObjectId(params.inbox_id) })
      ]);
    }
  } catch (e) {
    throw new Error('Cannot remove');
  }
}

export async function getUserSubscription(params: { _id: string }): Promise<Res<User>> {
  try {
    const user = await user_model.findById(params._id, {
      subscriptions: 1,
      mates: 1,
      _id: 1,
      img: 1
    }).lean() as UserDocument | null;
    if (!user) return undefined;
    return { ...user, _id: user._id.toString() } as unknown as User;
  } catch (e) {
    throw new Error('User not found');
  }
}

/**
 * Removes subscription entries whose FCM token is dead (reported by FCM as
 * unregistered/invalid). Keeps the subscriptions array free of stale tokens
 * so future sends don't silently target a device that will never receive them.
 */
export async function pruneSubscriptionTokens(user_id: string, tokens: string[]): Promise<void> {
  if (!tokens.length) return;
  try {
    await user_model.updateOne(
      { _id: user_id },
      { $pull: { subscriptions: { token: { $in: tokens } } } }
    );
  } catch (e) {
    console.error('Failed to prune dead subscription tokens', e);
  }
}

export async function match(params: MatchParams) {
  try {
    if (params._id === params.mate_id) throw new Error('Cannot match to oneself');

    const [user, mate] = await Promise.all([
      user_model.findById(params._id).lean() as Promise<UserDocument | null>,
      user_model.findById(params.mate_id).lean() as Promise<UserDocument | null>
    ]);

    if (!user || !mate) throw new Error('One of the users not found');

    // Legacy mate logic
    if (user.mates.some(m => m._id.toString() == mate._id.toString()) || mate.mates.some(m => m._id.toString() == user._id.toString()))
      throw new Error('Already matched');

    const newMatesForUser = [...user.mates, { _id: params.mate_id, name: mate.name, img: mate.img }];
    const newMatesForMate = [...mate.mates, { _id: user._id.toString(), name: user.name, img: user.img }];

    const filteredReceivedUser = user.mate_requests_received.filter(m => m.toString() != mate._id.toString());
    const filteredSentUser = user.mate_requests_sent.filter(m => m.toString() != mate._id.toString());

    const filteredReceivedMate = mate.mate_requests_received.filter(m => m.toString() != user._id.toString());
    const filteredSentMate = mate.mate_requests_sent.filter(m => m.toString() != user._id.toString());

    await Promise.all([
      user_model.updateOne(
        { _id: params._id },
        {
          $set: {
            mates: newMatesForUser,
            mate_requests_received: filteredReceivedUser,
            mate_requests_sent: filteredSentUser
          }
        }
      ),
      user_model.updateOne(
        { _id: params.mate_id },
        {
          $set: {
            mates: newMatesForMate,
            mate_requests_received: filteredReceivedMate,
            mate_requests_sent: filteredSentMate
          }
        }
      )
    ]);

    trackEvent(params._id, mixpanelEvents.match);

    return {
      user: { ...user, _id: user._id.toString() } as unknown as User,
      mate: { ...mate, _id: mate._id.toString() } as unknown as User
    };
  } catch (e) {
    throw new Error('Cannot match with mate');
  }
}

export async function storeMessage(params: SendParams): Promise<Res<InboxItem>> {
  try {
    const [blobUrl, imgUrl, thumbnailUrl] = await Promise.all([
      s3Creator.upload(params.drawing),
      s3Creator.uploadImg(params.img),
      s3Creator.uploadImg(await createThumbnail(params.img))
    ]);

    const date = new Date();
    const inboxItemId = new Types.ObjectId();

    const inboxItemData: Partial<InboxDocument> = {
      _id: inboxItemId,
      drawing: blobUrl,
      image: imgUrl,
      thumbnail: thumbnailUrl,
      date: date,
      sender: new Types.ObjectId(params._id),
      followers: params.followers,
      aspect_ratio: params.aspect_ratio,
      original_followers: params.followers,
      seen_by: [new Types.ObjectId(params._id)],
      comments_seen_by: [new Types.ObjectId(params._id)],
      comments: [],
      comments_migrated: true
    };

    await Promise.all([
      inbox_model.create(inboxItemData),
      ...params.followers.map(follower => user_model.updateOne({ _id: follower }, { $push: { inbox: inboxItemId.toString() } }))
    ]);

    trackEvent(params._id, mixpanelEvents.drawing_sent);

    return {
      ...inboxItemData,
      _id: inboxItemId.toString(),
      sender: params._id,
      date: date.toISOString()
    } as unknown as InboxItem;
  } catch (e) {
    console.log(e);
    throw new Error('Failed sending to mate');
  }
}

export async function unMatch(params: UnMatchParams): Promise<Res<void>> {
  try {
    await Promise.all([
      user_model.updateOne(
        { _id: params._id },
        { $pull: { mates: { _id: params.mate_id } } }
      ),
      user_model.updateOne(
        { _id: params.mate_id },
        { $pull: { mates: { _id: params._id } } }
      )
    ]);
    trackEvent(params._id, mixpanelEvents.unMatch);
  } catch (e) {
    throw new Error('Failed to unmatch');
  }
}

export async function subscribe(params: RegisterNotificationParams): Promise<Res<void>> {
  try {
    await user_model.updateOne(
      { _id: params.user_id },
      {
        $pull: {
          subscriptions: { fingerprint: params.subscription.fingerprint }
        }
      }
    );
    await user_model.updateOne(
      { _id: params.user_id },
      {
        $push: { subscriptions: params.subscription }
      }
    );
  } catch (e) {
    throw new Error('Failed to subscribe: ' + e);
  }
}

export async function unsubscribe(params: UnRegisterNotificationParams): Promise<Res<void>> {
  try {
    await user_model.updateOne(
      { _id: params.user_id },
      {
        $pull: {
          subscriptions: { fingerprint: params.fingerprint }
        }
      }
    );
  } catch (e) {
    throw new Error('Failed to unsubscribe');
  }
}

export async function onLoginEvent(params: OnLoginEventParams): Promise<any> {
  try {
    const user = await user_model.findOneAndUpdate(
      { _id: params.user_id, 'subscriptions.fingerprint': params.fingerprint },
      { $set: { 'subscriptions.$.logged_in': params.loggedIn } },
      { new: true }
    ).lean() as UserDocument | null;

    return user ? { ...user, _id: user._id.toString() } : null;
  } catch (e) {
    throw new Error('Failed to update subscriptions');
  }
}

export async function changeUserName(params: ChangeUserNameParams): Promise<Res<void>> {
  try {
    const user = await user_model.findById(params._id).lean() as UserDocument | null;
    if (!user) return;

    await user_model.updateOne({ _id: params._id }, { $set: { name: params.name } });

    if (user.mates && user.mates.length > 0) {
      const mateIds = user.mates.map(m => m._id);

      await user_model.updateMany(
        { _id: { $in: mateIds }, 'mates._id': params._id },
        { $set: { 'mates.$.name': params.name } }
      );
    }
  } catch (e) {
    throw new Error('Failed to change name');
  }
}

/**
 * Fields a user is allowed to change about themselves.
 *
 * This is an allowlist, not a deny-list, and that is deliberate. `UpdateUserParams`
 * is `Partial<User>`, and this function used to `$set` whatever arrived — so every
 * field on the schema was writable by anyone who could reach the route, and
 * `PUT /user/update` has no auth (the legacy root router serves clients that
 * predate it). The reachable damage included:
 *
 *   auth_id           → rebind an account to the caller's Firebase uid. This is
 *                       the same account-takeover that was removed from getUser();
 *                       it simply had a second door.
 *   restriction       → clear your own suspension. Ban evasion.
 *   subscription_tier → grant yourself Pro.
 *   inventory         → grant yourself paid cosmetics. Owned by the RevenueCat
 *                       webhook and the admin routes, nowhere else.
 *   is_admin          → did NOT grant admin (requireAdminAuth checks the Firebase
 *                       `sketchmate_admin` claim first, which is not settable here),
 *                       but it has no business being client-writable either.
 *   stats             → forge social counters that computeSocialStats derives.
 *
 * A new schema field is therefore un-writable until someone adds it here on
 * purpose. Anything rejected is logged rather than silently dropped, so a
 * legitimate field left off this list shows up in the logs instead of as a
 * silently broken setting.
 */
const SELF_SERVICE_FIELDS = new Set([
  'name',
  'description',
  'customization',
  'chat_customization',
  'date_of_birth',
  'timezone',
  'last_seen_version',
  'feed_level',
  'profanity_filter',
  'artist_highlights',
  'presence_invisible',
  'presence_status'
]);

/**
 * `balloon` holds two ObjectId refs (`sent`, `received`) that drive pairing, and
 * one genuine preference. The client sends the whole object back — it spreads
 * the values it already has — so keeping only the preference costs nothing and
 * stops a caller from rewriting another user's live balloon state.
 */
function sanitizeBalloon(raw: unknown): { disabled: boolean } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const disabled = (raw as any).disabled;
  return typeof disabled === 'boolean' ? { disabled } : undefined;
}

export async function updateUser(params: UpdateUserParams): Promise<Res<void>> {
  try {
    const { _id, ...updates } = params;
    if (!_id) throw new Error('User _id is required');

    const $set: Record<string, any> = {};
    const rejected: string[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (SELF_SERVICE_FIELDS.has(key)) {
        $set[key] = value;
      } else if (key !== 'parental' && key !== 'balloon') {
        rejected.push(key);
      }
    }

    // Parental switches arrive as a whole object from the controls sheet.
    // Rebuild it field by field and write with dotted paths, so a payload can
    // neither smuggle unknown keys in nor blank out flags it didn't mention.
    const raw = (updates as any).parental;
    if (raw !== undefined) {
      const clean = sanitizeParental(raw);
      if (clean) {
        Object.entries(clean).forEach(([key, value]) => {
          $set[`parental.${key}`] = value;
        });
      }
    }

    const balloon = sanitizeBalloon((updates as any).balloon);
    if (balloon) $set['balloon.disabled'] = balloon.disabled;

    if (rejected.length) {
      console.warn(
        `[updateUser] rejected non-self-service fields for ${String(_id)}: ${rejected.join(', ')}`
      );
    }

    if (Object.keys($set).length === 0) return;

    await user_model.updateOne({ _id }, { $set });

    // The gate caches age + flags for 30s; a parent flipping a switch should
    // see it take effect on the next request, not half a minute later.
    if (raw !== undefined) invalidateParentalCache(String(_id));
  } catch (e) {
    throw new Error('Failed to update user: ' + (e as Error).message);
  }
}

export async function uploadProfileImg(params: UploadProfileImgParams): Promise<string> {
  try {
    const url = await s3Creator.uploadFile(
      params.img.filepath,
      params.img.mimetype,
      CONTAINER.account
    );

    const user = await user_model.findById(params._id).lean() as UserDocument | null;
    if (!user) {
      fs.promises.unlink(params.img.filepath).catch(console.error);
      throw new Error('User not found');
    }

    await user_model.updateOne({ _id: params._id }, { $set: { img: url } });

    if (user.mates && user.mates.length > 0) {
      const mateIds = user.mates.map(m => m._id);
      await user_model.updateMany(
        { _id: { $in: mateIds }, 'mates._id': params._id },
        { $set: { 'mates.$.img': url } }
      );
    }

    if (params.previousImage && !params.previousImage.includes('stock')) {
      s3Creator.deleteBlob(params.previousImage, CONTAINER.account).catch(console.error);
    }

    fs.promises.unlink(params.img.filepath).catch(console.error);

    return url;
  } catch (e) {
    if (params.img?.filepath) {
      fs.promises.unlink(params.img.filepath).catch(console.error);
    }
    throw new Error('Failed to change profile image');
  }
}

export async function deleteProfileImg(user_id: string, stock_img: string) {
  try {
    const user = await user_model.findById(user_id).lean() as UserDocument | null;
    if (!user) return;

    await user_model.updateOne({ _id: user_id }, { $set: { img: stock_img } });

    if (user.mates && user.mates.length > 0) {
      const mateIds = user.mates.map(m => m._id);

      await user_model.updateMany(
        { _id: { $in: mateIds }, 'mates._id': user_id },
        { $set: { 'mates.$.img': stock_img } }
      );
    }

    if (user.img && !user.img.includes('stock')) {
      s3Creator.deleteBlob(user.img, CONTAINER.account).catch(console.error);
    }
  } catch (e) {
    console.error('Failed to delete profile image:', e);
  }
}

export async function createSticker(params: CreateStickerParams): Promise<Res<string>> {
  try {
    const url = await s3Creator.uploadFile(params.img.filepath, 'image/webp', CONTAINER.stickers);
    const new_url: string = await removeBackground(url!);

    await user_model.updateOne({ _id: params._id }, { $push: { stickers: new_url } });

    fs.promises.unlink(params.img.filepath).catch(console.error);
    return new_url;
  } catch (e) {
    throw new Error('Failed to create sticker');
  }
}

export async function createEmblem(params: CreateStickerParams): Promise<Res<string>> {
  try {
    const img = await imgToEmblem(params.img.filepath);
    const url = await s3Creator.uploadImg(img, CONTAINER.stickers);
    await user_model.updateOne({ _id: params._id }, { $push: { emblems: url } });

    fs.promises.unlink(params.img.filepath).catch(console.error);
    return url;
  } catch (e) {
    throw new Error('Failed to create emblem');
  }
}

export async function createSaved(params: CreateSavedParams): Promise<Res<Saved>> {
  try {
    const [drawing_url, img_url] = await Promise.all([
      s3Creator.uploadFile(params.drawing.filepath, 'application/json', CONTAINER.stickers),
      s3Creator.uploadFile(params.img.filepath, 'image/webp', CONTAINER.stickers)
    ]);
    const saved: Saved = { img: img_url!, drawing: drawing_url! };
    await user_model.updateOne({ _id: params._id }, { $push: { saved: saved } });

    Promise.all([
      fs.promises.unlink(params.drawing.filepath).catch(console.error),
      fs.promises.unlink(params.img.filepath).catch(console.error)
    ]);

    return saved;
  } catch (e) {
    throw new Error('Failed to create saved');
  }
}

export async function deleteSticker(params: DeleteStickerParams): Promise<void> {
  try {
    await s3Creator.deleteBlob(params.sticker_url, CONTAINER.stickers);
    await user_model.findByIdAndUpdate(params.user_id, {
      $pull: { stickers: params.sticker_url }
    });
  } catch (e) {
    throw new Error('Failed to delete sticker');
  }
}

export async function deleteEmblem(params: DeleteEmblemParams): Promise<void> {
  try {
    await s3Creator.deleteBlob(params.emblem_url, CONTAINER.stickers);
    await user_model.findByIdAndUpdate(params.user_id, {
      $pull: { emblems: params.emblem_url }
    });
  } catch (e) {
    throw new Error('Failed to delete emblem');
  }
}

export async function deleteSaved(params: DeleteSavedParams): Promise<void> {
  try {
    const saved: Saved = { img: params.img_url, drawing: params.drawing_url };
    await Promise.all([
      s3Creator.deleteBlob(params.img_url, CONTAINER.stickers),
      s3Creator.deleteBlob(params.drawing_url, CONTAINER.stickers),
      user_model.findByIdAndUpdate(params.user_id, {
        $pull: { saved: saved }
      })
    ]);
  } catch (e) {
    throw new Error('Failed to delete sticker');
  }
}

export async function seeInbox(params: SeeInboxParams) {
  try {
    await inbox_model.findByIdAndUpdate(params.inbox_id, {
      $addToSet: {
        seen_by: new Types.ObjectId(params.user_id),
        comments_seen_by: new Types.ObjectId(params.user_id)
      }
    });
  } catch (e) {
    throw new Error(e as any);
  }
}

// @deprecated
export async function createBalloon(params: CreateBalloonPostParams): Promise<Res<Balloon>> {
  const alreadyExistingBalloon = await balloon_model.findOne({ sender: new Types.ObjectId(params.sender) });

  if (alreadyExistingBalloon) {
    throw new Error('Balloon already exists');
  }

  const [drawingJsonUrl, img, thumbnail] = await Promise.all([
    s3Creator.upload(params.drawing),
    s3Creator.uploadImg(params.img),
    s3Creator.uploadImg(await createThumbnail(params.img))
  ]);

  const balloonId = new Types.ObjectId();
  const balloonToCreate: Partial<BalloonDocument> = {
    _id: balloonId,
    status: 'pending',
    createdAt: new Date(),
    lastActivityAt: new Date(),
    drawingJsonUrl,
    img,
    thumbnail,
    aspect_ratio: params.aspect_ratio,
    sender: new Types.ObjectId(params.sender),
    message: params.message,
    cancelledBalloons: [],
    version: params.version,
    rejected_by: []
  };

  try {
    await Promise.all([
      balloon_model.create(balloonToCreate),
      user_model.updateOne(
        { _id: params.sender },
        { $set: { 'balloon.sent': balloonId } }
      )
    ]);

    trackEvent(params.sender, mixpanelEvents.balloon_create);

    return {
      ...balloonToCreate,
      _id: balloonId.toString(),
      sender: params.sender,
      createdAt: balloonToCreate.createdAt!.toISOString(),
      lastActivityAt: balloonToCreate.lastActivityAt!.toISOString()
    } as unknown as Balloon;
  } catch (e) {
    throw new Error(`Failed to create balloon: ${(e as Error).message}`);
  }
}

export async function getBalloon(balloonId: string): Promise<Balloon | null> {
  try {
    const doc = await balloon_model.findById(balloonId).lean() as BalloonDocument | null;
    if (!doc) return null;
    return {
      ...doc,
      _id: doc._id.toString(),
      sender: doc.sender.toString(),
      createdAt: doc.createdAt.toISOString(),
      lastActivityAt: doc.lastActivityAt.toISOString()
    } as unknown as Balloon;
  } catch (error) {
    throw new Error(`Failed to get balloon: ${(error as Error).message}`);
  }
}

export async function sendMateRequest(params: SendMateRequestParams): Promise<void> {
  try {
    await Promise.all([
      user_model.updateOne(
        { _id: params.sender },
        { $addToSet: { mate_requests_sent: new Types.ObjectId(params.receiver) } }
      ),
      user_model.updateOne(
        { _id: params.receiver },
        { $addToSet: { mate_requests_received: new Types.ObjectId(params.sender) } }
      )
    ]);
  } catch (e) {
    console.error('Error sending mate request:', e);
    throw new Error('Failed to send mate request');
  }
}

export async function cancelSendMateRequest(params: SendMateRequestParams): Promise<void> {
  try {
    await Promise.all([
      user_model.updateOne(
        { _id: params.sender },
        { $pull: { mate_requests_sent: params.receiver } }
      ),
      user_model.updateOne(
        { _id: params.receiver },
        { $pull: { mate_requests_received: params.sender } }
      )
    ]);
  } catch (e) {
    console.error('Error canceling mate request:', e);
    throw new Error('Failed to cancel mate request');
  }
}

export async function refuseSendMateRequest(params: SendMateRequestParams): Promise<void> {
  try {
    await Promise.all([
      user_model.updateOne(
        { _id: params.sender },
        { $pull: { mate_requests_received: params.receiver } }
      ),
      user_model.updateOne(
        { _id: params.receiver },
        { $pull: { mate_requests_sent: params.sender } }
      )
    ]);
  } catch (e) {
    console.error('Error canceling mate request:', e);
    throw new Error('Failed to cancel mate request');
  }
}

export async function getPartialUsers(user_ids: string[]): Promise<Mate[]> {
  try {
    const docs = await user_model
      .find({
        _id: { $in: user_ids }
      }, { _id: 1, img: 1, name: 1, last_seen_version: 1 })
      .lean() as any[];

    return docs.map(doc => ({
      _id: doc._id.toString(),
      name: doc.name,
      img: doc.img,
      last_seen_version: doc.last_seen_version
    })) as Mate[];
  } catch (e: any) {
    throw new Error(e);
  }
}

export async function getPartialUser(user_id: string): Promise<Mate | null> {
  try {
    const doc = await user_model
      .findById(user_id, { _id: 1, img: 1, name: 1 })
      .lean() as UserDocument | null;

    if (!doc) return null;

    return {
      _id: doc._id.toString(),
      name: doc.name,
      img: doc.img
    } as Mate;
  } catch (e: any) {
    throw new Error(e);
  }
}

// Must match the client's `minimum_age_social_features` (general.config.ts).
const MINIMUM_SOCIAL_AGE = 13;

export async function searchMate(
  mateName: string,
  userId: string,
  limit = 10
): Promise<Mate[]> {
  try {
    const safeSearchTerm = escapeRegExp(mateName);

    // Families policy: under-age accounts are NOT discoverable by name search
    // (they still connect via QR / share link, i.e. people they know in
    // person). An account with no date_of_birth is excluded too — an unknown
    // age could be eight, and the client blocks on a birthday prompt anyway, so
    // the pool of unconfirmed accounts is transient.
    const dobCutoff = new Date();
    dobCutoff.setFullYear(dobCutoff.getFullYear() - MINIMUM_SOCIAL_AGE);

    const docs = await user_model
      .find({
        _id: { $ne: userId },
        name: { $regex: safeSearchTerm, $options: 'i' },
        date_of_birth: { $ne: null, $lte: dobCutoff }
      })
      .select(PUBLIC_USER_FIELDS)
      .limit(limit)
      .lean() as any[];

    return docs.map(doc => ({
      ...doc,
      _id: doc._id.toString()
    })) as Mate[];
  } catch (e: any) {
    throw new Error(e.message || e);
  }
}


