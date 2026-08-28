#!/usr/bin/env node
/**
 * Stand-in for pass-cli. Behaviour is driven by FAKE_PASS_CLI_MODE so tests can
 * exercise each failure path without a Proton account.
 *
 * The response shapes below are taken from the pass-cli source, not invented:
 *   - `VaultEntry` is {name, vault_id, share_id}  (commands/vault/list.rs:31)
 *   - `ItemSummary` is {id, share_id, title, item_type, …}  (commands/item/list.rs:64)
 *   - `LoginItem` is {email, username, password, urls, totp_uri, passkeys}
 *     (pass-domain/src/models/item/mod.rs:974) — note BOTH `email` and `username`
 *   - `ItemContent` is a plain Rust enum, so serde emits it externally tagged as
 *     {"Login": {…}} with a capital L  (pass-domain/src/models/item/mod.rs:841)
 *
 * Note what those four have that the `totp` mode below did not: a file:line. The
 * TOTP answer was reproduced here as {"totp": {"code": "…"}} with no citation at
 * all — assumed in the plan's Task 5, copied into this fixture, and never checked
 * against the source or entered in the design's "Verified assumptions" table.
 * Measured against pass-cli 2.3.2 on 2026-08-20, on a real login with 2FA, it
 * answers {"totp": "<six digits>", "totp_uri": "<the same six digits>"} — `totp`
 * is the code as a plain string, and `totp_uri` carries those same digits rather
 * than a URI. Recorded as observed, not explained; note that `item view` uses
 * that same field name for a real otpauth:// URI. The `totp` mode below is now
 * the measured shape and `totp-object` keeps the object form, so both parser
 * paths have a caller. Until then the whole suite agreed with the assumed shape
 * and the plugin dropped every real code without an error — which is the argument
 * for the rule the spec now carries: a shape with no citation beside it is an
 * assumption, and it reads exactly like a verified one.
 *
 * Modes:
 *   vaults         -> one vault named "Automation"
 *   vaults-none    -> a well-formed answer granting no vault at all
 *   vaults-dashed  -> a share id beginning with a dash, which base64url allows and
 *                     a real vault produced (measured 2026-08-26)
 *   vaults-many    -> three vaults, so a test can pick a subset of them
 *   agent-create   -> `pass-cli agent create`: a token field and a long prose
 *                     instruction beside it
 *   login          -> `pass-cli login`: plain text, not JSON
 *   logout         -> `pass-cli logout --force`: plain text too
 *   items          -> three login items
 *   item-view      -> a login item with password and TOTP
 *   item-view-notp -> a login item without a TOTP secret
 *   item-view-user -> a login item that uses `username` rather than `email`
 *   item-view-alien-> a well-formed item of an unexpected shape (schema drift)
 *   item-view-nopw -> a Login object that parses but carries no password, and a
 *                     TOTP secret beside the gap: the shape the "no password"
 *                     error must describe without quoting
 *   item-view-urlstr-> the same item with `urls` as a bare string rather than an
 *                     array, which is what the Array.isArray guard is for
 *   not-json-secret-> exits 0 with a secret on stdout and a warning line in front
 *                     of the JSON, so the answer no longer parses. stdout is
 *                     where pass-cli prints values, so nothing of it may reach
 *                     the protocol error
 *   stdout-secret-fail -> exits 1 with a secret on stdout and a relayable failure
 *                     on stderr: the failure path of the same rule
 *   filler-chain-fail -> exits 1 with a `Caused by:` chain whose deepest entry is
 *                     filler and whose longest one is the cause
 *   totp           -> `item totp`: the measured shape, the code as a bare string
 *   totp-object    -> the same call in the {code: …} object form, never measured
 *   totp-alien     -> the same call succeeding with no code the parser will read
 *   totp-empty     -> the same call answering with an empty `totp` string
 *   totp-padded    -> …with the code padded by whitespace
 *   totp-uri-answer-> …with an otpauth:// URI where the code belongs, secret and
 *                     all: the one answer that must never reach the page
 *   no-reason      -> exits 1 the way pass-cli 2.3.2 refuses an item command with
 *                     PROTON_PASS_AGENT_REASON unset (measured 2026-08-20 against
 *                     `item totp`, which enforces it exactly as `item view` does)
 *   null-body      -> valid JSON that is not an object, for the `?.` guards
 *   no-session     -> exits 1, "there is no session"
 *   dead-session   -> exits 1, "failed to authenticate: non-existent session" — the
 *                     session pass-cli 2.3.2 answers with once its own session is
 *                     gone while the agent token is still valid (measured
 *                     2026-08-18, eleven hours into a 1w token)
 *   expired        -> exits 1, an expired agent token: the generic
 *                     "requires an authenticated client" wrapper with the
 *                     expiry as its cause. CONSTRUCTED, not measured — no real
 *                     token has been let expire against this plugin — but the
 *                     wrapper is the line pass-cli answers every unauthenticated
 *                     call with, so an expired token that did not carry it would
 *                     be the surprise. Both strings in one stderr is the point:
 *                     read in the wrong order it classifies as a dead session,
 *                     whose remedy does nothing for an expired token.
 *   expired-token-login -> exits 1 the way `pass-cli login` really answers a token
 *                     that is gone: measured 2026-08-24, and the shape the
 *                     `expired` mode above only guessed at. Note what it does
 *                     NOT carry: `requires an authenticated client`. The
 *                     constructed mode keeps that wrapper because the
 *                     branch-order hazard it exists for is real for an audited
 *                     call under a dead token, which is still unmeasured
 *   forced-logout  -> exits 1 the way pass-cli 2.3.2 answers a command run against
 *                     a session directory whose key it cannot reach: it logs that
 *                     session out and says so. Measured 2026-08-24 against
 *                     `agent create`, and the session really was destroyed — the
 *                     README had claimed this failure was read-only
 *   silent-fail    -> exits 1 with no output on either stream
 *   multiline-fail -> exits 1 with a Rust panic in the post-1.73 layout: file
 *                     position first, message second, backtrace note last
 *   coloured-fail  -> exits 1 with an ANSI-coloured stderr line, as pass-cli 2.3.2
 *                     writes even when stderr is redirected to a file
 *   local-key-fail -> exits 1 with the verbatim stderr of pass-cli 2.3.2 called from
 *                     a login session that cannot reach the key its database was
 *                     encrypted with (measured 2026-08-16)
 *   chain-fail     -> exits 1 with an unrecognised failure in the same shape:
 *                     tracing lines, an `Error:` summary, a `Caused by:` chain,
 *                     and a RUST_BACKTRACE listing whose frames are numbered too
 *   single-cause-fail -> exits 1 the way pass-cli 2.3.2 answers an invalid
 *                     PROTON_PASS_KEY_PROVIDER: one unnumbered cause indented
 *                     under `Caused by:` (measured 2026-08-16)
 *   echo-env       -> prints the reason and argv it received, for reason-passing tests
 *   version        -> plain-text version string, for the doctor's binary check (task 7)
 *   info-token     -> `pass-cli info` as answered by an agent token session (task 7)
 *   info-agent-token -> the same, carrying the `[Agent] ` display-name prefix a
 *                     real agent token shows (measured 2026-08-17)
 *   info-quoted-token -> the same again, with an apostrophe in the agent's name
 *   info-personal  -> `pass-cli info` as answered by a personal login session (task 7)
 *
 * FAKE_PASS_CLI_SEQUENCE points at a state file so successive invocations answer
 * differently, mirroring a real chain: vault list -> item list -> item view -> totp.
 * That file also records every invocation — its argv and the session variables it
 * saw — so a test can assert what pass-cli was really called with: that a secret
 * stayed out of argv, and which of the two sessions a call ran in.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The three variables that decide whose pass-cli state a call reads. `null` means
 * unset, which is what the human's own session looks like: `setup` clears all
 * three before it lists the human's vaults or creates a token.
 */
