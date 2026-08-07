/**
 * PROFANITY FILTER — detection runs here, exactly once, at write time.
 *
 * The filter is a per-user *display* preference, not enforcement: the author's
 * words are never altered in storage. Every piece of user text is scanned once
 * when it is created and, if it matches, a censored twin is stored alongside the
 * original (`content_filtered` / `message_filtered`). Readers with the filter on
 * render the twin; readers with it off render the original.
 *
 * Why write-time and not read-time:
 *   - a message is written once and read many times (history scrollback, the
 *     conversation overview, push previews). Scanning per read would repeat the
 *     same work forever.
 *   - the read path becomes a field pick — zero regex, zero allocation — so the
 *     toggle applies instantly to existing history without a refetch.
 *
 * Clean text stores nothing extra: `censorText` returns null on a miss, and the
 * callers leave the field unset. Only offending messages pay any storage.
 *
 * Matching uses `obscenity` rather than a plain word list: it resolves leetspeak
 * ("sh1t"), confusables, and duplicate-letter padding ("fuuuck"), and it has a
 * whitelist so "class", "assume" and friends don't trip it.
 */
import {
  asteriskCensorStrategy,
  englishDataset,
  englishRecommendedTransformers,
  RegExpMatcher,
  TextCensor
} from 'obscenity';

// Long inputs aren't chat — they're a paste. Scanning them is unbounded work for
// content nobody is going to read as a message anyway.
const MAX_SCAN_LENGTH = 4000;

let matcher: RegExpMatcher | null = null;
let censor: TextCensor | null = null;

/**
 * Built on first use, not at import. The dataset compiles a sizable set of
 * patterns, and most server processes handle a request before they handle their
 * first message — keeping it out of module init keeps cold start off the
 * critical path.
 */
function ensureBuilt() {
  if (matcher && censor) return;
  matcher = new RegExpMatcher({
    ...englishDataset.build(),
    ...englishRecommendedTransformers
  });
  // Fixed asterisks, not the default random grawlix: the censored twin is
  // persisted, so it has to be stable across reads.
  censor = new TextCensor().setStrategy(asteriskCensorStrategy());
}

export function containsProfanity(text: string | null | undefined): boolean {
  if (!text) return false;
  if (text.length > MAX_SCAN_LENGTH) return false;
  ensureBuilt();
  return matcher!.hasMatch(text);
}

/**
 * @return the censored twin, or null when the text is clean (or not worth
 * scanning). Never throws — a filter failure must not fail the write it hangs
 * off, so a broken match degrades to "clean" rather than to a 500.
 */
export function censorText(text: string | null | undefined): string | null {
  if (!text) return null;
  if (text.length > MAX_SCAN_LENGTH) return null;

  try {
    ensureBuilt();
    const matches = matcher!.getAllMatches(text);
    if (!matches.length) return null;
    return censor!.applyTo(text, matches);
  } catch (err) {
    console.error('Profanity censor failed:', err);
    return null;
  }
}

/** Censored text when there is any, the original otherwise. */
export function safeText(text: string | null | undefined): string {
  return censorText(text) ?? text ?? '';
}
