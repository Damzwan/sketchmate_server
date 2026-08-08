import mongoose, { Document, Schema, Types } from 'mongoose';
import { CompetitionPhase } from '../config/competition.config';

const { ObjectId } = Schema.Types;

// ─── COMPETITIONS ────────────────────────────────────────────────────────────

export interface CompetitionResult {
  category_id: string;
  entry_id: Types.ObjectId;
  user_id: Types.ObjectId;
  votes: number;
  /** What was ACTUALLY granted — the audit trail, not what the catalog says now. */
  granted_items: string[];
}

export interface CompetitionDocument extends Document {
  _id: Types.ObjectId;
  week_key: string;
  theme: string;
  theme_blurb?: string;
  theme_source_id?: Types.ObjectId;
  accent: string;

  starts_at: Date;
  submissions_close_at: Date;
  ends_at: Date;

  phase: CompetitionPhase;

  categories: {
    id: string;
    label: string;
    emoji: string;
    votes_per_user: number;
    reward_items: string[];
  }[];

  entry_count: number;
  voter_count: number;

  results: CompetitionResult[];
  announced_at?: Date;
  results_notified_at?: Date;
  /** Set when a cycle ended with too few entries to crown anyone. */
  skipped_reason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    emoji: { type: String, default: '🏆' },
    votes_per_user: { type: Number, required: true, min: 1, max: 20 },
    reward_items: { type: [String], default: [] },
  },
  { _id: false }
);

const resultSchema = new Schema(
  {
    category_id: { type: String, required: true },
    entry_id: { type: ObjectId, ref: 'competition_entries', required: true },
    user_id: { type: ObjectId, ref: 'users', required: true },
    votes: { type: Number, default: 0 },
    granted_items: { type: [String], default: [] },
  },
  { _id: false }
);

const competitionSchema = new Schema<CompetitionDocument>(
  {
    // The idempotency key. Unique, so "make sure this week exists" is safe to call
    // from any number of cron ticks or dynos.
    week_key: { type: String, required: true, unique: true },

    theme: { type: String, required: true },
    theme_blurb: { type: String },
    theme_source_id: { type: ObjectId, ref: 'competition_themes' },
    accent: { type: String, default: 'sunset' },

    starts_at: { type: Date, required: true },
    submissions_close_at: { type: Date, required: true },
    ends_at: { type: Date, required: true },

    phase: {
      type: String,
      enum: ['scheduled', 'open', 'voting', 'closed', 'announced'],
      default: 'scheduled',
    },

    categories: { type: [categorySchema], default: [] },

    // Denormalised for the home card, which is polled far more often than
    // anything else here. Corrected by the scoring pass.
    entry_count: { type: Number, default: 0 },
    voter_count: { type: Number, default: 0 },

    results: { type: [resultSchema], default: [] },
    announced_at: { type: Date },
    results_notified_at: { type: Date },
    skipped_reason: { type: String },
  },
  { timestamps: true }
);

// The advancer's read: "anything that isn't finished yet".
competitionSchema.index({ phase: 1, ends_at: 1 });
// Archive: announced weeks, newest first.
competitionSchema.index({ phase: 1, announced_at: -1 });
competitionSchema.index({ phase: 1, starts_at: -1 });

export const competition_model = mongoose.model<CompetitionDocument>('competitions', competitionSchema);

// ─── ENTRIES ─────────────────────────────────────────────────────────────────

export interface CompetitionEntryDocument extends Document {
  _id: Types.ObjectId;
  competition_id: Types.ObjectId;
  user_id: Types.ObjectId;

  drawing_url: string;
  image_url: string;
  thumbnail_url: string;
  aspect_ratio: number;
  caption?: string;
  caption_filtered?: string;

  post_id?: Types.ObjectId;

  vote_counts: Map<string, number>;
  total_votes: number;
  impressions: number;
  comment_count: number;

  is_winner: boolean;
  won_category?: string;

  status: 'active' | 'under_review' | 'removed' | 'withdrawn';
  reports_count: number;
  moderation: {
    quarantined_at?: Date;
    removed_at?: Date;
    last_report_at?: Date;
    last_report_reason?: string;
  };

  submitted_at: Date;
  createdAt: Date;
  updatedAt: Date;
}

const entryModerationSchema = new Schema(
  {
    quarantined_at: { type: Date },
    removed_at: { type: Date },
    last_report_at: { type: Date },
    last_report_reason: { type: String },
  },
  { _id: false }
);

