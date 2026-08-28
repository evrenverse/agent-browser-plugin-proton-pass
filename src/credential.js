/** Orchestrates one credential.resolve request end to end. */
import { runPassCliJson } from './pass-cli.js';
import { matchItems, registrableDomain } from './resolver.js';
import { buildReason } from './reason.js';

/**
 * Bind a value to its flag as `--flag=value`.
 *
 * Every identifier in this module comes from the vault, and a base64url id may
 * begin with `-`. Passed as a separate argument, `pass-cli`'s parser reads it as
 * a short flag and the call dies with `error: unexpected argument '-r' found` —
 * a message that names nothing the caller did and points at nothing they can
 * fix. Measured 2026-08-26 against a real vault whose `share_id` began `-re6…`:
 * every resolve in that vault failed, and a differently-issued token for the
 * same vault would have worked, because a share id is minted per token. So this
 * is a lottery roughly one token in sixty-four loses, and it fails obscurely.
 *
 * The `=` form is what pass-cli itself suggests no alternative to: its tip
 * proposes `-- -r`, and `--share-id -- <value>` answers `a value is required`.
 *
 * @param {string} flag
 * @param {string} value
 * @returns {string}
 */
const bind = (flag, value) => `${flag}=${value}`;

/**
 * Refuse to hand an item's secret to a site the item was not stored for.
 *
 * The request's `url` decides where agent-browser types the value — it navigates
 * to whatever the credential carries and fills the form it lands on — and that
 * URL is the one part of the request an agent composes freely. Naming a real
 * item and pointing `--url` at somewhere else is therefore a way to have a vault
 * password typed into a page of the agent's choosing, without the value ever
 * passing through the agent. The item's own `urls` are the vault's record of
 * where the password belongs, so they are what the destination is checked
 * against.
 *
 * Compared by registrable domain, not by host: `login.example.com` and
 * `www.example.com` are the same site, and a stored URL is usually the root
 * while the login page is a subdomain or a path.
 *
 * Deliberately silent in three cases, none of which can be bound to anything:
 * the item stores no URL (the documented flow where `--url` is all there is),
 * the request carries none (agent-browser sends `url: null` and the item's own
 * URL is returned), or neither URL parses.
 *
 * ponytail: `registrableDomain` is the naive last-two-labels rule, so under a
 * multi-part suffix (`a.co.uk` vs `b.co.uk`) both sides reduce to `co.uk` and
 * the check passes where it should not. It never rejects a legitimate login,
 * only fails to reject an illegitimate one. Swap in the public suffix list if
 * that gap ever needs closing.
 *
 * @param {string|null|undefined} requestUrl the request's `url`, set only by `--url`
 * @param {unknown} itemUrls the item's stored `urls`
 */
function assertSameSite(requestUrl, itemUrls) {
  const target = requestUrl ? registrableDomain(requestUrl) : null;
  if (!target || !Array.isArray(itemUrls)) return;
  const stored = itemUrls
    .map((url) => (typeof url === 'string' ? registrableDomain(url) : null))
    .filter((domain) => domain !== null);
  if (stored.length === 0 || stored.includes(target)) return;
  throw new Error(
    `This login targets ${target}, but the Proton Pass item is stored for ${[...new Set(stored)].join(', ')}. ` +
      'Refusing to hand its password to a site it was not saved for. Pass --url with a page on the ' +
      "item's own site, or add this site to the item in Proton Pass."
  );
}

/**
 * `url` arrives as `null` rather than absent whenever the login did not pass
 * `--url` — that is what agent-browser 0.34.0 sends, and it is the common case.
 *
 * @param {{profileName?: string, itemRef?: string, url?: string|null}} request
 * @param {{bin?: string, env?: Record<string,string>}} [options]
 * @returns {Promise<{username?: string, password?: string, totp?: string, url?: string}>}
 */
