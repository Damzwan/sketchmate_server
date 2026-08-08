import { Types } from 'mongoose';
import {
  competition_entry_model,
  competition_model,
  competition_notification_model,
  competition_vote_model,
  CompetitionDocument,
} from '../../models/competition.model';
import { user_model } from '../../models/user.model';
import { describeGrant } from '../../config/catalog.config';
import {
  competitionLastCallPushNotification,
  competitionResultsPushNotification,
  competitionThemePushNotification,
  competitionWinPushNotification,
} from '../../config/notification.config';
import { dispatchNotification } from './notification.service';
import { phaseFor } from '../../config/competition.config';

/**
 * Weekly competition notifications.
 *
 * These are the sharpest tool in the feature and the easiest way to make it
 * annoying, so the rules are deliberately strict:
 *
 *   - one user preference, `competition.notifications`, default on;
 *   - a hard cap of 3 sends per user per week;
 *   - each send additionally suppressed by behaviour (see below);
 *   - the "you won" push ignores the behaviour suppressions but still respects
 *     the preference — being told you won is the entire payoff.
 *
 * Delivery is driven by the same hourly cron as the phase advancer: each tick
 * picks users whose LOCAL hour matches a slot, so everyone gets it at a sane
 * time of day without a per-user scheduler. `competition_notifications` is the
 * at-most-once ledger; without it a clock change or a double tick resends.
 */

export type NotificationSlot =
  | 'theme'
  | 'last_call'
  | 'results'
  | 'win'
  | 'results_in_app'
  | 'win_in_app'
  | 'submissions_closed_in_app';

const PUSH_SLOTS: NotificationSlot[] = ['theme', 'last_call', 'results', 'win'];

/** Local hour (0–23) each slot fires at. */
const SLOT_HOURS: Record<'theme' | 'last_call' | 'results', number> = {
  theme: 10,
  last_call: 18,
  results: 19,
};

/** Nobody gets more than this many competition pushes in one week. */
const MAX_PER_WEEK = 3;

/** A user who hasn't looked at the competition in this long stops being nudged. */
const DORMANT_AFTER_WEEKS = 3;

const HOUR_MS = 60 * 60 * 1000;

/** Users with no timezone set are treated as UTC rather than skipped. */
function localHour(timezone: string | undefined, now: Date): number {
  if (!timezone) return now.getUTCHours();
  try {
    return (
      Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          hour: 'numeric',
          hour12: false,
        }).format(now)
      ) % 24
    );
  } catch {
    return now.getUTCHours();
  }
}

/**
 * Claim the right to send. Returns false when this user already got this slot
 * this week, or when they have hit the weekly cap.
 *
 * Claim-then-send (rather than send-then-record) means a crash mid-send costs
 * one notification instead of spamming on the next tick.
 */
async function claimSlot(userId: Types.ObjectId, weekKey: string, slot: NotificationSlot): Promise<boolean> {
  const sent = await competition_notification_model.countDocuments({
    user_id: userId,
    week_key: weekKey,
    slot: { $in: PUSH_SLOTS },
  });
  if (PUSH_SLOTS.includes(slot) && sent >= MAX_PER_WEEK) return false;

  try {
    await competition_notification_model.create({
      user_id: userId,
      week_key: weekKey,
      slot,
    });
    return true;
  } catch (error: any) {
    // Unique index — already sent. Not an error.
    if (error?.code === 11000) return false;
    throw error;
  }
}

/** The first real reward on offer, described for the push body. */
function rewardSummary(comp: CompetitionDocument): string | undefined {
  for (const category of comp.categories) {
    const item = category.reward_items.find((id) => !id.startsWith('title.'));
    if (item) {
      const grant = describeGrant(item);
      return `${grant.emoji} ${grant.label}`;
    }
  }
  return undefined;
}

/**
 * Has this user engaged with the competition recently enough to be worth
 * nudging? An entry or a vote in the last few weeks counts; anything else is
 * someone who has ignored the feature and should stop hearing about it.
 */
async function isEngaged(userId: Types.ObjectId): Promise<boolean> {
  const since = new Date(Date.now() - DORMANT_AFTER_WEEKS * 7 * 24 * HOUR_MS);

  const [entered, voted] = await Promise.all([
    competition_entry_model.exists({ user_id: userId, submitted_at: { $gte: since } }),
    competition_vote_model.exists({ voter_id: userId, createdAt: { $gte: since } }),
  ]);

  return !!entered || !!voted;
}

interface Candidate {
  _id: Types.ObjectId;
  timezone?: string;
}