const entrySchema = new Schema<CompetitionEntryDocument>(
  {
    competition_id: { type: ObjectId, ref: 'competitions', required: true },
    user_id: { type: ObjectId, ref: 'users', required: true },

    drawing_url: { type: String, required: true },
    image_url: { type: String, required: true },
    thumbnail_url: { type: String, required: true },
    aspect_ratio: { type: Number, required: true },
    caption: { type: String },
    // Censored twin — see services/profanity.service, same as post comments.
    caption_filtered: { type: String },

    // Set when the artist also chose to publish this drawing to the public feed.
    // Nullable and settable later; nothing ever back-fills it automatically.
    post_id: { type: ObjectId, ref: 'posts' },

    // Display convenience only. Scoring always recounts from competition_votes.
    vote_counts: { type: Map, of: Number, default: {} },
    total_votes: { type: Number, default: 0 },

    // Exposure — how many times this entry was actually on someone's screen for
    // more than 1.5s. Load-bearing for scoring, not analytics: ranking is
    // votes/impressions, so an entry submitted on Friday is judged on its rate
    // rather than punished for having had fewer days on screen. See §2.7.
    impressions: { type: Number, default: 0 },

    // Stored separately like post comments. The denormalised count lets list
    // cards show conversation activity without hydrating every thread.
    comment_count: { type: Number, default: 0 },

    // Denormalised at announce time so a winner badge costs no join per card.
    is_winner: { type: Boolean, default: false },
    won_category: { type: String },

    status: {
      type: String,
      enum: ['active', 'under_review', 'removed', 'withdrawn'],
      default: 'active',
    },
    reports_count: { type: Number, default: 0 },
    moderation: { type: entryModerationSchema, default: () => ({}) },

    submitted_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One entry per user per competition (§2.4). Enforcement, not convention.
entrySchema.index({ competition_id: 1, user_id: 1 }, { unique: true });
entrySchema.index({ competition_id: 1, status: 1, submitted_at: -1 });
// Exposure-balanced read: under-seen entries first.
entrySchema.index({ competition_id: 1, status: 1, impressions: 1 });
entrySchema.index({ user_id: 1, submitted_at: -1 });
entrySchema.index({ status: 1, 'moderation.quarantined_at': 1 });

export const competition_entry_model = mongoose.model<CompetitionEntryDocument>('competition_entries', entrySchema);

// ─── ENTRY COMMENTS ─────────────────────────────────────────────────────────

export interface CompetitionCommentDocument extends Document {
  _id: Types.ObjectId;
  entry_id: Types.ObjectId;
  author_id: Types.ObjectId;
  message: string;
  message_filtered?: string;
  status: 'active' | 'under_review' | 'removed';
  reports_count: number;
  createdAt: Date;
  updatedAt: Date;
}

const competitionCommentSchema = new Schema<CompetitionCommentDocument>(
  {
    entry_id: { type: ObjectId, ref: 'competition_entries', required: true },
    author_id: { type: ObjectId, ref: 'users', required: true },
    message: { type: String, required: true, maxlength: 500 },
    message_filtered: { type: String },
    status: {
      type: String,
      enum: ['active', 'under_review', 'removed'],
      default: 'active',
    },
    reports_count: { type: Number, default: 0 },
  },
  { timestamps: true }
);

competitionCommentSchema.index({ entry_id: 1, createdAt: -1 });
competitionCommentSchema.index({ status: 1, createdAt: -1 });

export const competition_comment_model = mongoose.model<CompetitionCommentDocument>(
  'competition_comments',
  competitionCommentSchema
);

// ─── VOTES ───────────────────────────────────────────────────────────────────

export interface CompetitionVoteDocument extends Document {
  _id: Types.ObjectId;
  competition_id: Types.ObjectId;
  entry_id: Types.ObjectId;
  voter_id: Types.ObjectId;
  category_id: string;
  slot?: string;
  createdAt: Date;
}

const voteSchema = new Schema<CompetitionVoteDocument>(
  {
    competition_id: { type: ObjectId, ref: 'competitions', required: true },
    entry_id: { type: ObjectId, ref: 'competition_entries', required: true },
    voter_id: { type: ObjectId, ref: 'users', required: true },
    category_id: { type: String, required: true },
    slot: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The route enforces one category per drawing and lazily collapses votes created
// by older clients. Keep the category in this legacy-safe unique key until all
// deployed databases have been deduplicated and can accept the stricter index.
voteSchema.index({ competition_id: 1, voter_id: 1, entry_id: 1, category_id: 1 }, { unique: true });
// New votes occupy one deterministic slot per drawing. Legacy rows have no
// slot and are excluded, so this can be deployed before lazy deduplication has
// visited every account while still closing the concurrent-tap race for all
// newly written votes.
voteSchema.index(
  { competition_id: 1, voter_id: 1, entry_id: 1, slot: 1 },
  { unique: true, partialFilterExpression: { slot: { $exists: true } } }
);
voteSchema.index({ competition_id: 1, voter_id: 1 });
voteSchema.index({ entry_id: 1, category_id: 1 });

// Votes are kept after the competition closes — they are the audit trail for a
// disputed result and the input for a recount when a winner is removed.
export const competition_vote_model = mongoose.model<CompetitionVoteDocument>('competition_votes', voteSchema);

// ─── THEMES ──────────────────────────────────────────────────────────────────

export interface CompetitionThemeDocument extends Document {
  _id: Types.ObjectId;
  text: string;
  text_filtered?: string;
  blurb?: string;
  accent?: string;
  suggested_by?: Types.ObjectId;
  /** Competition whose community is choosing this for the following round. */
  cycle_competition_id?: Types.ObjectId;
  status: 'pending' | 'approved' | 'rejected' | 'used';
  upvotes: number;
  used_in?: Types.ObjectId;
  rejected_reason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const themeSchema = new Schema<CompetitionThemeDocument>(
  {
    text: { type: String, required: true, maxlength: 60 },
    text_filtered: { type: String },
    blurb: { type: String, maxlength: 120 },
    accent: { type: String },
    // Null = curated by us rather than suggested by a user.
    suggested_by: { type: ObjectId, ref: 'users' },
    cycle_competition_id: { type: ObjectId, ref: 'competitions' },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'used'],
      default: 'pending',
    },
    upvotes: { type: Number, default: 0 },
    used_in: { type: ObjectId, ref: 'competitions' },
    rejected_reason: { type: String },
  },
  { timestamps: true }
);

// The cron's pick: highest-voted approved theme.
themeSchema.index({ status: 1, upvotes: -1, createdAt: 1 });
themeSchema.index({ cycle_competition_id: 1, status: 1, upvotes: -1 });
themeSchema.index({ suggested_by: 1, createdAt: -1 });
themeSchema.index(
  { cycle_competition_id: 1, suggested_by: 1 },
  {
    unique: true,
    partialFilterExpression: {
      cycle_competition_id: { $exists: true },
      suggested_by: { $exists: true },
    },
  }
);

export const competition_theme_model = mongoose.model<CompetitionThemeDocument>('competition_themes', themeSchema);

export interface CompetitionThemeVoteDocument extends Document {
  theme_id: Types.ObjectId;
  user_id: Types.ObjectId;
}

const themeVoteSchema = new Schema<CompetitionThemeVoteDocument>(
  {
    theme_id: { type: ObjectId, ref: 'competition_themes', required: true },
    user_id: { type: ObjectId, ref: 'users', required: true },
  },
  { timestamps: true }
);

themeVoteSchema.index({ theme_id: 1, user_id: 1 }, { unique: true });
themeVoteSchema.index({ user_id: 1 });

export const competition_theme_vote_model = mongoose.model<CompetitionThemeVoteDocument>(
  'competition_theme_votes',
  themeVoteSchema
);

// ─── NOTIFICATION LEDGER ─────────────────────────────────────────────────────

/**
 * One row per (user, week, slot) actually sent.
 *
 * The scheduler runs hourly and picks users whose LOCAL hour matches a slot, so
 * a given user matches once per day — but a clock change, a timezone update
 * mid-week or a double cron tick would each resend. The unique index is what
 * makes "at most once per slot per week" true rather than merely likely, and it
 * doubles as the source for the 3-per-week cap.
 */
export interface CompetitionNotificationDocument extends Document {
  user_id: Types.ObjectId;
  week_key: string;
  slot: 'theme' | 'last_call' | 'results' | 'win' | 'results_in_app' | 'win_in_app';
  createdAt: Date;
}

const notificationLedgerSchema = new Schema<CompetitionNotificationDocument>(
  {
    user_id: { type: ObjectId, ref: 'users', required: true },
    week_key: { type: String, required: true },
    slot: {
      type: String,
      enum: ['theme', 'last_call', 'results', 'win', 'results_in_app', 'win_in_app'],
      required: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificationLedgerSchema.index({ user_id: 1, week_key: 1, slot: 1 }, { unique: true });
// Weekly cap query: "how many have I already sent this user this week".
notificationLedgerSchema.index({ user_id: 1, week_key: 1 });
// Nothing here matters after a few weeks.
notificationLedgerSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const competition_notification_model = mongoose.model<CompetitionNotificationDocument>(
  'competition_notifications',
  notificationLedgerSchema
);
