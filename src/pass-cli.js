/** The only module that spawns pass-cli. */
import { execFile } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { clamp } from './reason.js';

const DEFAULT_BIN = process.env.PASS_CLI_BIN || 'pass-cli';

/**
 * Marks the failure where pass-cli cannot decrypt its own local database.
 * `doctor` keys on this rather than matching pass-cli's text a second time.
 */
export const LOCAL_KEY_FAILURE = 'local-key-unreachable';

/**
 * Marks a failure to authenticate that a fresh login would fix — the session is
 * gone, or was never made, while the token behind it is not.
 *
 * Two states, measured, both keyed on here because the remedy is the same three
 * commands and Proton's own instruction covers them together ("If any command
 * fails with authentication error: run `pass-cli logout --force`, re-run the
 * login, verify, retry"):
 *
 *   A  `failed to authenticate: non-existent session` — the session died under
 *      a token that still had five days to run (measured 2026-08-18).
 *   B  `This operation requires an authenticated client`, with `there is no
 *      session` beside it — after a clean `logout --force`, on a machine where
 *      the env file was sourced but `pass-cli login` never run, or in the window
 *      inside `setup` between writing that file and logging in.
 *
 * What is *not* keyed on here: the undecryptable local database, which returns
 * above with its own kind, because no login can reach a key this process cannot
 * see. And what deliberately does not live here at all is the exception for
 * `setup`'s `info` probe, whose failure is an answer rather than a fault — that
 * is `options.probe`, set at the call site that needs it. Narrowing the matcher
 * to encode one caller's policy would have left this string doing a job it
 * cannot be read as doing, and every other caller unhealed.
 */
const DEAD_SESSION = 'authentication-failed';

/**
 * Prefix on the audit reason of every audited call that follows a
 * re-authentication, so `pass-cli agent monitor` shows not just the read but
 * that the session behind it had just been rebuilt.
 *
 * A prefix rather than a suffix because the reason is clamped to pass-cli's
 * 300-character cap and this is the part that must survive truncation: a
 * silently healed session is recoverable from nowhere, while everything else in
 * the reason can be read off the login command that produced it.
 *
 * ponytail: what the clamp then cuts is the tail, and for a reason built by
 * `buildReason` the tail is the `(host)` suffix that `reason.js` goes out of its
 * way to protect — so on a reason already at the cap the marker is bought with
 * the host. The marker costs 19 characters, so a reason of 281 or fewer keeps
 * everything, which every reason from a plausible profile name is. Reserve those
 * characters inside `buildReason` if a long-profile-name deployment ever makes
 * it real.
 */
const REAUTHENTICATED = '[re-authenticated]';

/**
 * Call-options objects that have already spent their one re-authentication —
 * *attempted*, not achieved. Added to before the attempt, so one dead session
 * buys one recovery whether or not it works.
 *
 * The scope is deliberate: `credential.js` builds one options object and makes
 * up to four calls through it, `doctor.js` one and three. Keyed on that object,
 * a dead session costs one `logout --force` per flow rather than one per call.
 * A `WeakSet` rather than a field on the object so nothing of this leaks into
 * the shape callers pass in, and rather than module state so two flows in one
 * process — or two tests — cannot latch each other.
 */
const recoveryAttempted = new WeakSet();

/**
 * Call-options objects whose session was actually rebuilt: added to only after
 * the re-login resolves.
 *
 * Separate from the set above because the two are not the same claim, and the
 * one place that read the attempt as an achievement said so in a report a human
 * acts on — `doctor` announced a rebuilt session after a `logout --force` that
 * destroyed the local state and a `login` that then failed. Everything that
 * *claims* a session was rebuilt reads this set; only the spend latch reads the
 * other.
 */
const sessionRebuilt = new WeakSet();

/**
 * Whether the calls made through these options had to re-authenticate.
 *
 * `doctor` is the one caller whose recovery leaves no trace anywhere else: it
 * files no audit reason and none of its three calls is audited, so the
 * `[re-authenticated]` marker cannot carry the news. It asks here instead, and
 * prints a line. Read-only, and the set itself stays private.
 *
 * Answers for a session that was *rebuilt*, never for one that was merely
 * attempted: a failed recovery leaves less than it found, and a report that
 * called that a repair would send a human looking in the wrong place.
 *
 * @param {object} options the same object the calls were made with
 * @returns {boolean}
 */
export const didReauthenticate = (options) => sessionRebuilt.has(options);

/**
 * Tag a failure as one a fresh login would fix. The message is not reworded:
 * with no token to log back in with it is still the sentence a human reads.
 *
 * @param {Error} error
 */
const dead = (error) => Object.assign(error, { kind: DEAD_SESSION });

