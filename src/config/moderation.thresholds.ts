/**
 * Tuning for the abuse-detection layer.
 *
 * WHY THIS FILE EXISTS
 *
 * This repository is public. The mechanics of moderation — that there is a
 * queue, that reports quarantine content, that a nightly sweep looks for
 * outreach patterns — are fine to publish and arguably should be: users are
 * entitled to know how the system that judges them works, and obscurity was
 * never what made it effective.
 *
 * The *numbers* are different. A person trying to contact children on this
 * platform who can read "fires at 5 conversations with a 60% no-reply rate"
 * will open four conversations. Detection thresholds are the one part of this
 * system whose value genuinely depends on not being published.
 *
 * So the shapes live here in the open and the live values do not. The defaults
 * below are deliberately NOT the values this deployment runs — they are
 * plausible, conservative starting points for anyone reading or self-hosting.
 * Production values come from the MODERATION_THRESHOLDS environment variable
 * and exist only in the deployment environment.
 *
 * SETTING IT
 *
 * A JSON object, partial and deep-merged over the defaults. Only override what
 * you mean to change:
 *
 *   MODERATION_THRESHOLDS='{"risk_sweep":{"rules":{"hostile_outreach":{"min_profanity_hits":7}}}}'
 *
 * The loader logs at boot when no override is present, because a production
 * deploy running published defaults is a misconfiguration, not a preference.
 *
 * WHAT DOES NOT BELONG HERE
 *
 * `STRIKE_LADDER` and `POLICY_CONSTANTS` in types/moderation.policy.ts stay
 * public and unmoved. They ship inside the app bundle — any user can unzip the
 * client and read them — so hiding them in this repo would be theatre, and
 * they are the part of the policy users are owed a clear answer about anyway.
 */

export interface ModerationThresholds {
  risk_sweep: {
    /** Hard ceiling on accounts examined per run, so cost stays predictable. */
    max_candidates: number;
    /** Conversations older than this are established relationships, not outreach. */
    outreach_window_days: number;
    /** Sent this many into silence before a conversation counts as one-sided. */
    one_sided_min_sent: number;
    /** At or above this age an account is treated as an adult by the rules. */
    adult_age: number;
    /** Below this age a contact counts toward the minor-contact ratio. */
    minor_age: number;
    /**
     * Rules can be switched off by id without a deploy — useful when one starts
     * producing noise and the queue needs to stay readable while it is retuned.
     */
    disabled_rules: string[];
    rules: {
      mass_unsolicited_contact: {
        min_conversations: number;
        min_one_sided_ratio: number;
      };
      adult_contacting_minors: {
        min_contacts: number;
        min_minor_ratio: number;
      };
      new_account_spraying: {
        max_account_age_days: number;
        min_one_sided_conversations: number;
      };
      hostile_outreach: {
        min_profanity_hits: number;
        min_one_sided_ratio: number;
      };
    };
  };
  auto_quarantine: {
    /**
     * Distinct pieces of a user's content auto-actioned within 24h before the
     * user themselves is raised to the human queue.
     */
    system_flag_threshold: number;
  };
}

/**
 * Published defaults. Conservative on purpose: they fire less than a tuned
 * deployment would, because the failure mode for a stranger running this code
 * should be a quiet queue, not false accusations against real people.
 */
const DEFAULTS: ModerationThresholds = {
  risk_sweep: {
    max_candidates: 5000,
    outreach_window_days: 30,
    one_sided_min_sent: 3,
    adult_age: 18,
    minor_age: 16,
    disabled_rules: [],
    rules: {
      mass_unsolicited_contact: { min_conversations: 10, min_one_sided_ratio: 0.75 },
      adult_contacting_minors: { min_contacts: 5, min_minor_ratio: 0.8 },
      new_account_spraying: { max_account_age_days: 7, min_one_sided_conversations: 5 },
      hostile_outreach: { min_profanity_hits: 10, min_one_sided_ratio: 0.6 }
    }
  },
  auto_quarantine: {
    system_flag_threshold: 5
  }
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges the override over the defaults, key by key.
 *
 * Only keys that already exist in the defaults are copied across. An unknown
 * key is a typo — `min_convrsations` silently doing nothing is exactly the kind
 * of failure that goes unnoticed for months in a system nobody watches closely
 * — so it is dropped loudly rather than carried into the config.
 */
function merge<T>(base: T, override: unknown, path: string, warnings: string[]): T {
  if (!isPlainObject(override)) return base;

  const result: any = Array.isArray(base) ? [...(base as any)] : { ...base };

  for (const [key, value] of Object.entries(override)) {
    const here = path ? `${path}.${key}` : key;

    if (!(key in (base as any))) {
      warnings.push(here);
      continue;
    }

    const current = (base as any)[key];
    result[key] = isPlainObject(current) ? merge(current, value, here, warnings) : value;
  }

  return result as T;
}

let cached: ModerationThresholds | null = null;

/**
 * Resolved thresholds, read once on first use.
 *
 * Lazy rather than resolved at import time on purpose: `dotenv/config` is
 * loaded from main.ts, so a module that read process.env while being imported
 * would depend on import order to see the right values. Everything that calls
 * this runs from a request or a cron tick, long after boot.
 */
export function moderationThresholds(): ModerationThresholds {
  if (cached) return cached;

  const raw = process.env.MODERATION_THRESHOLDS?.trim();

  if (!raw) {
    // Loud rather than silent: production running the published defaults means
    // the detection layer is tuned to numbers that are in a public repository.
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[moderation] MODERATION_THRESHOLDS is not set — running the published ' +
        'default thresholds. These are public and deliberately conservative. ' +
        'Set the variable with this deployment\'s real values.'
      );
    }
    cached = DEFAULTS;
    return cached;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Defaults rather than a crash: a mistyped config var should degrade the
    // sweep to conservative settings, not take the API down with it.
    console.error('[moderation] MODERATION_THRESHOLDS is not valid JSON — using defaults.');
    cached = DEFAULTS;
    return cached;
  }

  const warnings: string[] = [];
  const merged = merge(DEFAULTS, parsed, '', warnings);

  if (warnings.length) {
    console.warn(`[moderation] MODERATION_THRESHOLDS has unknown keys, ignored: ${warnings.join(', ')}`);
  }

  cached = merged;
  return cached;
}
