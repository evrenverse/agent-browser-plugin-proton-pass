/** Environment diagnosis for humans setting the plugin up. */
import { runPassCli, runPassCliJson, LOCAL_KEY_FAILURE, didReauthenticate } from './pass-cli.js';

const SESSION_DIR_HINT = 'and give the agent its own PROTON_PASS_SESSION_DIR.';

const SYMBOL = { ok: '✓', warn: '!', fail: '✗' };

/**
 * The report as the block a human reads — one line per check. `doctor` and
 * `setup` both print it, so the two cannot drift apart.
 *
 * @param {{checks: Array<{name: string, status: 'ok'|'warn'|'fail', detail: string}>}} report
 * @returns {string}
 */
export function formatReport(report) {
  return report.checks.map((check) => `${SYMBOL[check.status]} ${check.name}: ${check.detail}\n`).join('');
}

/**
 * `--expiration` is required and 1h is only the shortest span, not the only one.
 * The alternatives are prose *after* a complete command, never inside it: a hint
 * a human or an agent copies has to stop being shell before it starts being
 * English, or the paste dies on `syntax error near unexpected token`.
 */
const EXPIRATION_VALUES = ' — --expiration also accepts 1d, 1w, 1m, 3m, 6m, 1y';

/**
 * pass-cli is a fresh process on every call, so it fetches its database key each
 * time, and PROTON_PASS_KEY_PROVIDER decides from where. `keyring` — the default —
 * puts that key in the login session's keyring, which another login session may
 * not be able to read: measured on Linux with the kernel keyutils backend, where
 * an agent under a daemon got a fresh key and could then decrypt nothing. How far
 * that generalises was not measured, so the wording stays hedged. `fs` (a 0600
 * file beside the database) and `env` (from PROTON_PASS_ENCRYPTION_KEY) do not
 * depend on a login session at all.
 *
 * @param {string|undefined} provider
 * @param {boolean} failed whether a call above already hit the undecryptable database
 * @returns {{name: string, status: 'ok'|'warn'|'fail', detail: string}}
 */
function keyProviderCheck(provider, failed) {
  const name = 'key provider';
  const effective = provider ?? "keyring (PROTON_PASS_KEY_PROVIDER unset — pass-cli's default)";
  if (failed) {
    return {
      name,
      status: 'fail',
      detail:
        `${effective} — pass-cli could not decrypt its local database above, usually because this process cannot ` +
        "reach the key that encrypted it. Set PROTON_PASS_SESSION_DIR to a directory of the agent's own and " +
        'PROTON_PASS_KEY_PROVIDER=fs, then, in a shell with that PROTON_PASS_SESSION_DIR exported: ' +
        'pass-cli logout --force && pass-cli login',
    };
  }
  if (provider === 'fs') {
    return { name, status: 'ok', detail: 'fs — key in a 0600 file beside the database, independent of any login session' };
  }
  if (provider === 'env') {
    return {
      name,
      status: 'ok',
      detail:
        'env — key from PROTON_PASS_ENCRYPTION_KEY, independent of any login session and never written to disk by ' +
        'pass-cli, though whatever exports it is in practice a file and the value is readable from /proc while the ' +
        'process runs',
    };
  }
  if (provider !== undefined && provider !== 'keyring') {
    return {
      name,
      status: 'warn',
      detail:
        `"${provider}" is not a value pass-cli accepts — it takes fs, keyring or env, spelled exactly so, and ` +
        `rejects anything else on startup. Set PROTON_PASS_KEY_PROVIDER=fs ${SESSION_DIR_HINT}`,
    };
  }
  return {
    name,
    status: 'warn',
    detail:
      `${effective} — a keyring key belongs to the login session that created it and may not be reachable from ` +
      'another (measured on Linux with the kernel keyring), leaving an agent unable to decrypt the database. Set ' +
      `PROTON_PASS_KEY_PROVIDER=fs ${SESSION_DIR_HINT}`,
  };
}

/**
 * @param {{bin?: string, env?: Record<string,string>, processEnv?: Record<string,string|undefined>}} [options]
 * @returns {Promise<{checks: Array<{name: string, status: 'ok'|'warn'|'fail', detail: string}>, ok: boolean}>}
 */
