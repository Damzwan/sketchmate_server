// ─── WEEKLY COMPETITION CONFIG ───────────────────────────────────────────────
// Single source of truth for the competition cycle. Pure data + pure functions:
// no imports, no side effects, no DB. The client keeps a verbatim copy at
// sketchmate/src/config/competition.config.ts — same contract as
// moderation.policy.ts. If you change something here, change it there too.
//
// See docs/COMPETITION.md in the client repo.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

export type CompetitionPhase = 'scheduled' | 'open' | 'voting' | 'closed' | 'announced';

export interface CompetitionCategory {
  id: string;
  label: string;
  emoji: string;
  /** How many votes one user may cast in THIS category. */
  votes_per_user: number;
  /** Catalog item ids granted to first place. Snapshotted per competition. */
  reward_items: string[];
}

/**
 * The cycle is expressed as durations, never as "Monday". Every phase decision
 * is `now` vs the timestamps stored on the document — which is what lets a dev
 * run a whole week in six minutes against the real cron path. Do not reintroduce
 * calendar maths into the phase logic.
 */
export const CYCLE = {
  /**
   * 6d 18h, not a full week: a competition that opens Monday 00:00 UTC closes
   * Sunday 18:00 UTC, and that is when winners are announced.
   *
   * Announcing at the Monday rollover would land the moment in the middle of
   * the night for most of the user base and it would be found hours later as a
   * stale notification. Sunday evening is when people are in the app. The
   * ~6-hour gap before the next competition opens is deliberate: for that
   * window the results are the only competition content in the app.
   */
  duration_ms: 6 * DAY + 18 * HOUR,
  /**
   * Offset from starts_at at which submissions stop and the voting-only phase
   * begins: Saturday 18:00 UTC, exactly ONE day before `ends_at`.
   *
   * It used to be Friday 00:00, i.e. 2d 18h of voting-only. Nearly three days
   * with nothing left to draw is dead air on the one surface that is supposed
   * to be the week's event — people stop opening it, and an entry finished on
   * Thursday sits unseen longer than it was worked on. Voting stays open for
   * the whole competition (`canVote` covers `open` too), so shrinking this
   * window takes nothing away from voters; it only moves the submission
   * deadline later, which is the direction that costs no entries.
   */
  submissions_close_ms: 5 * DAY + 18 * HOUR,
  /**
   * How long after `ends_at` the finished competition stays the one the app
   * shows. This is the results moment, and it is the whole point of the week —
   * it must outrank whatever opens next.
   *
   * For the real cycle it is exactly the Sunday-18:00 → Monday-00:00 gap, so
   * nothing changes in production. It is stored per competition because a
   * compressed test cycle overlaps the live weekly one, and without an explicit
   * hold the app snaps to the real competition the instant the test ends.
   */
  results_grace_ms: 6 * HOUR,
};

/** Shortened cycle used by the dev routes. A full week in six minutes. */
export const TEST_CYCLE = {
  duration_ms: 6 * MINUTE,
  /** Same shape as the real cycle: the last sixth is voting-only. */
  submissions_close_ms: 5 * MINUTE,
  /** Long enough to actually look at the winners moment before iterating. */
  results_grace_ms: 3 * MINUTE,
};

/**
 * Never pin the app to something that finished ages ago. Bounds the "ended but
 * not announced yet" hold so a competition the scorer somehow never reached
 * cannot hide every future week forever.
 */
export const RESULTS_LOOKBACK_MS = 2 * DAY;

/**
 * How long a competition that has ended but is not yet `announced` stays in
 * front while it waits to be scored.
 *
 * Two hourly ticks. Past that, scoring is not late — it is failing — and
 * holding the app on a week that will never produce a podium is worse than
 * moving on to the one that is actually running.
 */
export const SCORING_HOLD_MS = 2 * HOUR;

export const DEFAULT_CATEGORIES: CompetitionCategory[] = [
  {
    id: 'overall',
    label: 'Best Overall',
    emoji: '🏆',
    votes_per_user: 3,
    reward_items: [],
  },
  {
    id: 'funniest',
    label: 'Funniest',
    emoji: '😂',
    votes_per_user: 2,
    reward_items: [],
  },
  {
    id: 'most_creative',
    label: 'Most Creative',
    emoji: '💡',
    votes_per_user: 2,
    reward_items: [],
  },
];

// ─── ACCENTS ─────────────────────────────────────────────────────────────────
// One accent per week, read by every competition surface: home card, the
// SendHub section, the page header, the winners modal. Never hardcode a
// competition colour in a component.
export interface CompetitionAccent {
  from: string;
  to: string;
  ink: string;
  emoji: string;
}