/**
 * Pick the line of a pass-cli failure that a human can act on.
 *
 * pass-cli 2.3.2 writes three kinds of line to stderr, in this order: timestamped
 * `ERROR CORE …` tracing from its SQLite layer, one `Error: <summary>` line, and a
 * `Caused by:` chain that runs from the generic wrapper down to the concrete
 * cause — numbered when there are several causes, a single indented line when
 * there is one. The tracing lines come first and say the least, so relaying the
 * first non-empty line degrades to `hmac check failed for pgno=1` exactly when the
 * chain below it names the real problem. The summary above the chain is no better:
 * `Error: Error creating client features` is what both shapes announce themselves
 * with.
 *
 * A Rust panic is the other shape, and since Rust 1.73 it puts the file position
 * on the first line and the message on the second:
 *
 *     thread 'main' panicked at src/main.rs:12:5:
 *     the message that matters
 *     note: run with `RUST_BACKTRACE=1` for a backtrace
 *
 * so neither the first line nor the last is the one to relay.
 *
 * @param {string} stderr already stripped of ANSI escape sequences
 * @returns {string}
 */
function actionableLine(stderr) {
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  // Only the run of numbered entries directly under `Caused by:`. With
  // RUST_BACKTRACE set in the caller's environment — which the plugin passes to
  // the child untouched — backtrace frames read `N: symbol` too, and a mangled
  // symbol name explains nothing.
  //
  // ponytail: the run ends at the first line carrying no number, so an entry
  // whose message wrapped onto an indented continuation line would be cut off
  // there and the continuation dropped. No measured pass-cli output wraps, and
  // the alternative — reading to the end of the block — is what lets a backtrace
  // frame win. Append a non-numbered line to the entry above it if one ever does.
  const causedBy = lines.indexOf('Caused by:');
  const after = causedBy === -1 ? [] : lines.slice(causedBy + 1);
  const end = after.findIndex((line) => !/^\d+: /.test(line));
  const numbered = (end === -1 ? after : after.slice(0, end)).map((line) => line.replace(/^\d+: /, ''));
  // A lone cause is printed unnumbered — an invalid PROTON_PASS_KEY_PROVIDER is
  // answered exactly that way — so with no numbered run to prefer, the first line
  // under the header is the cause.
  const chain = numbered.length > 0 ? numbered : after.slice(0, 1);
  const summary = lines.find((line) => line.startsWith('Error: '))?.slice('Error: '.length);
  // A timestamped tracing line and a panic header both say less than the line
  // below them. Last resort is still the first line, whatever it is: a single
  // tracing line is then the only thing pass-cli said.
  const noise = (line) => /^\d{4}-\d{2}-\d{2}[ T]/.test(line) || /panicked at .+:$/.test(line);
  // The longest chain entry, not the deepest: a chain ends on filler
  // (`4: Error code 0: not an error`), and the entry carrying the most text is
  // the one that carries the cause.
  return (
    chain.sort((a, b) => b.length - a.length)[0] ??
    summary ??
    lines.find((line) => !noise(line)) ??
    lines[0] ??
    ''
  );
}

/**
 * Turn a pass-cli failure into a sentence that names the fix.
 * @param {import('node:child_process').ExecFileException & {stderr?: string}} error
 */