export async function runDoctor(options = {}) {
  const processEnv = options.processEnv ?? process.env;
  const call = { bin: options.bin, env: options.env };
  /** @type {Array<{name: string, status: 'ok'|'warn'|'fail', detail: string}>} */
  const checks = [];
  // Set when a call above already hit the undecryptable database. Evidence beats
  // anything the environment can be asked.
  let localKeyFailed = false;
  /** @param {any} error */
  const noteKeyFailure = (error) => {
    localKeyFailed ||= error?.kind === LOCAL_KEY_FAILURE;
    return error;
  };

  try {
    const version = (await runPassCli(['--version'], call)).trim();
    checks.push({ name: 'pass-cli', status: 'ok', detail: version || 'present' });
  } catch (error) {
    checks.push({ name: 'pass-cli', status: 'fail', detail: error.message });
    return { checks, ok: false };
  }

  try {
    const vaults = (await runPassCliJson(['vault', 'list', '--output', 'json'], call))?.vaults ?? [];
    checks.push(
      vaults.length > 0
        ? { name: 'vault access', status: 'ok', detail: vaults.map((v) => v.name).join(', ') }
        : { name: 'vault access', status: 'fail', detail: 'No vault reachable. Run: pass-cli agent access grant' }
    );
  } catch (error) {
    checks.push({ name: 'vault access', status: 'fail', detail: noteKeyFailure(error).message });
  }

  // A personal session works but drops every guarantee an agent token provides:
  // no scoping, no audit trail, and --show-secrets stays permitted. `info` is the
  // authoritative source; an env var only says a token was exported, not that the
  // session actually uses it.
  //
  // Note what cannot be checked: pass-cli exposes no expiry for the current
  // session (InfoOutput has no such field), so remaining token lifetime is not
  // knowable here. An expired token surfaces on first use, where pass-cli.js
  // turns it into a message naming `agent renew`.
  try {
    const info = await runPassCliJson(['info', '--output', 'json'], call);
    // `info` reports the session's *display* name, which for an agent token is the
    // agent's name behind an "[Agent] " prefix — measured against pass-cli 2.3.2,
    // where an agent created as `browser-agent` shows as `[Agent] browser-agent`.
    // `agent renew` takes the bare name, so the prefix comes off and the rest is
    // quoted; the detail still shows the display name, since that is what `info`
    // calls it.
    const displayName = info.personal_access_token_name;
    // The single quotes below are shell quoting, so an apostrophe in the name has
    // to close and reopen them the POSIX way: `it's` becomes `'it'\''s'`. Without
    // that, a name like `browser's agent` reproduces the broken paste this hint
    // exists to prevent.
    const agentName = displayName?.replace(/^\[Agent\] /, '').replace(/'/g, String.raw`'\''`);
    checks.push(
      displayName
        ? {
            name: 'session kind',
            status: 'ok',
            detail:
              `token session "${displayName}" — renew with: pass-cli agent renew '${agentName}' ` +
              `--expiration 1h${EXPIRATION_VALUES}`,
          }
        : {
            name: 'session kind',
            status: 'warn',
            detail:
              'Personal session — unscoped, unaudited, and --show-secrets stays permitted. ' +
              `Create an agent token: pass-cli agent create <name> --expiration 1h --vault <vault>${EXPIRATION_VALUES}`,
          }
    );
  } catch (error) {
    checks.push({ name: 'session kind', status: 'fail', detail: noteKeyFailure(error).message });
  }

  checks.push(
    processEnv.PROTON_PASS_DISABLE_TELEMETRY
      ? { name: 'telemetry', status: 'ok', detail: 'disabled' }
      : { name: 'telemetry', status: 'warn', detail: 'enabled — set PROTON_PASS_DISABLE_TELEMETRY=1 to turn it off' }
  );

  checks.push(keyProviderCheck(processEnv.PROTON_PASS_KEY_PROVIDER, localKeyFailed));

  // A recovery that happened mid-run would otherwise be invisible here: the
  // checks above would report the session it built and every line would be a
  // tick. Not a failure — a repaired session is a working one, and the run still
  // passes — but a human who ran doctor to find out why the agent stopped is
  // owed the reason it now works.
  if (didReauthenticate(call)) {
    checks.push({
      name: 'session recovery',
      status: 'warn',
      detail:
        'the session was gone when this run started, so pass-cli logout --force and pass-cli login rebuilt it — ' +
        'the checks above describe the session that produced, not the one you had. Expect this after a machine ' +
        'reboot or a long-running agent; if it repeats, the session is being cleared by something else',
    });
  }

  return { checks, ok: checks.every((check) => check.status !== 'fail') };
}