export const COMPETITION_ACCENTS: Record<string, CompetitionAccent> = {
  sunset: { from: '#FF9A6C', to: '#FFD36E', ink: '#5F290E', emoji: '🌅' },
  ocean: { from: '#5EC8F2', to: '#9BE7D2', ink: '#0B4A63', emoji: '🌊' },
  forest: { from: '#7FC98B', to: '#D6EFA4', ink: '#1F4A2B', emoji: '🌿' },
  candy: { from: '#FF8FC1', to: '#FFC6E5', ink: '#6B113F', emoji: '🍬' },
  midnight: { from: '#6C7BFF', to: '#B79BFF', ink: '#0C091F', emoji: '🌙' },
  lavender: { from: '#B9A7FF', to: '#E2D8FF', ink: '#3D286F', emoji: '💜' },
  mint: { from: '#62D8B5', to: '#BDF1D2', ink: '#0C4C3A', emoji: '🍃' },
  coral: { from: '#FF7F8D', to: '#FFC0AA', ink: '#571722', emoji: '🪸' },
  citrus: { from: '#FFD15C', to: '#FFF0A6', ink: '#604400', emoji: '🍋' },
  berry: { from: '#C768E8', to: '#F2A5D0', ink: '#280C30', emoji: '🫐' },
  aurora: { from: '#58D5C7', to: '#A79BFF', ink: '#133242', emoji: '✨' },
  lagoon: { from: '#35C7CB', to: '#91E3DD', ink: '#054146', emoji: '🐚' },
  rose: { from: '#F59AB2', to: '#FAD1DC', ink: '#67263C', emoji: '🌹' },
  sky: { from: '#69B8FF', to: '#C1E5FF', ink: '#123F69', emoji: '☁️' },
  peach: { from: '#FFAA83', to: '#FFE0BC', ink: '#69351E', emoji: '🍑' },
};

export const ACCENT_KEYS = Object.keys(COMPETITION_ACCENTS);

export const resolveAccent = (key?: string): CompetitionAccent =>
  COMPETITION_ACCENTS[key ?? ''] ?? COMPETITION_ACCENTS.sunset;

// ─── FALLBACK THEMES ─────────────────────────────────────────────────────────
// Consumed in order when the approved user-suggestion pool is empty, so a week
// never fails to start because nobody looked at the moderation queue.
export interface ThemeSeed {
  text: string;
  blurb: string;
  accent: string;
}

export const FALLBACK_THEMES: ThemeSeed[] = [
  { text: 'Your pet as a superhero', blurb: 'Cape optional. Attitude required.', accent: 'sunset' },
  { text: 'A city under the sea', blurb: 'Who lives there? What do they eat?', accent: 'ocean' },
  { text: 'The worst possible robot', blurb: 'It has one job. It is bad at it.', accent: 'midnight' },
  { text: 'Breakfast, but enormous', blurb: 'Scale is the whole joke.', accent: 'candy' },
  { text: 'A forest that is clearly hiding something', blurb: 'Draw the something. Or don’t.', accent: 'forest' },
  {
    text: 'Your favourite song as a picture',
    blurb: 'No lyrics. No band names. Just the feeling.',
    accent: 'midnight',
  },
  { text: 'A very small dragon', blurb: 'Pocket-sized menace.', accent: 'forest' },
  { text: 'The last day of summer', blurb: 'Warm, and a bit sad.', accent: 'sunset' },
];

// ─── RULES ───────────────────────────────────────────────────────────────────

/**
 * Accounts younger than this cannot vote. The cheapest brigade is a handful of
 * throwaway accounts; a small floor kills most of it and costs a legitimate new
 * user nothing (they can still enter and browse).
 */
export const VOTE_MIN_ACCOUNT_AGE_MS = 48 * HOUR;

/** Below this, we skip the announcement rather than crown a 1-person podium. */
export const MIN_ENTRIES_TO_ANNOUNCE = 3;

// ─── FAIRNESS (§2.7) ─────────────────────────────────────────────────────────
// Raw vote counts measure exposure × quality, which hands the win to whoever
// submitted on Monday. Two mechanisms fix that: rank on vote RATE, and balance
// the exposure so the rate is measured on a comparable sample.

/**
 * Entries are ordered by exposure bucket first, so under-seen artwork goes to
 * the front of everyone's grid until it catches up. Bucket width is a trade:
 * narrow means aggressive catch-up but an order that churns as counts tick,
 * wide means slower balancing.
 */
export const EXPOSURE_BUCKET = 10;

/**
 * An entry needs at least this many impressions to be eligible to win. The
 * Wilson bound already discounts thin samples; this closes the "submit at
 * 23:50, get five taps from a group chat" hole outright rather than
 * statistically.
 */
export const MIN_IMPRESSIONS_TO_WIN = 25;