const sessionEnv = () => ({
  PROTON_PASS_SESSION_DIR: process.env.PROTON_PASS_SESSION_DIR ?? null,
  PROTON_PASS_KEY_PROVIDER: process.env.PROTON_PASS_KEY_PROVIDER ?? null,
  PROTON_PASS_PERSONAL_ACCESS_TOKEN: process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN ?? null,
});

function resolveMode() {
  const sequenceFile = process.env.FAKE_PASS_CLI_SEQUENCE;
  if (!sequenceFile) return process.env.FAKE_PASS_CLI_MODE ?? 'vaults';
  const state = existsSync(sequenceFile)
    ? JSON.parse(readFileSync(sequenceFile, 'utf8'))
    : { modes: [], index: 0 };
  const mode = state.modes[state.index] ?? 'vaults';
  const calls = [...(state.calls ?? []), { mode, argv: process.argv.slice(2), env: sessionEnv() }];
  writeFileSync(sequenceFile, JSON.stringify({ ...state, index: state.index + 1, calls }));
  return mode;
}

const mode = resolveMode();

const loginItem = (title, login) => ({
  item: { id: 'item-1', share_id: 'share-1', content: { title, content: { Login: login } } },
});

const responses = {
  vaults: { vaults: [{ name: 'Automation', vault_id: 'vault-1', share_id: 'share-1' }] },
  // A token granted nothing: the answer is well formed and the list is empty.
  'vaults-none': { vaults: [] },
  // A share id that begins with a dash. Base64url ids can, and a real vault's
  // did on 2026-08-26 — after which every call naming it as a bare argument
  // died in pass-cli's parser.
  'vaults-dashed': { vaults: [{ name: 'Automation', vault_id: 'vault-1', share_id: '-rDASHED' }] },
  // More than one, so a selection can be a real subset and an index can be out of
  // range. The names are invented; a fixture is no place for anyone's real vault.
  'vaults-many': {
    vaults: [
      { name: 'Automation', vault_id: 'vault-1', share_id: 'share-1' },
      { name: 'Team Logins', vault_id: 'vault-2', share_id: 'share-2' },
      { name: 'Archive', vault_id: 'vault-3', share_id: 'share-3' },
    ],
  },
  // `agent create` answers with the token as one field of a JSON object, followed
  // by a long prose instruction — Proton's own, which prescribes the `pass-cli
  // login` that exporting the token alone does not replace. The token has to be
  // parsed out; the whole output is not it.
  'agent-create': {
    token: 'pst_test::key',
    instruction:
      "Give the agent pass-cli state of its own with PROTON_PASS_SESSION_DIR, set PROTON_PASS_KEY_PROVIDER=fs, " +
      'then run PROTON_PASS_PERSONAL_ACCESS_TOKEN="<token>" pass-cli login. Until that login has run, every ' +
      'command answers: This operation requires an authenticated client.',
  },
  items: {
    items: [
      { id: 'item-1', share_id: 'share-1', title: 'GMX', item_type: 'login' },
      { id: 'item-2', share_id: 'share-1', title: 'GitHub', item_type: 'login' },
      { id: 'item-3', share_id: 'share-1', title: 'GMX Business', item_type: 'login' },
      // A title that contains a slash, plus a sibling that shares its suffix, so a
      // "Vault/Title" split of "AWS/Prod" cannot be rescued by suffix matching.
      { id: 'item-4', share_id: 'share-1', title: 'AWS/Prod', item_type: 'login' },
      { id: 'item-5', share_id: 'share-1', title: 'Prod Backup', item_type: 'login' },
    ],
  },
  'item-view': loginItem('GMX', {
    email: 'user@gmx.de',
    username: '',
    password: 'correct-horse-battery',
    urls: ['https://www.gmx.net/'],
    totp_uri: 'otpauth://totp/GMX?secret=ABC',
    passkeys: [],
  }),
  'item-view-notp': loginItem('GitHub', {
    email: '',
    username: 'octocat',
    password: 'hunter2hunter2',
    urls: [],
    totp_uri: '',
    passkeys: [],
  }),
  'item-view-user': loginItem('Portal', {
    email: 'fallback@example.com',
    username: 'preferred-user',
    password: 'swordfish-1234',
    urls: [],
    totp_uri: '',
    passkeys: [],
  }),
  // Schema drift: valid JSON, but not the shape we expect. Must fail loudly.
  'item-view-alien': { item: { content: { title: 'Alien', content: { Note: { text: 'x' } } } } },
  // Drift inside a Login object rather than around it: the password field is
  // gone, and what is left includes a TOTP secret. The error for this shape has
  // to name the problem without quoting the object it found.
  'item-view-nopw': loginItem('GMX', {
    email: 'user@gmx.de',
    username: '',
    secret_value: 'correct-horse-battery',
    urls: ['https://www.gmx.net/'],
    totp_uri: 'otpauth://totp/GMX?secret=ABC',
    passkeys: [],
  }),
  // `urls` as a bare string. Indexing it without the Array.isArray guard yields
  // its first character, and "h" would then be handed to agent-browser as a URL.
  'item-view-urlstr': loginItem('GitHub', {
    email: '',
    username: 'octocat',
    password: 'hunter2hunter2',
    urls: 'https://github.com/login',
    totp_uri: '',
    passkeys: [],
  }),
  // The measured shape: two strings, both carrying the code. The digits are
  // invented — a fixture is no place for anyone's real code either.
  totp: { totp: '123456', totp_uri: '123456' },
  // Never measured from any pass-cli version, and kept only so the parser's
  // defensive branch has a caller.
  'totp-object': { totp: { code: '123456' } },
  // Schema drift on the TOTP call: the call succeeded, the JSON is valid, and no
  // field the parser is willing to read carries a code. `totp_uri` sits right
  // there with six digits in it and is deliberately not a fallback — `item view`
  // uses that same field name for a real otpauth:// URI, so reading it as a code
  // would type a URI into a 2FA field the day the shape drifts back.
  'totp-alien': { totp: { seconds_remaining: 21 }, totp_uri: '123456' },
  // Three answers that are strings and still not codes. The last is the sharp
  // one: `totp` and `totp_uri` were measured carrying the same value, so a
  // pass-cli that put the URI in both would hand agent-browser the TOTP *shared
  // secret* to type into the page. Same URI as `item-view` above, so what the
  // parser must refuse here is exactly what it reads as a URI there.
  'totp-empty': { totp: '', totp_uri: '' },
  'totp-padded': { totp: ' 123456 ', totp_uri: ' 123456 ' },
  'totp-uri-answer': { totp: 'otpauth://totp/GMX?secret=ABC', totp_uri: 'otpauth://totp/GMX?secret=ABC' },
  // `InfoOutput` (commands/info.rs:32). personal_access_token_name is present for
  // token sessions (agent tokens included) and absent for a personal login.
  'info-token': { release_track: 'stable', id: 'x', personal_access_token_name: 'browser-agent', session_has_lock: false },
  // What a real agent token answers: `agent create browser-agent` shows up as the
  // display name `[Agent] browser-agent` (measured against pass-cli 2.3.2), while
  // `agent renew` still wants the bare `browser-agent`.
  'info-agent-token': {
    release_track: 'stable',
    id: 'x',
    personal_access_token_name: '[Agent] browser-agent',
    session_has_lock: false,
  },
  // An apostrophe in the name: the character that ends the shell quoting the hint
  // wraps the name in, if it is not escaped.
  'info-quoted-token': {
    release_track: 'stable',
    id: 'x',
    personal_access_token_name: "[Agent] browser's agent",
    session_has_lock: false,
  },
  'info-personal': { release_track: 'stable', id: 'x', email: 'user@proton.me', session_has_lock: false },
};