/**
 * Users who opted in and whose local time is at `hour` right now.
 *
 * `competition.notifications` defaults to true in the schema, but documents
 * written before this feature existed have no such field at all — hence the
 * explicit `$ne: false` rather than `: true`.
 */
async function candidatesAtLocalHour(hour: number, now: Date): Promise<Candidate[]> {
  const users = await pushCandidates();
  return users.filter((user) => localHour(user.timezone, now) === hour);
}

async function pushCandidates(): Promise<Candidate[]> {
  const users = await user_model
    .find({ 'competition.notifications': { $ne: false } })
    .select('_id timezone subscriptions')
    .lean();

  return users.filter((u: any) => u.subscriptions?.length > 0).map((u: any) => ({ _id: u._id, timezone: u.timezone }));
}

// ─── SLOTS ───────────────────────────────────────────────────────────────────

async function sendThemeSlot(comp: CompetitionDocument, now: Date): Promise<number> {
  const candidates = await candidatesAtLocalHour(SLOT_HOURS.theme, now);
  const reward = rewardSummary(comp);
  let sent = 0;

  for (const user of candidates) {
    // Nudging someone who has never engaged is how a feature becomes spam.
    if (!(await isEngaged(user._id))) continue;
    if (!(await claimSlot(user._id, comp.week_key, 'theme'))) continue;

    await dispatchNotification({
      recipient_id: user._id.toString(),
      type: 'competition',
      channels: { push: competitionThemePushNotification(comp.theme, reward) },
    });
    sent++;
  }
  return sent;
}

async function sendLastCallSlot(comp: CompetitionDocument, now: Date): Promise<number> {
  // Only worth sending inside the last day of submissions.
  const hoursLeft = (comp.submissions_close_at.getTime() - now.getTime()) / HOUR_MS;
  if (hoursLeft <= 0 || hoursLeft > 24) return 0;

  const candidates = await candidatesAtLocalHour(SLOT_HOURS.last_call, now);
  let sent = 0;

  for (const user of candidates) {
    // Pointless for someone who already entered — they have nothing left to do.
    const alreadyEntered = await competition_entry_model.exists({
      competition_id: comp._id,
      user_id: user._id,
    });
    if (alreadyEntered) continue;
    if (!(await isEngaged(user._id))) continue;
    if (!(await claimSlot(user._id, comp.week_key, 'last_call'))) continue;

    await dispatchNotification({
      recipient_id: user._id.toString(),
      type: 'competition',
      channels: { push: competitionLastCallPushNotification(comp.theme) },
    });
    sent++;
  }
  return sent;
}

/**
 * Results go only to people with a stake in them — entrants and voters. Telling
 * someone who never opened the competition who won it is noise.
 */
async function sendResultsSlot(comp: CompetitionDocument, now: Date): Promise<number> {
  const announcedAt = comp.announced_at?.getTime() ?? comp.ends_at.getTime();
  const ageHours = (now.getTime() - announcedAt) / HOUR_MS;
  const candidates = (await pushCandidates()).filter(
    (user) => localHour(user.timezone, now) >= SLOT_HOURS.results || ageHours >= 24
  );
  let sent = 0;

  for (const user of candidates) {
    const [entry, voted] = await Promise.all([
      competition_entry_model
        .findOne({ competition_id: comp._id, user_id: user._id, status: 'active' })
        .select('total_votes')
        .lean(),
      competition_vote_model.exists({ competition_id: comp._id, voter_id: user._id }),
    ]);
    if (!entry && !voted) continue;

    // Winners already got the far better "you won" push at announce time.
    const isWinner = comp.results.some((r) => r.user_id.toString() === user._id.toString());
    if (isWinner) continue;

    if (!(await claimSlot(user._id, comp.week_key, 'results'))) continue;

    await dispatchNotification({
      recipient_id: user._id.toString(),
      type: 'competition',
      channels: {
        push: competitionResultsPushNotification(comp.theme, comp._id.toString(), entry?.total_votes),
      },
    });
    sent++;
  }
  return sent;
}

// ─── WINNERS ─────────────────────────────────────────────────────────────────

/**
 * Fired once, from `announceCompetition()`, not from the hourly slots: a win is
 * time-sensitive and must not wait for the recipient's local evening.
 *
 * Writes the in-app row unconditionally (the bell is not an interruption) and
 * sends the push only if the user hasn't switched competition pushes off. None
 * of the engagement suppressions apply — you cannot be "too dormant" to be told
 * you won.
 */