export async function resolveCredential(request, options = {}) {
  // The request crossed a process boundary, so every field is whatever the other
  // side wrote. A number where a string belongs used to reach the agent as
  // `(request.itemRef ?? "").trim is not a function` — a JavaScript backtrace
  // where the protocol promises a sentence naming the fix. Anything that is not
  // a string is read as absent, a shape every path below already handles.
  const text = (/** @type {unknown} */ value) => (typeof value === 'string' ? value : undefined);
  const url = text(request.url) ?? null;
  const call = { bin: options.bin, env: options.env, reason: buildReason({ ...request, url }) };
  const ref = (text(request.itemRef) ?? '').trim();

  // A pass:// URI already names the item exactly — skip discovery entirely.
  if (ref.startsWith('pass://')) {
    // Share ids are per session, not per vault: the same vault carries one id in
    // the human's own session and a different one under each agent token. A URI
    // copied out of a human `pass-cli` therefore names a share this session
    // cannot see, and Proton refuses it with a bare status code — measured
    // 2026-08-27 as `Invalid status code: 422 Unprocessable Entity`, which names
    // neither the cause nor the fix. Only this branch can make that diagnosis,
    // because only here does a share id come from the caller rather than from a
    // `vault list` this session made itself.
    const viewed = await runPassCliJson(['item', 'view', ref, '--output', 'json'], call).catch((error) => {
      if (!/\b422\b/.test(error.message)) throw error;
      throw new Error(
        `Proton Pass refused the share in ${ref}. Share ids differ per session, so a pass:// reference taken ` +
          'from a human login does not resolve under an agent token. Get this session\'s id from ' +
          '`pass-cli item list <vault> --output json`, or pass the item title instead — titles are the same for everyone.'
      );
    });
    return toCredential(viewed, ['item', 'totp', ref], call, url);
  }

  const vaults = (await runPassCliJson(['vault', 'list', '--output', 'json'], call))?.vaults ?? [];
  if (vaults.length === 0) {
    throw new Error('No Proton Pass vault is reachable. Grant the agent a vault with: pass-cli agent access grant');
  }

  // A "Vault/Title" reference narrows the search; a bare title searches everywhere.
  const [maybeVault, maybeTitle] = ref.split('/');
  const scoped = maybeTitle ? vaults.filter((v) => (v.name ?? '').toLowerCase() === maybeVault.toLowerCase()) : vaults;
  // Only strip the vault prefix when it actually named a vault. Otherwise the
  // whole reference is the title: "Automation/" would search by URL alone across
  // every vault, and a title that legitimately contains a slash ("AWS/Prod")
  // would be looked up by its suffix.
  const itemRef = scoped.length > 0 && maybeTitle ? maybeTitle : ref;

  const items = [];
  for (const vault of scoped.length > 0 ? scoped : vaults) {
    const listed = await runPassCliJson(
      ['item', 'list', bind('--share-id', vault.share_id), '--filter-type', 'login',
       '--filter-state', 'active', '--output', 'json'],
      call
    );
    items.push(...(listed?.items ?? []));
  }

  const { matched, candidates } = matchItems(items, { itemRef, url });
  if (!matched) {
    const list = candidates.length > 0 ? candidates.join(', ') : 'none';
    throw new Error(
      `Could not identify a single Proton Pass item for "${itemRef || url || ''}". ` +
        `Available logins: ${list}. Pass --item with an exact title, ` +
        'or "Vault/Title" when the same title exists in more than one vault.'
    );
  }

  // One view call returns the whole item: one audit entry instead of one per field.
  const viewed = await runPassCliJson(
    ['item', 'view', bind('--share-id', matched.share_id), bind('--item-id', matched.id), '--output', 'json'],
    call
  );
  return toCredential(
    viewed,
    ['item', 'totp', bind('--share-id', matched.share_id), bind('--item-id', matched.id)],
    call,
    url
  );
}

/**
 * Shape a viewed item into the protocol's credential object, fetching a TOTP code
 * only when the item actually carries one.
 *
 * @param {any} viewed - parsed output of `item view --output json`
 * @param {string[]} totpArgs - pass-cli arguments that would fetch the code
 * @param {{bin?: string, env?: Record<string,string>, reason?: string}} call
 * @param {string|null} [requestUrl] - the request's `url`, set only by `--url`
 * @returns {Promise<{username?: string, password?: string, totp?: string, url?: string}>}
 */
