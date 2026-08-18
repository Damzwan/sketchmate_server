import { Types } from 'mongoose';
import { conversation_model } from '../../models/conversation.model';
import { message_model } from '../../models/message.model';
import { post_comment_model, post_model } from '../../models/post.model';
import { report_model } from '../../models/moderation.model';
import { user_model } from '../../models/user.model';

/**
 * MODERATION EVIDENCE — the dossier behind "should I ban this person?"
 *
 * The naive version of this endpoint dumps every message a user ever sent and
 * lets a human (or a model) read it. That does not survive contact with a real
 * account: a chatty teenager produces tens of thousands of messages, almost all
 * of them "hi", and the handful that matter are buried.
 *
 * So this does two things instead of one:
 *
 *   SIGNALS — cheap aggregate facts that need no reading at all, and no model.
 *     How many distinct people they messaged, how many of those conversations
 *     were one-sided, how many of their contacts are children, how many
 *     distinct people reported them. In practice these decide most cases on
 *     their own: someone who opened 40 conversations, got replies in 3, and
 *     whose contacts are mostly under 16 is a pattern you can act on without
 *     reading a word.
 *
 *   EVIDENCE — a bounded, deliberately *biased* sample of their text. Not a
 *     random slice: reported content first, then messages the profanity filter
 *     already matched at write time, then a recent spread across distinct
 *     conversations. The point is to surface the worst of what they wrote, not
 *     a representative view of it.
 *
 * Everything here is read-only and admin-gated. It reads private DMs, which is
 * a real intrusion — it exists because deciding a ban on a grooming report
 * requires seeing the messages, and the alternative is deciding blind.
 */

// Per-bucket caps. The sum is what a model has to read, and what a human has to
// scroll. Raising these makes reports slower and more expensive without making
// the decision better — the signal is concentrated in the first two buckets.
const MAX_REPORTED = 40;
const MAX_FLAGGED = 60;
const MAX_SAMPLE = 150;
const MAX_POSTS = 30;
const MAX_COMMENTS = 40;
const MAX_TEXT_LEN = 600;

/** A conversation where they sent this many with nothing back reads as one-sided. */
const ONE_SIDED_MIN_SENT = 3;

const trim = (value: unknown) => String(value ?? '').trim().slice(0, MAX_TEXT_LEN);

function ageBandOf(dob?: Date | null): string {
  if (!dob) return 'unknown';
  const age = Math.floor((Date.now() - new Date(dob).getTime()) / 31_557_600_000);
  if (age < 13) return 'under_13';
  if (age < 16) return '13_15';
  if (age < 18) return '16_17';
  return '18_plus';
}