export async function notifyWinners(comp: CompetitionDocument): Promise<void> {
  for (const result of comp.results) {
    try {
      const [user, entry] = await Promise.all([
        user_model.findById(result.user_id).select('competition subscriptions').lean(),
        competition_entry_model.findById(result.entry_id).select('thumbnail_url total_votes').lean(),
      ]);
      if (!user) continue;

      const category = comp.categories.find((c) => c.id === result.category_id);
      const categoryLabel = category?.label ?? 'the competition';
      const voteCount = entry?.total_votes ?? result.votes;
      const voteSummary = `${voteCount} ${voteCount === 1 ? 'vote' : 'votes'}`;

      const item = result.granted_items.find((id) => !id.startsWith('title.'));
      const reward = item
        ? (() => {
            const grant = describeGrant(item);
            return `${grant.emoji} ${grant.label}`;
          })()
        : undefined;

      const wantsPush = (user as any).competition?.notifications !== false;
      const [inAppClaimed, pushClaimed] = await Promise.all([
        claimSlot(result.user_id, comp.week_key, 'win_in_app'),
        wantsPush ? claimSlot(result.user_id, comp.week_key, 'win') : Promise.resolve(false),
      ]);
      if (!inAppClaimed && !pushClaimed) continue;

      await dispatchNotification({
        recipient_id: result.user_id.toString(),
        type: 'competition',
        target_type: 'system',
        target_preview: {
          thumbnail: entry?.thumbnail_url,
          text: comp.theme,
        },
        payload: {
          kind: 'win',
          title: `You won ${categoryLabel}`,
          body: reward
            ? `Your entry received ${voteSummary}. ${reward} is yours.`
            : `Your entry received ${voteSummary}. See your winning drawing.`,
          competition_id: comp._id.toString(),
          week_key: comp.week_key,
          category_id: result.category_id,
          category_label: categoryLabel,
          granted_items: result.granted_items,
          vote_count: voteCount,
        },
        channels: {
          in_app: inAppClaimed,
          socket: inAppClaimed,
          push: pushClaimed
            ? competitionWinPushNotification(categoryLabel, reward, comp._id.toString(), voteCount)
            : false,
        },
      });
    } catch (error) {
      // One failed notification must not stop the others, and must never fail
      // the announcement that already granted the rewards.
      console.error(`[competition] winner notify failed for ${result.user_id}:`, error);
    }
  }
}

// ─── SUBMISSIONS CLOSED ──────────────────────────────────────────────────────

/**
 * "Your entry is in the running" — the moment the drawing stops being editable
 * and starts being judged.
 *
 * In-app only, and deliberately outside `PUSH_SLOTS`: this is a state change
 * the entrant cares about but nobody should be interrupted for, and it must not
 * eat one of the three weekly push allowances. Everyone who entered gets it —
 * no engagement suppression, because entering IS the engagement.
 */
async function notifySubmissionsClosedInApp(comp: CompetitionDocument): Promise<void> {
  // The entrant set is frozen the moment submissions close, so one pass is the
  // whole job. Claim the competition first: without this the driver would walk
  // every entrant on every tick for the rest of the voting window, only to have
  // the per-user ledger reject each one.
  const claimed = await competition_model.updateOne(
    { _id: comp._id, submissions_closed_notified_at: { $exists: false } },
    { $set: { submissions_closed_notified_at: new Date() } }
  );
  if (!claimed.modifiedCount) return;

  const entries = await competition_entry_model
    .find({ competition_id: comp._id, status: 'active' })
    .select('user_id thumbnail_url')
    .lean();

  for (const entry of entries) {
    try {
      if (!(await claimSlot(entry.user_id, comp.week_key, 'submissions_closed_in_app'))) continue;

      await dispatchNotification({
        recipient_id: entry.user_id.toString(),
        type: 'competition',
        target_type: 'system',
        target_preview: {
          thumbnail: entry.thumbnail_url,
          text: comp.theme,
        },
        payload: {
          kind: 'submissions_closed',
          title: 'Submissions are closed',
          body: 'Your entry is now up for votes. Results are on the way.',
          competition_id: comp._id.toString(),
          week_key: comp.week_key,
          ends_at: comp.ends_at.toISOString(),
        },
        channels: { in_app: true, socket: true },
      });
    } catch (error) {
      console.error(`[competition] submissions-closed notify failed for ${entry.user_id}:`, error);
    }
  }
}

/**
 * Persist a bell notification for every non-winning participant immediately.
 * Push remains local-evening scheduled; the in-app row is non-interruptive and
 * should be waiting whenever the user next opens the app.
 */
