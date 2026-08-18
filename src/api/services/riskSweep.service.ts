import { Types } from 'mongoose';
import { conversation_model } from '../../models/conversation.model';
import { message_model } from '../../models/message.model';
import { risk_flag_model } from '../../models/risk-flag.model';
import { user_model } from '../../models/user.model';

/**
 * NIGHTLY RISK SWEEP
 *
 * The reporting system is reactive by construction: a report exists only after
 * someone was already harmed enough to file one. This finds the same patterns
 * from behaviour alone, before a victim has to act.
 *
 * It is not AI and it costs nothing per run beyond the queries below. Every
 * signal is something the database already knows.
 *
 * COST is the design constraint, so this never loops per user. Running
 * buildUserEvidence() across every active account would be ~10 queries each and
 * would not survive a real userbase. Instead the whole sweep is a fixed number
 * of aggregations over a bounded candidate set, and the per-user maths happens
 * in memory afterwards.
 *
 * What it deliberately does NOT do: restrict, strike, or hide anything. A flag
 * only puts a name on a list a human reads. Every one of these rules will have
 * false positives — a popular artist gets unanswered messages too — so nothing
 * downstream of this is automatic.
 */

/** Hard ceiling on accounts examined per run, so cost stays predictable. */
const MAX_CANDIDATES = 5000;

/** Conversations older than this are established relationships, not outreach. */
const OUTREACH_WINDOW_DAYS = 30;

/** Sent this many into silence before a conversation counts as one-sided. */
const ONE_SIDED_MIN_SENT = 3;

const DAY_MS = 86_400_000;

type Rule = {
  id: string;
  severity: 'low' | 'medium' | 'high';
  /** Returns a summary line when it fires, null when it does not. */
  test: (m: Metrics) => string | null;
};

interface Metrics {
  account_age_days: number;
  is_adult: boolean;
  conversations_engaged: number;
  one_sided_conversations: number;
  one_sided_ratio: number;
  distinct_contacts: number;
  minor_contacts: number;
  minor_contact_ratio: number;
  profanity_hits_24h: number;
}

/**
 * Thresholds are deliberately conservative. This queue is read by one person;
 * a rule that fires on 5% of a healthy userbase is a rule that gets ignored,
 * and an ignored queue is worse than no queue.
 */
const RULES: Rule[] = [
  {
    id: 'mass_unsolicited_contact',
    severity: 'high',
    test: (m) =>
      m.conversations_engaged >= 5 && m.one_sided_ratio >= 0.6
        ? `Opened ${m.conversations_engaged} conversations, ${m.one_sided_conversations} got no reply at all (${Math.round(m.one_sided_ratio * 100)}%).`
        : null
  },
  {
    // The pattern behind the reports from the community: an adult account whose
    // contacts are overwhelmingly children. Invisible in any single thread.
    id: 'adult_contacting_minors',
    severity: 'high',
    test: (m) =>
      m.is_adult && m.distinct_contacts >= 3 && m.minor_contact_ratio >= 0.7
        ? `Adult account: ${m.minor_contacts} of ${m.distinct_contacts} recent contacts are under 16.`
        : null
  },
  {
    id: 'new_account_spraying',
    severity: 'medium',
    test: (m) =>
      m.account_age_days <= 7 && m.one_sided_conversations >= 3
        ? `Account is ${m.account_age_days} day(s) old and already has ${m.one_sided_conversations} unanswered conversations.`
        : null
  },
  {
    id: 'hostile_outreach',
    severity: 'medium',
    test: (m) =>
      m.profanity_hits_24h >= 5 && m.one_sided_ratio >= 0.5
        ? `${m.profanity_hits_24h} filter-matched messages in 24h, mostly into conversations that get no reply.`
        : null
  }
];

const ageOf = (dob?: Date | null): number | null => {
  if (!dob) return null;
  return Math.floor((Date.now() - new Date(dob).getTime()) / 31_557_600_000);
};