function describe(error) {
  if (error.code === 'ENOENT') {
    return new Error(
      'pass-cli was not found. Install it from https://proton.me/download/pass-cli/install.sh ' +
        'or set PASS_CLI_BIN to its path.'
    );
  }
  // pass-cli colours its stderr even when it is not a TTY (observed with 2.3.2
  // redirected to a file), and the fallback branch below relays that text into
  // the protocol `error` the agent reads. Strip the escape sequences once, here,
  // so neither the matching nor the relayed detail ever sees them.
  const plainStderr = stripVTControlCharacters(error.stderr ?? '');
  const stderr = plainStderr.toLowerCase();
  // Before the session branches, not after: a token that has expired answers
  // `This operation requires an authenticated client` as well, and read in the
  // other order that is a dead session — a diagnosis whose remedy, sourcing the
  // env file again, does nothing for an expired token.
  // `token` as well as `expired`, and not `expired` alone: pass-cli relays
  // failures from everything underneath it, and things other than an agent token
  // expire. Measured against a TLS chain ending in `the server certificate
  // expired on …`, the bare substring answered `pass-cli agent renew` — a remedy
  // for a token that was never the problem, and one that also suppresses the
  // re-authentication below, since this branch does not mark the failure as a
  // dead session. Which word pass-cli uses for a real token expiry is still
  // unmeasured (no token has been let expire against this plugin), so the match
  // stays loose about wording and only insists that a token is what the failure
  // is about.
  if (stderr.includes('expired') && stderr.includes('token')) {
    return new Error(
      'The Proton Pass agent token has expired. Ask a human to run: pass-cli agent renew <name> --expiration 1h'
    );
  }
  if (stderr.includes('there is no session') || stderr.includes('requires an authenticated')) {
    return dead(new Error('Not logged in to Proton Pass. Ask a human to run: pass-cli login'));
  }
  if (stderr.includes('agent_reason') || stderr.includes('proton_pass_agent_reason')) {
    return new Error('Proton Pass requires an audit reason for this operation, and none was supplied.');
  }
  // pass-cli fetches its database key on every start, and its default provider is
  // a keyring. A key put in one login session's keyring may be out of reach from
  // another — measured on Linux with the kernel keyring — so an agent under a
  // daemon generates a fresh key and can no longer decrypt the database. "Usually"
  // is doing real work in the sentence below: the same error covers a genuinely
  // corrupt database, and a caller that already runs with PROTON_PASS_KEY_PROVIDER=fs
  // reads this too. `logout --force` is the fix either way. The match is on
  // pass-cli's durable wording, not on the timestamped tracing lines above it,
  // which carry a version-specific format and no fix.
  // The other half of the same fault, and the destructive one. Measured
  // 2026-08-24: called against a session directory whose key it could not
  // reach, `pass-cli agent create` answered `Local encryption key not found but
  // local data exists. Forcing logout for security.` and destroyed that
  // session. It is not a failure to read — it is a logout that already
  // happened, so the message says so rather than naming a repair for state that
  // is gone. Kept above the relay because `Forcing logout for security` would
  // otherwise be relayed verbatim as though pass-cli had merely complained.
  if (stderr.includes('local encryption key not found') || stderr.includes('forcing logout for security')) {
    return Object.assign(
      new Error(
        'pass-cli could not reach the key for the local database and logged out the session in the directory ' +
          'this call used, to protect data it could no longer decrypt. Which session that was depends on ' +
          'PROTON_PASS_SESSION_DIR as this call saw it, so check before re-authenticating anything: run ' +
          'pass-cli info in your own shell. A human session in the default directory is often untouched, and ' +
          'a needless logout --force costs a web login for nothing. The cause is a key in a keyring the calling ' +
          'process cannot read: on Linux with no D-Bus Secret Service, pass-cli falls back to kernel keyutils, ' +
          'whose keys vanish with the session that made them. Set PROTON_PASS_KEY_PROVIDER=fs so the key is a ' +
          '0600 file beside the database, and log in again only where pass-cli info says you are logged out. ' +
          'No vault data is lost — the local database is only a cache.'
      ),
      { kind: LOCAL_KEY_FAILURE }
    );
  }
  if (stderr.includes('failed to open encrypted database') || stderr.includes('encryption key may not match')) {
    return Object.assign(
      new Error(
        'pass-cli cannot decrypt its local database — usually because its key lives in a keyring tied to the login ' +
          'session that created it, and a process in another session gets a fresh key instead. Give the agent state ' +
          'of its own: export PROTON_PASS_SESSION_DIR=<a directory for the agent> and PROTON_PASS_KEY_PROVIDER=fs, ' +
          'then run pass-cli logout --force (in that same shell) and log in again.'
      ),
      { kind: LOCAL_KEY_FAILURE }
    );
  }
  // `relayed` marks this branch as the one carrying pass-cli's own words rather
  // than a sentence of ours naming a fix. The recovery below reads it to decide
  // whether a failed re-login has anything to say that the caller's original
  // failure does not.
  const fallback = Object.assign(
    new Error(`pass-cli failed: ${actionableLine(plainStderr || error.message || '')}`),
    { relayed: true }
  );
  return stderr.includes('non-existent session') ? dead(fallback) : fallback;
}

/**
 * The child environment a call runs in — built once here so that what the
 * recovery below inspects and what pass-cli actually receives cannot differ.
 *
 * An `undefined` value in `options.env` *removes* that variable rather than
 * emptying it, since Node skips undefined values when it builds the child's
 * environment. `setup` needs that to reach the human's own session from a shell
 * that already exports the agent's.
 *
 * @param {{env?: Record<string,string|undefined>}} options
 * @returns {Record<string,string|undefined>}
 */
const childEnv = (options) => ({ ...process.env, ...(options.env ?? {}) });

/**
 * Spawn pass-cli once. The whole of the adapter, and no policy: everything
 * below calls this, so nothing can re-enter the recovery through it.
 *
 * The reason is placed in the child environment. It must never become an
 * argument: argv is world-readable through /proc on Linux. An agent token
 * travels the same way.
 *
 * @param {string[]} args
 * @param {{bin?: string, reason?: string, env?: Record<string,string|undefined>, probe?: boolean}} options
 * @returns {Promise<string>}
 */
