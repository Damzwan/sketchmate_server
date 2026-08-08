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
  /** Offset from starts_at at which submissions stop (votes continue): Friday. */
  submissions_close_ms: 4 * DAY,
};

/** Shortened cycle used by the dev routes. A full week in six minutes. */
export const TEST_CYCLE = {
  duration_ms: 6 * MINUTE,
  submissions_close_ms: 4 * MINUTE,
};

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
  sunset: { from: '#FF9A6C', to: '#FFD36E', ink: '#7A3412', emoji: '🌅' },
  ocean: { from: '#5EC8F2', to: '#9BE7D2', ink: '#0B4A63', emoji: '🌊' },
  forest: { from: '#7FC98B', to: '#D6EFA4', ink: '#1F4A2B', emoji: '🌿' },
  candy: { from: '#FF8FC1', to: '#FFC6E5', ink: '#7A1348', emoji: '🍬' },
  midnight: { from: '#6C7BFF', to: '#B79BFF', ink: '#221A5C', emoji: '🌙' },
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
 * clearly is not reporting them (old build, tracking broken). Scoring falls
 * back to raw vote counts rather than ranking on noise.
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