/**
 * Below this many total impressions across the whole competition, the client
 * clearly is not reporting them (old build, tracking broken). Scoring then
 * REFUSES to crown anyone and records `skipped_reason` — it deliberately does
 * not fall back to raw vote counts, because that would hand the week to
 * whoever entered first, which is the exact failure §2.7 exists to prevent.
 *
 * Note this counts DISTINCT viewers per entry, not page loads: the impression
 * ledger claims one per (entry, viewer), so this floor is "100 people looked at
 * something this week", not "100 renders happened".
 */
export const MIN_TOTAL_IMPRESSIONS_FOR_RATE = 100;

/** 95% confidence. */
const WILSON_Z = 1.96;

/**
 * Wilson score lower bound — "the vote rate we can be confident this entry is
 * at least as good as".
 *
 * Converges on the true rate as impressions grow and stays pessimistic when the
 * sample is thin, which is exactly what a late entry needs: not punished for
 * being late, but unable to win off five friends.
 */
export function wilsonLowerBound(votes: number, impressions: number): number {
  if (impressions <= 0 || votes <= 0) return 0;

  const n = Math.max(impressions, votes); // votes can't exceed impressions
  const p = votes / n;
  const z2 = WILSON_Z * WILSON_Z;

  const numerator = p + z2 / (2 * n) - WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  return Math.max(0, numerator / (1 + z2 / n));
}

export const MAX_CAPTION_LENGTH = 100;
export const MAX_THEME_LENGTH = 60;

/** Earned on a FIRST win only; later wins just increment `competition.wins`. */
export const CHAMPION_TITLE_ITEM = 'title.champion';

/** Entries page size. */
export const ENTRIES_PAGE_SIZE = 24;

/** Kill switch — flip off and /current returns null, the home card renders nothing. */
export const isCompetitionEnabled = (): boolean => process.env.COMPETITION_ENABLED !== '0';

// ─── WEEK KEYS ───────────────────────────────────────────────────────────────

/** Monday 00:00 UTC of the ISO week containing `date`. */
export function startOfIsoWeekUtc(date: Date = new Date()): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  // getUTCDay: 0 = Sunday. Shift so Monday is 0.
  const shift = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d;
}

/** Monday 00:00 UTC immediately following the ISO week containing `date`. */
export function startOfNextIsoWeekUtc(date: Date = new Date()): Date {
  return new Date(startOfIsoWeekUtc(date).getTime() + WEEK);
}

/**
 * Optional one-time public launch boundary.
 *
 * Set `COMPETITION_LAUNCH_AT` to an ISO timestamp. Non-Monday values are
 * intentionally rounded forward to the next Monday 00:00 UTC, making a Friday
 * deploy safe by construction. Test competitions are not gated by this value.
 */
export function competitionLaunchAt(): Date | null {
  const raw = process.env.COMPETITION_LAUNCH_AT;
  if (!raw) return null;
  const requested = new Date(raw);
  if (Number.isNaN(requested.getTime())) return null;

  const containingMonday = startOfIsoWeekUtc(requested);
  return requested.getTime() === containingMonday.getTime()
    ? requested
    : startOfNextIsoWeekUtc(requested);
}

/** ISO-8601 week key, e.g. "2026-W33". Unique per real week; the idempotency key. */
export function weekKeyFor(date: Date = new Date()): string {
  const monday = startOfIsoWeekUtc(date);
  // The ISO year is the year of the Thursday in that week.
  const thursday = new Date(monday);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();

  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstMonday = startOfIsoWeekUtc(firstThursday);
  const week = Math.round((monday.getTime() - firstMonday.getTime()) / (7 * DAY)) + 1;

  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** Test competitions get their own key namespace so they can never collide. */
export const testWeekKey = (now: Date = new Date()): string => `test-${now.getTime()}`;

export const isTestWeekKey = (key: string): boolean => key.startsWith('test-');

// ─── PHASE RESOLUTION ────────────────────────────────────────────────────────

export interface PhaseWindow {
  starts_at: Date | string;
  submissions_close_at: Date | string;
  ends_at: Date | string;
}

const ms = (v: Date | string): number => new Date(v).getTime();

/**
 * The phase a competition SHOULD be in at `now`, from timestamps alone.
 *
 * Note this never returns `announced` — crossing `ends_at` yields `closed`, and
 * only `announceCompetition()` (after scoring, moderation re-check and reward
 * granting) promotes `closed → announced`. That gap is deliberate: nothing is
 * ever shown from a document that might still be scoring.
 */
export function phaseFor(window: PhaseWindow, now: Date = new Date()): CompetitionPhase {
  const t = now.getTime();
  if (t < ms(window.starts_at)) return 'scheduled';
  if (t < ms(window.submissions_close_at)) return 'open';
  if (t < ms(window.ends_at)) return 'voting';
  return 'closed';
}

export const canSubmit = (w: PhaseWindow, now = new Date()): boolean => phaseFor(w, now) === 'open';

export const canVote = (w: PhaseWindow, now = new Date()): boolean => {
  const p = phaseFor(w, now);
  return p === 'open' || p === 'voting';
};
