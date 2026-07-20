import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Types } from 'mongoose';
import { RelationshipDocument } from '../../types/mongoose.types';

dayjs.extend(relativeTime);

/**
 * How often one person may ask another to be Mates.
 *
 * The problem this solves: declining a mate request dropped the relationship
 * back to 'temporary' and cleared action_user_id, so the requester could
 * immediately re-send — and every send pushes a notification. Two people stuck
 * in a 24-hour trial could be pestered without limit, which is a safety issue
 * on an app with minors, not just an annoyance.
 *
 * The shape of the answer matters. A flat rate limit ("one per hour") is the
 * obvious move and the wrong one: it caps the RATE of pestering without ever
 * ending it, so someone determined still gets to ask forever. What actually
 * stops it is treating a decline as information — each "no" should cost the
 * asker more than the last, and enough of them should mean no.
 *
 *   1st decline →   6h
 *   2nd decline →  12h
 *   3rd decline →  24h
 *   4th decline →   7d
 *   5th decline → done. No further requests in this relationship.
 *
 * The ladder starts short on purpose. A trial is 24 hours, and the common case
 * is not a pest — it is someone who said no, thought about it, and changed
 * their mind while the trial is still alive. Burning the whole trial on the
 * first decline punished that person to deter a rarer one. Six hours still
 * breaks a tapping loop, and by the time anyone reaches the 7-day rung they
 * have been told no four separate times across more than a day and a half.
 *
 * Three properties worth keeping when touching this:
 *
 *  - PER DIRECTION. Being declined never blocks the OTHER person from asking.
 *    A shared lock would let one "no" deadlock a pair who both later change
 *    their minds, and the partner asking is exactly the healthy path out.
 *  - CANCELS COST TOO, but don't count as declines. Cancelling and re-sending
 *    re-pings the partner just as hard, so it takes a short cooldown; it isn't
 *    a rejection though, so it must not push anyone up the ladder.
 *  - MONOTONIC. `declines` only ever grows. Anything that resets it on a state
 *    change hands back an unlimited budget to whoever is willing to wait for
 *    that state change.
 */
const DECLINE_COOLDOWNS_HOURS = [6, 12, 24, 168];
const MAX_DECLINES = DECLINE_COOLDOWNS_HOURS.length + 1; // 5th decline locks

/** A cancelled request still cost the partner a notification. */
const CANCEL_COOLDOWN_HOURS = 1;

export interface MateRequestGate {
  allowed: boolean;
  /** Set when blocked for good — no cooldown will clear it. */
  locked: boolean;
  cooldown_until?: Date;
  reason?: string;
}

const entryFor = (rel: RelationshipDocument, userId: string) =>
  rel.mate_requests?.find((r) => r.requester.toString() === userId);

/**
 * May `userId` send a mate request on this relationship right now?
 * Pure — callers decide what to do with the verdict.
 */
export function canSendMateRequest(
  rel: RelationshipDocument,
  userId: string
): MateRequestGate {
  const entry = entryFor(rel, userId);
  if (!entry) return { allowed: true, locked: false };

  if (entry.declines >= MAX_DECLINES) {
    return {
      allowed: false,
      locked: true,
      reason: 'They have declined a few times. You can’t send another request to them.'
    };
  }

  if (entry.cooldown_until && dayjs().isBefore(dayjs(entry.cooldown_until))) {
    return {
      allowed: false,
      locked: false,
      cooldown_until: entry.cooldown_until,
      reason: `You can send another request ${dayjs(entry.cooldown_until).fromNow()}.`
    };
  }

  return { allowed: true, locked: false };
}

/**
 * Has `userId` asked this partner before?
 *
 * Drives push suppression: the FIRST ask earns a push notification, every
 * repeat is in-app only. The pestering harm was never the request itself, it
 * was the notification — so repeats stay possible (people do change their
 * minds) but stop being able to buzz someone's phone.
 *
 * Keyed on `attempts`, not `declines`, because cancel-and-resend re-pings the
 * partner exactly as hard as decline-and-resend.
 *
 * MUST be read before `recordMateRequestSent`, which increments `attempts`.
 */
export function isRepeatMateRequest(rel: RelationshipDocument, userId: string): boolean {
  const entry = entryFor(rel, userId);
  return !!entry && entry.attempts > 0;
}

/** Record that `userId` just sent a request. Mutates `rel`; caller saves. */
export function recordMateRequestSent(rel: RelationshipDocument, userId: string) {
  if (!rel.mate_requests) rel.mate_requests = [];
  const entry = entryFor(rel, userId);

  if (entry) {
    entry.attempts += 1;
    entry.last_requested_at = new Date();
    entry.cooldown_until = undefined;
  } else {
    rel.mate_requests.push({
      requester: new Types.ObjectId(userId),
      declines: 0,
      attempts: 1,
      last_requested_at: new Date()
    } as any);
  }
}

/**
 * The partner said no. Escalate the requester's cooldown, or lock them out if
 * they've now used up the ladder. Mutates `rel`; caller saves.
 */
export function recordMateRequestDeclined(rel: RelationshipDocument, requesterId: string) {
  if (!rel.mate_requests) rel.mate_requests = [];
  let entry = entryFor(rel, requesterId);

  if (!entry) {
    // Shouldn't happen (a decline implies a send) but a missing ledger must not
    // silently grant an unlimited budget.
    rel.mate_requests.push({
      requester: new Types.ObjectId(requesterId),
      declines: 0,
      attempts: 1
    } as any);
    entry = entryFor(rel, requesterId)!;
  }

  entry.declines += 1;

  if (entry.declines >= MAX_DECLINES) {
    entry.cooldown_until = undefined; // locked; a date would imply it expires
    return;
  }

  const hours = DECLINE_COOLDOWNS_HOURS[entry.declines - 1];
  entry.cooldown_until = dayjs().add(hours, 'hour').toDate();
}

/** The requester withdrew. Short cooldown, no ladder movement. */
export function recordMateRequestCancelled(rel: RelationshipDocument, requesterId: string) {
  const entry = entryFor(rel, requesterId);
  if (!entry) return;
  entry.cooldown_until = dayjs().add(CANCEL_COOLDOWN_HOURS, 'hour').toDate();
}

/**
 * The per-user view the client needs to render the right affordance: hide the
 * button and say why, rather than offer it and fail the request.
 */
export function mateRequestStateFor(rel: RelationshipDocument, userId: string) {
  const gate = canSendMateRequest(rel, userId);
  return {
    mate_request_locked: gate.locked,
    mate_request_cooldown_until: gate.cooldown_until ?? null
  };
}