export async function runRiskSweep(): Promise<{
  candidates: number;
  flagged: number;
  byRule: Record<string, number>;
}> {
  const since24h = new Date(Date.now() - DAY_MS);
  const outreachCutoff = new Date(Date.now() - OUTREACH_WINDOW_DAYS * DAY_MS);

  // 1. Who was active. Uses the sender_id index added to message.model.ts.
  const activeSenders = (await message_model
    .distinct('sender_id', { createdAt: { $gte: since24h }, type: { $ne: 'system' } })
    .then((ids) => ids.slice(0, MAX_CANDIDATES))) as Types.ObjectId[];

  if (!activeSenders.length) return { candidates: 0, flagged: 0, byRule: {} };

  const candidateSet = new Set(activeSenders.map((id) => id.toString()));

  // 2. Their recent conversations. Bounded to the outreach window: an old,
  //    quiet friendship is not the shape we are looking for, and including it
  //    would make every long-time user look one-sided.
  const conversations = await conversation_model
    .find({ participants: { $in: activeSenders }, createdAt: { $gte: outreachCutoff } })
    .select('_id participants')
    .lean();

  if (!conversations.length) return { candidates: activeSenders.length, flagged: 0, byRule: {} };

  const conversationIds = conversations.map((c: any) => c._id);

  // 3. ONE aggregation for every message count in those conversations, keyed by
  //    (conversation, sender). Everything about one-sidedness derives from this.
  const counts = await message_model.aggregate([
    { $match: { conversation_id: { $in: conversationIds }, type: { $ne: 'system' } } },
    {
      $group: {
        _id: { conversation: '$conversation_id', sender: '$sender_id' },
        n: { $sum: 1 }
      }
    }
  ]);

  const perConversation = new Map<string, Map<string, number>>();
  for (const row of counts) {
    const conversationId = String(row._id.conversation);
    if (!perConversation.has(conversationId)) perConversation.set(conversationId, new Map());
    perConversation.get(conversationId)!.set(String(row._id.sender), row.n);
  }

  // 4. Ages: the subject's own, and every contact's.
  const partnerIds = new Set<string>();
  for (const conversation of conversations as any[]) {
    for (const participant of conversation.participants) {
      partnerIds.add(String(participant));
    }
  }

  const people = await user_model
    .find({ _id: { $in: [...partnerIds].map((id) => new Types.ObjectId(id)) } })
    .select('date_of_birth createdAt')
    .lean();

  const ageById = new Map<string, number | null>();
  const createdById = new Map<string, Date>();
  for (const person of people as any[]) {
    ageById.set(String(person._id), ageOf(person.date_of_birth));
    createdById.set(String(person._id), person.createdAt);
  }

  // 5. Profanity hits in the window, one grouped pass.
  const profanityRows = await message_model.aggregate([
    {
      $match: {
        sender_id: { $in: activeSenders },
        createdAt: { $gte: since24h },
        content_filtered: { $exists: true, $ne: null }
      }
    },
    { $group: { _id: '$sender_id', n: { $sum: 1 } } }
  ]);
  const profanityById = new Map<string, number>(
    profanityRows.map((row: any) => [String(row._id), row.n])
  );

  // 6. Per-candidate maths, in memory. No further database reads.
  const metricsById = new Map<string, Metrics>();

  for (const conversation of conversations as any[]) {
    const conversationId = String(conversation._id);
    const senderCounts = perConversation.get(conversationId);
    if (!senderCounts) continue;

    const participants = conversation.participants.map((p: any) => String(p));

    for (const participant of participants) {
      if (!candidateSet.has(participant)) continue;

      const sent = senderCounts.get(participant) ?? 0;
      if (sent === 0) continue;

      let received = 0;
      for (const [senderId, n] of senderCounts) {
        if (senderId !== participant) received += n;
      }

      const others = participants.filter((p: string) => p !== participant);

      let metrics = metricsById.get(participant);
      if (!metrics) {
        const createdAt = createdById.get(participant);
        const subjectAge = ageById.get(participant) ?? null;
        metrics = {
          account_age_days: createdAt
            ? Math.floor((Date.now() - new Date(createdAt).getTime()) / DAY_MS)
            : 9999,
          // Unknown age is NOT treated as adult. Same default-deny rule as
          // isUnderAge in the client and parental.service on the server:
          // guessing "adult" here would aim the minor-contact rule at exactly
          // the accounts whose age we failed to record.
          is_adult: subjectAge !== null && subjectAge >= 18,
          conversations_engaged: 0,
          one_sided_conversations: 0,
          one_sided_ratio: 0,
          distinct_contacts: 0,
          minor_contacts: 0,
          minor_contact_ratio: 0,
          profanity_hits_24h: profanityById.get(participant) ?? 0
        };
        metricsById.set(participant, metrics);
      }

      metrics.conversations_engaged += 1;
      if (received === 0 && sent >= ONE_SIDED_MIN_SENT) metrics.one_sided_conversations += 1;

      for (const other of others) {
        metrics.distinct_contacts += 1;
        const otherAge = ageById.get(other);
        if (otherAge !== null && otherAge !== undefined && otherAge < 16) metrics.minor_contacts += 1;
      }
    }
  }

  // 7. Evaluate rules and file flags.
  const byRule: Record<string, number> = {};
  let flagged = 0;

  for (const [userId, metrics] of metricsById) {
    metrics.one_sided_ratio = metrics.conversations_engaged
      ? metrics.one_sided_conversations / metrics.conversations_engaged
      : 0;
    metrics.minor_contact_ratio = metrics.distinct_contacts
      ? metrics.minor_contacts / metrics.distinct_contacts
      : 0;

    for (const rule of RULES) {
      const summary = rule.test(metrics);
      if (!summary) continue;

      // Upsert on the partial unique index: a rule that keeps firing on the
      // same account refreshes one flag rather than stacking a new one nightly.
      await risk_flag_model.updateOne(
        { user_id: new Types.ObjectId(userId), rule: rule.id, status: 'open' },
        {
          $set: {
            severity: rule.severity,
            summary,
            metrics: {
              ...metrics,
              one_sided_ratio: Number(metrics.one_sided_ratio.toFixed(2)),
              minor_contact_ratio: Number(metrics.minor_contact_ratio.toFixed(2))
            }
          },
          $setOnInsert: {
            user_id: new Types.ObjectId(userId),
            rule: rule.id,
            status: 'open'
          }
        },
        { upsert: true }
      );

      byRule[rule.id] = (byRule[rule.id] || 0) + 1;
      flagged += 1;
    }
  }

  return { candidates: activeSenders.length, flagged, byRule };
}