export async function buildUserEvidence(userId: string) {
  const objectId = new Types.ObjectId(userId);

  const [user, conversations] = await Promise.all([
    user_model
      .findById(objectId)
      .select('name createdAt date_of_birth restriction strike_summary stats')
      .lean() as any,
    conversation_model
      .find({ participants: objectId })
      .select('_id participants')
      .lean()
  ]);

  if (!user) return null;

  const conversationIds = conversations.map((c: any) => c._id);

  // One aggregation answers both "how many people" and "how many ignored them".
  const perConversation = conversationIds.length
    ? await message_model.aggregate([
        { $match: { conversation_id: { $in: conversationIds }, type: { $ne: 'system' } } },
        {
          $group: {
            _id: '$conversation_id',
            sent: { $sum: { $cond: [{ $eq: ['$sender_id', objectId] }, 1, 0] } },
            received: { $sum: { $cond: [{ $eq: ['$sender_id', objectId] }, 0, 1] } }
          }
        }
      ])
    : [];

  const engaged = perConversation.filter((c: any) => c.sent > 0);
  const oneSided = engaged.filter(
    (c: any) => c.received === 0 && c.sent >= ONE_SIDED_MIN_SENT
  );
  const messagesSent = engaged.reduce((sum: number, c: any) => sum + c.sent, 0);

  // Age bands of everyone they have talked to. The grooming pattern this is
  // meant to surface is an adult (or an account claiming to be one) whose
  // contacts skew heavily young — that is invisible in any single conversation.
  const partnerIds = conversations
    .flatMap((c: any) => c.participants)
    .filter((p: any) => p.toString() !== userId);

  const partners = partnerIds.length
    ? await user_model
        .find({ _id: { $in: partnerIds } })
        .select('date_of_birth')
        .lean()
    : [];

  const partnerAgeBands = partners.reduce((acc: Record<string, number>, p: any) => {
    const band = ageBandOf(p.date_of_birth);
    acc[band] = (acc[band] || 0) + 1;
    return acc;
  }, {});

  const [
    reports,
    distinctReporters,
    flaggedMessages,
    sampleMessages,
    posts,
    comments,
    profanityCount
  ] = await Promise.all([
    report_model
      .find({ target_author_id: objectId })
      .select('reason details target_type status content_snapshot createdAt')
      .sort({ createdAt: -1 })
      .limit(MAX_REPORTED)
      .lean(),
    report_model.distinct('reporter_id', { target_author_id: objectId }),
    // The profanity filter already ran on every message at write time and stored
    // a censored twin only on a match — so this field being set IS a pre-computed
    // "this one matched", free to query and needing no scan.
    message_model
      .find({ sender_id: objectId, content_filtered: { $exists: true, $ne: null } })
      .select('content conversation_id createdAt')
      .sort({ createdAt: -1 })
      .limit(MAX_FLAGGED)
      .lean(),
    message_model
      .find({ sender_id: objectId, type: { $ne: 'system' }, content: { $ne: '' } })
      .select('content conversation_id createdAt')
      .sort({ createdAt: -1 })
      .limit(MAX_SAMPLE)
      .lean(),
    post_model
      .find({ author_id: objectId })
      .select('description status reports_count createdAt')
      .sort({ createdAt: -1 })
      .limit(MAX_POSTS)
      .lean(),
    post_comment_model
      .find({ author_id: objectId })
      .select('message status reports_count createdAt')
      .sort({ createdAt: -1 })
      .limit(MAX_COMMENTS)
      .lean(),
    message_model.countDocuments({
      sender_id: objectId,
      content_filtered: { $exists: true, $ne: null }
    })
  ]);

  const accountAgeDays = Math.floor(
    (Date.now() - new Date(user.createdAt).getTime()) / 86_400_000
  );

  return {
    subject: {
      _id: userId,
      name: user.name,
      account_age_days: accountAgeDays,
      age_band: ageBandOf(user.date_of_birth),
      restriction_level: user.restriction?.level ?? 0,
      active_strikes: user.strike_summary?.active_strikes ?? 0
    },
    signals: {
      account_age_days: accountAgeDays,
      messages_sent: messagesSent,
      conversations_started: engaged.length,
      one_sided_conversations: oneSided.length,
      // The number that matters most in a spray pattern: opened a lot of
      // conversations, got answered in almost none.
      one_sided_ratio: engaged.length
        ? Number((oneSided.length / engaged.length).toFixed(2))
        : 0,
      profanity_flagged_messages: profanityCount,
      distinct_reporters: distinctReporters.length,
      total_reports: reports.length,
      contact_age_bands: partnerAgeBands,
      posts_published: user.stats?.posts ?? 0
    },
    evidence: {
      reported: reports.map((r: any) => ({
        reason: r.reason,
        target_type: r.target_type,
        status: r.status,
        reporter_note: trim(r.details),
        content: trim(
          r.content_snapshot?.message ||
            r.content_snapshot?.description ||
            r.content_snapshot?.reported_message
        ),
        at: r.createdAt
      })),
      profanity_flagged: flaggedMessages.map((m: any) => ({
        content: trim(m.content),
        at: m.createdAt
      })),
      recent_messages: sampleMessages.map((m: any) => ({
        content: trim(m.content),
        // Included so a model can see the same line repeated across many
        // different threads — the copy-paste spray signature.
        thread: String(m.conversation_id).slice(-6),
        at: m.createdAt
      })),
      posts: posts.map((p: any) => ({
        description: trim(p.description),
        status: p.status,
        reports: p.reports_count ?? 0,
        at: p.createdAt
      })),
      comments: comments.map((c: any) => ({
        content: trim(c.message),
        status: c.status,
        reports: c.reports_count ?? 0,
        at: c.createdAt
      }))
    }
  };
}