function spawnPassCli(args, options) {
  const env = childEnv(options);
  // A reason the caller already set wins as the text — theirs, not ours — but the
  // marker applies to whichever of the two is used. It is not part of the reason;
  // it is the only record that the session behind this call was rebuilt, and an
  // operator who supplies their own string must not lose it by doing so.
  const reason = env.PROTON_PASS_AGENT_REASON || options.reason;
  if (reason) {
    env.PROTON_PASS_AGENT_REASON = sessionRebuilt.has(options) ? clamp(`${REAUTHENTICATED} ${reason}`) : reason;
  }
  return new Promise((resolve, reject) => {
    execFile(
      options.bin ?? DEFAULT_BIN,
      args,
      { env, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
      (error, stdout, stderr) => (error ? reject(describe(Object.assign(error, { stderr }))) : resolve(stdout))
    );
  });
}

/**
 * Give the agent's session back to itself, once, so a failure nobody is awake
 * to read does not end the night's work.
 *
 * A session can die while the token that made it is still valid — measured with
 * five days of a `1w` token left, when every call began answering `failed to
 * authenticate: non-existent session` and these three commands brought it
 * straight back. Proton prescribes exactly them, under "Auto-recovery from
 * logout" in the agent instructions `pass-cli agent create` prints beside the
 * token.
 *
 * Two conditions, both required, both read from the environment the failed call
 * actually ran in. The **token** is what a new login can be made from; without
 * one there is nothing to do and the original error stands. The **session
 * directory** is what makes `logout --force` — which destroys a session and does
 * not ask — provably the agent's own: unset, pass-cli uses its default
 * directory, which is the human's. That is the same guarantee `setup` gives its
 * own `logout --force`, and it holds for the calls `setup` makes in the human's
 * session too, since clearing both variables there leaves them undefined here.
 *
 * @param {any} error the failure as `describe` classified it
 * @param {{bin?: string, reason?: string, env?: Record<string,string|undefined>, probe?: boolean}} options
 * @returns {Promise<boolean>} whether the caller may retry
 */
async function reauthenticate(error, options) {
  // A probe's failure is its answer, not a fault: `setup` asks `info` whether
  // the agent's directory already holds a session and reads the error as "no".
  // Healing there would answer its own question wrong and would run
  // `logout --force` against the session `setup` is about to replace anyway.
  // The exclusion sits here rather than in the matcher so that it is visible at
  // the call site that needs it, and so that no future probe inherits recovery
  // it never asked for.
  if (options.probe) return false;
  if (error?.kind !== DEAD_SESSION || recoveryAttempted.has(options)) return false;
  const env = childEnv(options);
  if (!env.PROTON_PASS_PERSONAL_ACCESS_TOKEN || !env.PROTON_PASS_SESSION_DIR) return false;
  // Marked before the attempt: one dead session buys one recovery whether or not
  // it works. What it does *not* buy is the claim that a session now exists —
  // that is `sessionRebuilt`, set below once the login has actually resolved.
  recoveryAttempted.add(options);
  const session = { bin: options.bin, env: options.env };
  try {
    await spawnPassCli(['logout', '--force'], session);
    await spawnPassCli(['login'], session);
    sessionRebuilt.add(options);
    return true;
  } catch (failure) {
    // The re-login is the only thing that can tell an expired token from a dead
    // session, and it has just run that experiment. When `describe` could name a
    // fix — an expired token above all — that answer is the actionable one and
    // is thrown in place of the original: still one failure, and the useful one.
    // A `pass-cli failed: …` relay is not: it repeats pass-cli's words about a
    // session that no longer exists and names nothing to do about it, so the
    // caller keeps the failure its own call produced.
    if (!failure.relayed) throw failure;
    return false;
  }
}

/**
 * Run pass-cli and return raw stdout, re-authenticating once if the session
 * turns out to be gone.
 *
 * `options.probe` opts a call out of that: set it where a failure is the answer
 * being looked for rather than something to repair.
 *
 * @param {string[]} args
 * @param {{bin?: string, reason?: string, env?: Record<string,string|undefined>, probe?: boolean}} [options]
 * @returns {Promise<string>}
 */
export async function runPassCli(args, options = {}) {
  try {
    return await spawnPassCli(args, options);
  } catch (error) {
    if (!(await reauthenticate(error, options))) throw error;
    try {
      // Straight at the spawn: one retry, and no path from here back into the
      // recovery, whatever this fails with.
      return await spawnPassCli(args, options);
    } catch {
      // The original, not this one. The caller asked one question and gets one
      // answer rather than the two-step story behind it.
      throw error;
    }
  }
}

/**
 * Run pass-cli and parse its JSON output.
 * @param {string[]} args
 * @param {{bin?: string, reason?: string, env?: Record<string,string|undefined>, probe?: boolean}} [options]
 * @returns {Promise<any>}
 */
export async function runPassCliJson(args, options = {}) {
  const stdout = await runPassCli(args, options);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('pass-cli returned output that was not valid JSON.');
  }
}