async function notifyParticipantsInApp(comp: CompetitionDocument): Promise<void> {
  const [entrants, voters] = await Promise.all([
    competition_entry_model.distinct('user_id', { competition_id: comp._id }),
    competition_vote_model.distinct('voter_id', { competition_id: comp._id }),
  ]);
  const winners = new Set(comp.results.map((result) => result.user_id.toString()));
  const participants = new Map<string, Types.ObjectId>();
  for (const id of [...entrants, ...voters] as Types.ObjectId[]) participants.set(id.toString(), id);
  const participantEntries = await competition_entry_model
    .find({ competition_id: comp._id, user_id: { $in: entrants }, status: 'active' })
    .select('user_id thumbnail_url total_votes')
    .lean();
  const entryByUser = new Map(participantEntries.map((entry) => [entry.user_id.toString(), entry]));

  for (const [id, userId] of participants) {
    if (winners.has(id)) continue;
    try {
      if (!(await claimSlot(userId, comp.week_key, 'results_in_app'))) continue;
      const entry = entryByUser.get(id);
      const voteCount = entry?.total_votes;
      await dispatchNotification({
        recipient_id: id,
        type: 'competition',
        target_type: 'system',
        target_preview: {
          thumbnail: entry?.thumbnail_url,
          text: voteCount === undefined ? `Results are in — ${comp.theme}` : comp.theme,
        },
        payload: {
          kind: 'results',
          title: 'Competition results',
          body:
            voteCount === undefined
              ? `See the winners of ${comp.theme}.`
              : `Your entry received ${voteCount} ${voteCount === 1 ? 'vote' : 'votes'}. See the winners.`,
          competition_id: comp._id.toString(),
          week_key: comp.week_key,
          ...(voteCount === undefined ? {} : { vote_count: voteCount }),
        },
        channels: { in_app: true, socket: true },
      });
    } catch (error) {
      console.error(`[competition] participant notify failed for ${id}:`, error);
    }
  }
}

/** Idempotent across announce retries and hourly recovery runs. */
export async function notifyCompetitionResults(comp: CompetitionDocument): Promise<void> {
  await Promise.all([notifyWinners(comp), notifyParticipantsInApp(comp)]);
  await competition_model.updateOne(
    { _id: comp._id, results_notified_at: { $exists: false } },
    { $set: { results_notified_at: new Date() } }
  );
}

// ─── DRIVER ──────────────────────────────────────────────────────────────────

/**
 * Called every hour alongside the phase advancer. Works out which slot (if any)
 * is due for the current competition and sends it to whoever is at the matching
 * local hour right now.
 */
export async function runCompetitionNotifications(now: Date = new Date()): Promise<void> {
  try {
    const recentCutoff = new Date(now.getTime() - 48 * HOUR_MS);
    // Recover an announcement whose process stopped after saving results but
    // before dispatching. Per-user ledger claims keep this retry duplicate-free.
    const missingInApp = await competition_model
      .findOne({
        phase: 'announced',
        announced_at: { $gte: recentCutoff },
        results_notified_at: { $exists: false },
      })
      .sort({ announced_at: -1 });
    if (missingInApp) await notifyCompetitionResults(missingInApp);

    // Results remain eligible after Monday's new competition appears. This is
    // essential for Asia/Oceania, where Sunday 18:00 UTC is already Monday and
    // their preferred local-evening delivery occurs after the rollover.
    const announced = await competition_model
      .findOne({ phase: 'announced', announced_at: { $gte: recentCutoff, $lte: now } })
      .sort({ announced_at: -1 });
    if (announced) {
      const sent = await sendResultsSlot(announced, now);
      if (sent) console.log(`[competition] results push → ${sent} users`);
    }

    const live = await competition_model
      .findOne({ starts_at: { $lte: now }, ends_at: { $gt: now } })
      .sort({ starts_at: -1 });
    if (!live) return;

    // Submissions have stopped but voting has not. Entrants get one bell row
    // telling them their drawing is now being judged. Ledger-claimed, so the
    // hourly re-entry into this branch sends nothing on later ticks.
    if (phaseFor(live, now) === 'voting') {
      await notifySubmissionsClosedInApp(live);
      return;
    }

    if (phaseFor(live, now) !== 'open') return;

    const themeSent = await sendThemeSlot(live, now);
    if (themeSent) console.log(`[competition] theme push → ${themeSent} users`);

    const lastCallSent = await sendLastCallSlot(live, now);
    if (lastCallSent) console.log(`[competition] last call push → ${lastCallSent} users`);
  } catch (error) {
    console.error('[competition] notification run failed:', error);
  }
}