async function toCredential(viewed, totpArgs, call, requestUrl) {
  // `ItemContent` is a plain Rust enum, so serde emits it externally tagged:
  // {"Login": {...}} with a capital L. Accept the lowercase spelling too rather
  // than break if Proton ever adds #[serde(rename_all)].
  const content = viewed?.item?.content?.content ?? {};
  const login = content.Login ?? content.login ?? {};

  /** @type {{username?: string, password?: string, totp?: string, url?: string}} */
  const credential = {};

  // A login item carries both `username` and `email`; whichever the human filled
  // in is the one the site expects, and `username` is the more specific of the two.
  const identifier = login.username || login.email;
  if (identifier) credential.username = identifier;
  if (login.password) credential.password = login.password;
  // The request's URL wins over the item's. Observed against agent-browser
  // 0.34.0: it navigates to whatever `url` comes back and then resolves again,
  // so returning the item's stored root (https://www.gmx.net/) would steer the
  // browser off the login page (/login) and cost a second audit entry.
  // Echoing the request's URL back keeps it where it is — but the request only
  // carries one when the login passed `--url`; otherwise agent-browser sends
  // `url: null` and the item's URL is all there is. That fallback also matters
  // because agent-browser rejects a credential carrying no URL at all, with
  // "Credential has no URL". Hence the documented flow passes `--url`.
  const itemUrl = Array.isArray(login.urls) ? login.urls[0] : undefined;
  // Before the credential is shaped, not after: the destination is checked while
  // there is still no object to hand back. Placed here rather than beside the
  // matcher because a `pass://` reference skips matching altogether and must be
  // bound just the same.
  assertSameSite(requestUrl, login.urls);
  if (requestUrl || itemUrl) credential.url = requestUrl || itemUrl;

  // Every field of the protocol's credential object is optional, so a shape we
  // failed to parse would sail through as an empty object and agent-browser
  // would type an empty password into the form. Fail loudly instead: a silent
  // wrong answer is the worst outcome this plugin can produce.
  if (!credential.password) {
    throw new Error(
      'Found the Proton Pass item but no password in it. Either the item is not a login, ' +
        'or pass-cli changed its JSON shape — run `pass-cli item view <item> --output json` and compare.'
    );
  }

  // Only ask for a code when the item carries a TOTP secret; the extra audit
  // entry is wanted, a spurious failure is not.
  if (login.totp_uri) {
    const answered = (await runPassCliJson([...totpArgs, '--output', 'json'], call))?.totp;
    // Measured against pass-cli 2.3.2 on a real login with 2FA (2026-08-20):
    // `item totp --output json` answers {"totp": "<six digits>", "totp_uri":
    // "<the same six digits>"} — the code arrives as a plain string. The {code:
    // …} object is the shape this line used to read and no measured version has
    // ever produced it; it stays as a defensive branch, not as documented
    // behaviour. `totp_uri` is deliberately not a third candidate despite
    // carrying the same digits here: `item view` uses that field name for a real
    // otpauth:// URI, so reading it as a code would type a URI into a 2FA field
    // the day the shape drifts back.
    const code = typeof answered === 'string' ? answered : answered?.code;
    // The item declared a TOTP secret and pass-cli answered without failing, so a
    // code that cannot be read out of that answer is schema drift — the same
    // fault the password check above throws for, and with the same consequence:
    // this branch dropped every real code from the day it was written until
    // 2026-08-20, resolving a credential agent-browser then filled in with an
    // empty 2FA field and no error on any stream. The spec's "a missing TOTP is
    // not an error" governs an item *without* a secret, which never reaches this
    // line at all. The answer itself is never quoted into the message: it is the
    // one place a code could reach the agent's transcript.
    //
    // What counts as a code is checked, not assumed. A bare `typeof === 'string'`
    // admits `"otpauth://totp/…?secret=…"` — which agent-browser would type into
    // the page, putting the TOTP *shared secret* on screen and into anything that
    // captures it. That is the hazard `totp_uri` is refused for, and the
    // measurement that opened this branch showed `totp` and `totp_uri` carrying
    // the same value, so the pair is demonstrably unstable in pass-cli: the guard
    // belongs on both fields, not one. Whitespace goes the same way — a padded
    // code is a shape that changed, and a field of spaces is not a code.
    //
    // Deliberately *not* a digits-only rule: Proton serving a Steam-style
    // alphanumeric code would then break a working login. What stays refused is a
    // JSON number, since `90694` cannot be told from `090694` once the leading
    // zero is gone.
    if (typeof code !== 'string' || code === '' || code.trim() !== code || code.includes('://')) {
      throw new Error(
        'Found the Proton Pass item and its TOTP secret, but no code in what pass-cli answered — ' +
          'pass-cli changed its JSON shape. Run `pass-cli item totp <item> --output json` and compare.'
      );
    }
    credential.totp = code;
  }

  return credential;
}