if (mode === 'no-session') {
  // Verbatim, measured 2026-08-20 against pass-cli 2.3.2 in a session directory
  // that held no session: `vault list` answered with a coloured, timestamped
  // tracing line naming its own source position, and an `Error:` summary under
  // it. What stood here before was a single uncoloured line, written from
  // reasoning rather than from a run — thinner than the real thing in three ways
  // that all matter to `describe`: it carried no tracing line for the `noise`
  // filter to skip, no `Error:` summary for the relay to prefer, and no escape
  // sequences for the stripping to remove. The plugin classified both correctly,
  // so this changes no behaviour; it stops the fixture from agreeing with an
  // assumption, which is the failure mode the TOTP shape cost a silent wrong
  // answer to learn.
  //
  // Both matching strings are present in one stderr, which is the other thing
  // the old line did not show: `there is no session` and `requires an
  // authenticated client` arrive together, so either branch order classifies
  // this state the same way.
  const esc = '\u001B';
  process.stderr.write(
    `${esc}[2m2026-08-20T17:15:33.750851Z${esc}[0m ${esc}[31mERROR${esc}[0m ` +
      `${esc}[2mpass-cli/src/main.rs${esc}[0m${esc}[2m:${esc}[0m${esc}[2m332:${esc}[0m ` +
      'Command is not logout there is no session\n' +
      'Error: This operation requires an authenticated client\n'
  );
  process.exit(1);
}
if (mode === 'dead-session') {
  // The token outlives the session it created: measured with five days of a 1w
  // token left, when every call in a running agent's session began answering
  // this and `logout --force` + `login` brought it straight back. The line is
  // the whole of pass-cli's stderr — no tracing above it, no `Caused by:` chain
  // below — so the plugin relays it through the `Error: ` summary.
  process.stderr.write('Error: failed to authenticate: non-existent session\n');
  process.exit(1);
}
if (mode === 'expired') {
  process.stderr.write(
    'Error: This operation requires an authenticated client\n' +
      '\n' +
      'Caused by:\n' +
      '    the agent token has expired\n'
  );
  process.exit(1);
}
if (mode === 'no-reason') {
  // Verbatim, and the whole of pass-cli's stderr: no tracing above, no chain
  // below. Measured on 2026-08-20 by running `item totp` with the variable unset
  // — which also settled that `item totp` is audited and gated on the reason,
  // not just `item view`. Until then the string this matches was a guess.
  process.stderr.write(
    'Error: Agent sessions must set the PROTON_PASS_AGENT_REASON environment variable before running item commands.\n'
  );
  process.exit(1);
}
if (mode === 'not-json-secret') {
  // Exit 0, but the answer no longer parses — one warning line in front of the
  // JSON is enough. What matters is that stdout holds the item, password and
  // all: that is where pass-cli prints values, and none of it may be quoted into
  // the sentence the agent reads.
  process.stdout.write(
    'warning: local cache format migrated\n' +
      JSON.stringify(loginItem('GMX', { email: 'user@gmx.de', password: 'correct-horse-battery', urls: [] }))
  );
  process.exit(0);
}
if (mode === 'stdout-secret-fail') {
  // The same rule on the failure path: execFile hands the callback both streams,
  // so a relay that read stdout instead of stderr would carry the item straight
  // into the protocol error.
  process.stdout.write(
    JSON.stringify(loginItem('GMX', { email: 'user@gmx.de', password: 'correct-horse-battery', urls: [] }))
  );
  process.stderr.write('Error: Error creating client features\n\nCaused by:\n    the vault could not be opened\n');
  process.exit(1);
}
if (mode === 'filler-chain-fail') {
  // A chain that ends on filler. pass-cli 2.3.2 writes exactly this shape — the
  // measured local-key failure ends `4: Error code 0: not an error` — so relaying
  // the deepest entry says nothing while the longest one names the cause.
  process.stderr.write(
    'Error: Error creating client features\n' +
      '\n' +
      'Caused by:\n' +
      '    0: Failed to reach the Proton API\n' +
      '    1: Request to https://pass-api.proton.me timed out after 30s\n' +
      '    2: Error code 0: not an error\n'
  );
  process.exit(1);
}
if (mode === 'expired-token-login') {
  // Verbatim, measured 2026-08-24 against pass-cli 2.3.2: an agent token created
  // with --expiration 1h, used four days later. This is the wording no run had
  // ever produced, and the reason the `expired` branch had to stay loose about
  // it. Both words the match needs are here — `expired` and `token` — and the
  // narrowed match answers it with `agent renew` while leaving the failure
  // unmarked, so no re-login is attempted against a token a login cannot fix.
  process.stderr.write(
    'Error: Error in personal access token login flow\n' +
      '\n' +
      'Caused by:\n' +
      '    0: Error creating personal access token session\n' +
      '    1: This personal access token is invalid, expired or has been deleted.\n'
  );
  process.exit(1);
}
if (mode === 'forced-logout') {
  // Verbatim. Note that pass-cli reports the logout on stdout while the error
  // itself goes to stderr, so a relay reading only one stream sees half of it.
  process.stdout.write('Executing force logout\nSuccessfully performed force logout\n');
  process.stderr.write(
    'Error: Local encryption key not found but local data exists. Forcing logout for security.\n' +
      "Run 'pass-cli login' to authenticate again.\n"
  );
  process.exit(1);
}
if (mode === 'foreign-share') {
  // Measured 2026-08-27 against pass-cli 2.3.3: `item view pass://<share>/<item>`
  // under an agent token, with a share id copied out of the human's own session.
  // Share ids are per-session, so the API refuses the share itself — and says so
  // only as a status code, which names neither the cause nor the fix.
  process.stderr.write('Error: Invalid status code: 422 Unprocessable Entity\n');
  process.exit(1);
}
if (mode === 'silent-fail') {
  process.exit(1);
}
if (mode === 'multiline-fail') {
  // A Rust panic in the layout rustc has emitted since 1.73: the file position on
  // the first line, the message on the second, the backtrace note last. Neither
  // the first line nor the last is worth relaying.
  process.stderr.write(
    "thread 'main' panicked at pass-cli/src/commands/item/view.rs:42:9:\n" +
      'called `Option::unwrap()` on a `None` value\n' +
      'note: run with `RUST_BACKTRACE=1` for a backtrace\n'
  );
  process.exit(1);
}
if (mode === 'coloured-fail') {
  // Verbatim shape of `pass-cli vault list --output json` with stderr redirected
  // to a file: dim timestamp, red level, dim source location — all still coloured.
  const esc = '\u001B';
  process.stderr.write(
    `${esc}[2m2026-08-15T21:33:48Z${esc}[0m ${esc}[31mERROR${esc}[0m ${esc}[2mpass-cli/src/main.rs${esc}[0m ` +
      'Vault access was revoked\n'
  );
  process.exit(1);
}
if (mode === 'local-key-fail') {
  // Copied from a real run: an agent under a daemon (audit session 3) calling
  // pass-cli 2.3.2 against a database the human's login session encrypted. The
  // actionable sentence sits in the middle of the chain, three lines of SQLite
  // tracing below the top of the output.
  process.stderr.write(
    '2026-08-16 22:46:30.122: ERROR CORE sqlcipher_page_cipher: hmac check failed for pgno=1\n' +
      '2026-08-16 22:46:30.122: ERROR CORE sqlite3Codec: error decrypting page 1 data: 1\n' +
      '2026-08-16 22:46:30.122: ERROR CORE sqlcipher_codec_ctx_set_error 1\n' +
      'Error: Error creating client features\n' +
      '\n' +
      'Caused by:\n' +
      '    0: Failed to initialize database\n' +
      '    1: Failed to get database connection\n' +
      '    2: Error occurred while creating a new object: Failed to open encrypted database: file is not a ' +
      'database. The encryption key may not match or the database may be corrupted. Try running ' +
      "'pass-cli logout --force' to reset local state.\n" +
      '    3: Failed to open encrypted database: file is not a database. The encryption key may not match or ' +
      "the database may be corrupted. Try running 'pass-cli logout --force' to reset local state.\n" +
      '    4: Error code 0: not an error\n'
  );
  process.exit(1);
}
if (mode === 'chain-fail') {
  // The same output shape for a failure the plugin has no branch for: the fallback
  // must reach the chain rather than relay the tracing line at the top. The
  // backtrace below the chain is what a caller with RUST_BACKTRACE=1 in its
  // environment gets, and its frames are numbered exactly like chain entries —
  // one of them deliberately longer than the cause, so relaying a frame instead
  // of the cause fails this fixture's test.
  process.stderr.write(
    '2026-08-16 22:46:30.122: ERROR CORE http_client: transport shutdown\n' +
      'Error: Error creating client features\n' +
      '\n' +
      'Caused by:\n' +
      '    0: Failed to reach the Proton API\n' +
      '    1: Request to https://pass-api.proton.me timed out after 30s\n' +
      '\n' +
      'Stack backtrace:\n' +
      '   0: anyhow::error::<impl core::convert::From<E> for anyhow::Error>::from::h9f3c1a2b4d5e6f70\n' +
      '   1: pass_cli::features::client::create_client_features::{{closure}}::h0123456789abcdef\n'
  );
  process.exit(1);
}
if (mode === 'single-cause-fail') {
  // Verbatim: pass-cli 2.3.2 with PROTON_PASS_KEY_PROVIDER=file. With one cause
  // the chain is a single indented line and carries no number, and the summary
  // above it is the same generic wrapper every failure of this shape announces.
  process.stderr.write(
    'Error: Error creating client features\n' +
      '\n' +
      'Caused by:\n' +
      "    Invalid PROTON_PASS_KEY_PROVIDER value: 'file'. Valid values are 'fs', 'keyring', or 'env'\n"
  );
  process.exit(1);
}
if (mode === 'echo-env') {
  process.stdout.write(
    JSON.stringify({ reason: process.env.PROTON_PASS_AGENT_REASON ?? null, argv: process.argv.slice(2) })
  );
  process.exit(0);
}
if (mode === 'null-body') {
  // Valid JSON that is not an object: the shape every `?.` guard exists for.
  process.stdout.write('null');
  process.exit(0);
}
if (mode === 'version') {
  // `--version` answers in plain text, not JSON.
  process.stdout.write('Proton Pass CLI 2.3.2 (test)\n');
  process.exit(0);
}
if (mode === 'login') {
  // `login` answers in plain text too, and nothing reads its output.
  process.stdout.write('Logged in.\n');
  process.exit(0);
}
if (mode === 'logout') {
  process.stdout.write('Logged out.\n');
  process.exit(0);
}

process.stdout.write(JSON.stringify(responses[mode] ?? {}));
