/**
 * Audit reason strings.
 *
 * Every audited pass-cli call carries one of these into the end-to-end-encrypted
 * monitor log, so `pass-cli agent monitor` reads as a history of logins rather
 * than a list of opaque item reads.
 */

// pass-cli caps the reason at 300 characters, counted with Rust's
// `reason.chars().count()` — a Unicode-scalar-value count, not bytes and not
// JS UTF-16 code units. See `pass/src/monitor.rs`
// (`pub const MAX_REASON_LENGTH: usize = 300;`, enforced in both
// `pass/src/monitor.rs` and `pass-cli/src/commands/item/agent_monitor.rs`).
// `[...str]` below iterates code points, matching that comparison.
const MAX_LENGTH = 300;

const PREFIX = 'agent-browser login: ';
const FALLBACK = 'agent-browser credential resolution';

/**
 * Clamp already-built text to MAX_LENGTH code points.
 *
 * Exported because `pass-cli.js` prefixes the reason of an audited call that
 * follows a re-authentication, and the cap is pass-cli's, not this module's —
 * two copies of the number would be one too many.
 *
 * @param {string} text
 * @returns {string}
 */
export function clamp(text) {
  const chars = [...text];
  return chars.length > MAX_LENGTH ? `${chars.slice(0, MAX_LENGTH - 1).join('')}…` : text;
}

/**
 * `url` arrives as `null` rather than absent when the login passed no `--url`,
 * and then the reason simply carries no host.
 *
 * @param {{profileName?: string, url?: string|null}} context
 * @returns {string}
 */
export function buildReason(context) {
  // Type-checked rather than coerced: this runs on a request from another
  // process, and `(context.profileName ?? '').trim()` answered a numeric
  // profileName with a TypeError that went on to become the agent's error
  // message. A non-string is no profile name, so the generic reason is right.
  const profile = typeof context.profileName === 'string' ? context.profileName.trim() : '';
  if (!profile) return FALLBACK;

  let host = '';
  try {
    if (context.url) host = new URL(context.url).hostname;
  } catch {
    host = '';
  }

  if (!host) return clamp(`${PREFIX}${profile}`);

  // The host is the one datum the operator cannot reconstruct from elsewhere,
  // so truncation shortens the profile name, never drops the "(host)" suffix.
  const suffix = ` (${host})`;
  const budget = Math.max(0, MAX_LENGTH - [...PREFIX].length - [...suffix].length);
  const profileChars = [...profile];
  const shortProfile = profileChars.length > budget ? profileChars.slice(0, budget).join('') : profile;

  // Final clamp covers the pathological case where the hostname alone leaves
  // no budget for any profile name at all.
  return clamp(`${PREFIX}${shortProfile}${suffix}`);
}
