/**
 * Interactive first-run setup: pick the vaults, create the scoped token, write
 * the agent's env file, log the agent in, and report the footing that leaves.
 *
 * The vault choice is the point of this command, not a step on the way to it.
 * **An agent token grants read access to every login in every vault it names**,
 * so nothing is preselected, choosing nothing is a valid answer that creates no
 * token, and the confirmation defaults to no.
 *
 * Two sessions are in play and must not be mixed. `vault list` and `agent create`
 * are the *human's* — their own login session, the only one that can see all the
 * vaults and the only one allowed to mint a token. `login` and `doctor` are the
 * *agent's*: its own session directory, a filesystem key, the new token.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runPassCli, runPassCliJson } from './pass-cli.js';
import { runDoctor, formatReport } from './doctor.js';

/** What `--expiration` accepts, in the order pass-cli documents them. */
const EXPIRATIONS = ['1h', '1d', '1w', '1m', '3m', '6m', '1y'];
/**
 * What the lifetime question takes when it is answered with nothing.
 *
 * A month rather than a week because both ends of that trade-off moved when
 * setup started ending the human session: every renewal now costs a `pass-cli
 * login` with password and 2FA, which is a person at a terminal rather than a
 * command in a script. A week of that is a chore people work around — by
 * keeping a session open, which is the thing the logout exists to prevent. The
 * list above is still there for anyone who wants shorter, and `doctor` still
 * prints `1h` in the command it offers to copy.
 */
const DEFAULT_EXPIRATION = '1m';
const DEFAULT_NAME = 'browser-agent';

/**
 * The human's own session, as an environment overlay.
 *
 * `undefined` removes a variable from the child rather than emptying it — Node
 * skips undefined values when it builds the child's environment (measured on
 * v24). Clearing matters: a shell that has already sourced the agent's env file
 * carries the session directory and the token, and `vault list` would then
 * enumerate what the *previous* agent may reach instead of what the human has,
 * quietly narrowing the choice this whole command exists to present.
 *
 * The key provider is deliberately absent from that list, and its absence is not
 * symmetry forgotten. It says where pass-cli keeps the key to its local
 * database — a machine setting — not whose session is being read. Removing it
 * drops pass-cli to its keyring default; on a WSL host with no D-Bus Secret
 * Service that means kernel keyutils, whose key the calling process cannot
 * reach, and pass-cli then logs the human out to protect a database it can no
 * longer decrypt. Measured 2026-08-27: `setup` destroyed the very session it was
 * configuring and answered with the LOCAL_KEY_FAILURE text this package ships
 * for exactly that fault. The hazard check below reads the provider from the
 * ambient environment, so clearing it here also meant warning about one value
 * and running with another.
 */
const HUMAN_SESSION = {
  PROTON_PASS_SESSION_DIR: undefined,
  PROTON_PASS_PERSONAL_ACCESS_TOKEN: undefined,
};

/** POSIX single-quoting, so a home directory with an apostrophe survives sourcing. */
const shellQuote = (/** @type {string} */ value) => `'${value.replace(/'/g, String.raw`'\''`)}'`;

const isYes = (/** @type {string} */ answer) => /^y(es)?$/i.test(answer.trim());

/**
 * Whether reaching the human's own session is a hazard rather than a formality.
 *
 * `setup` runs `vault list` and `agent create` with the agent's three variables
 * cleared, so those calls land in the human's session directory. If that
 * session's database key is not reachable from this process, pass-cli does not
 * merely fail: measured 2026-08-24, `agent create` answered `Local encryption
 * key not found but local data exists. Forcing logout for security.` and
 * destroyed the session it could not read. A command that repairs nothing and
 * costs the human their session is not one to walk into.
 *
 * The check is the environment, not a probe: any probe would be the very call
 * that does the damage. On Linux with no D-Bus Secret Service pass-cli falls
 * back to kernel keyutils, whose keys belong to the session that made them and
 * vanish when it ends — under WSL, constantly. `fs` and `env` do not depend on
 * a session at all, so neither is a hazard.
 *
 * Restricted to Linux deliberately: the measurement is Linux/WSL, and the macOS
 * keychain is persistent and reachable across sessions, so warning there would
 * be a false alarm about a setup that works.
 *
 * @param {Record<string,string|undefined>} processEnv
 * @param {string} platform
 * @returns {boolean}
 */
function keyProviderIsAHazard(processEnv, platform) {
  const provider = processEnv.PROTON_PASS_KEY_PROVIDER;
  return platform === 'linux' && provider !== 'fs' && provider !== 'env';
}

/**
 * Read a selection of 1-based indices.
 *
 * @param {string} input comma- and/or space-separated, or `all`
 * @param {number} count
 * @returns {number[]|null} the indices, `[]` to cancel, `null` to ask again
 */
function parseSelection(input, count) {
  const parts = input.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return [];
  // An account with 21 vaults makes "every one" a 21-number answer, and a human
  // typing 21 numbers makes a typo, not a decision. `all` is a word the human
  // types, never a default and never preselected — and the confirmation below
  // still names every vault it stands for, so the choice stays as visible as an
  // enumerated one.
  if (parts.length === 1 && /^(all|\*)$/i.test(parts[0])) {
    return Array.from({ length: count }, (_, index) => index + 1);
  }
  if (parts.some((part) => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.some((number) => number < 1 || number > count)) return null;
  // A repeated index is a typo, not a second grant: `--vault A --vault A` would
  // be sent verbatim otherwise.
  return [...new Set(numbers)];
}

/**
 * @param {{bin?: string, env?: Record<string,string>, home?: string,
 *          ask?: (question: string) => Promise<string>,
 *          out?: (text: string) => void,
 *          processEnv?: Record<string,string|undefined>, platform?: string}} [options]
 * @returns {Promise<{ok: boolean}>}
 */
export async function runSetup(options = {}) {
  const out = options.out ?? ((/** @type {string} */ text) => void process.stdout.write(text));
  const sessionDir = join(options.home ?? homedir(), '.proton-pass-agent');
  const envFile = join(sessionDir, 'env');
  const human = { bin: options.bin, env: { ...options.env, ...HUMAN_SESSION } };
  // Prompting is allowed only on a terminal: the plugin path is the one that
  // reads stdin, and a pipe here would be a request meant for it.
  const rl =
    options.ask || !process.stdin.isTTY ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = options.ask ?? (rl ? (/** @type {string} */ question) => rl.question(question) : null);

  try {
    await runPassCli(['--version'], human);

    // Before anything reaches the human's session, not after: the call that
    // would find out is the call that does the damage.
    if (keyProviderIsAHazard(options.processEnv ?? process.env, options.platform ?? process.platform)) {
      out(
        'Your own Proton Pass session stores its database key in a keyring, and this is the setup where that\n' +
          'goes wrong: with no D-Bus Secret Service, pass-cli falls back to kernel keyutils, whose keys belong to\n' +
          'the session that created them and vanish when it ends. pass-cli then finds a database it cannot open\n' +
          'and answers with a forced logout — measured, and it costs you the session rather than just the command.\n' +
          'setup is about to read your vaults and mint a token in exactly that session.\n\n' +
          'Fix it first, in your own shell:\n' +
          '  echo \'export PROTON_PASS_KEY_PROVIDER=fs\' >> ~/.zshenv   # or ~/.bashrc\n' +
          '  exec $SHELL\n' +
          '  pass-cli logout --force && pass-cli login\n\n' +
          'The key then lives in a 0600 file beside the database, survives every session, and is reachable from\n' +
          'a daemon. If your keyring does work here — a desktop with gnome-keyring, say — this warning is a false\n' +
          'alarm and you can carry on.\n'
      );
      if (!ask) return { ok: false };
      if (!isYes(await ask('Continue anyway? [y/N] '))) {
        out('Stopped — nothing was created.\n');
        return { ok: false };
      }
    }

    const vaults = (await runPassCliJson(['vault', 'list', '--output', 'json'], human))?.vaults ?? [];
    /** @type {string[]} */
    const names = vaults.map((/** @type {{name: string}} */ vault) => vault.name);
    if (names.length === 0) {
      out('No vault is reachable from your own Proton Pass session. Run: pass-cli login\n');
      return { ok: false };
    }
    out(`Your vaults:\n${names.map((name, index) => `  ${index + 1}. ${name}\n`).join('')}`);

    if (!ask) {
      out(
        '\nsetup asks which of these the agent may read, and stdin is not a terminal, so it cannot ask.\n' +
          'Run it from a terminal, or do the same by hand — the vault names are the deliberate part:\n\n' +
          `  pass-cli agent create ${DEFAULT_NAME} --expiration ${DEFAULT_EXPIRATION} --vault <vault>   # --vault repeats\n` +
          `  export PROTON_PASS_SESSION_DIR=${shellQuote(sessionDir)}\n` +
          '  export PROTON_PASS_KEY_PROVIDER=fs\n' +
          "  export PROTON_PASS_PERSONAL_ACCESS_TOKEN='<the token it printed>'\n" +
          '  pass-cli login\n'
      );
      return { ok: false };
    }

    /** @type {number[]|null} */
    let selection = null;
    while (selection === null) {
      selection = parseSelection(
        await ask(`\nWhich vaults may the agent read? Numbers, e.g. 1,3 — "all" for every one, empty for none: `),
        names.length
      );
      if (selection === null)
        out(`Not a choice from the list. Enter numbers between 1 and ${names.length}, "all", or nothing.\n`);
    }
    const chosen = selection.map((index) => names[index - 1]);
    if (chosen.length === 0) {
      out('Nothing chosen — no token was created.\n');
      return { ok: false };
    }

    out(
      `\nThe agent will be able to read every login in: ${chosen.join(', ')}.\n` +
        (chosen.length === names.length && names.length > 1
          ? `That is all ${names.length} vaults this account can see — nothing is held back.\n`
          : '') +
        'That is the whole vault, every item in it, for as long as the token lives.\n'
    );
    if (!isYes(await ask('Create a token with that access? [y/N] '))) {
      out('Cancelled — no token was created.\n');
      return { ok: false };
    }

    let expiration = '';
    while (!EXPIRATIONS.includes(expiration)) {
      if (expiration) out(`"${expiration}" is not one pass-cli accepts.\n`);
      expiration =
        (await ask(`Token lifetime, one of ${EXPIRATIONS.join(', ')} [${DEFAULT_EXPIRATION}]: `)).trim() ||
        DEFAULT_EXPIRATION;
    }
    const name = (await ask(`Agent name [${DEFAULT_NAME}]: `)).trim() || DEFAULT_NAME;

    // Asked *before* the token exists. The other order strands a live grant that
    // nobody holds the token for, and nothing short of revoking it undoes that.
    if (existsSync(envFile) && !isYes(await ask(`\n${envFile} already exists. Overwrite it? [y/N] `))) {
      out('Kept the existing file — no token was created.\n');
      return { ok: false };
    }

    // Before the token exists, for the same reason the question above is: a
    // directory that cannot be made — occupied by a regular file, unwritable,
    // full — costs nothing here and strands a live grant three lines further
    // down. mkdir's mode is masked by the umask and ignored for a path that
    // already exists, so chmod is what actually settles it.
    try {
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      await chmod(sessionDir, 0o700);
    } catch (error) {
      throw new Error(`Could not prepare ${sessionDir}, so no token was created: ${error.message}`);
    }

    const answer = await runPassCli(
      // `--vault=<name>` rather than two arguments: a vault named with a leading
      // dash would otherwise be read as a flag, and the same applies to any name
      // a human can choose. See the note on `bind` in credential.js.
      ['agent', 'create', name, `--expiration=${expiration}`, ...chosen.map((vault) => `--vault=${vault}`)],
      human
    );
    // The token is one field of a JSON answer, with a long prose instruction
    // beside it. Parsed here rather than through runPassCliJson so the one
    // failure that can strand a live grant — a create that worked and an answer
    // that could not be read — says so instead of blaming the JSON.
    const token = (() => {
      try {
        return JSON.parse(answer).token;
      } catch {
        return undefined;
      }
    })();
    if (typeof token !== 'string' || token === '') {
      throw new Error(
        'pass-cli agent create gave no token this could read, so nothing was written. If it created one anyway, ' +
          'that is a grant nobody holds: check pass-cli agent list.'
      );
    }

    // Written beside the target and renamed over it. `rename` is atomic, so the
    // token is never briefly readable at whatever mode an older env file had —
    // writeFile's `mode` would not have touched an existing one. The chmod is
    // for the temporary file itself, which a crashed earlier run could have left
    // behind at a looser mode.
    //
    // The token exists on the account from here on. Anything that goes wrong now
    // leaves a grant nobody holds, so every failure says so.
    const tempFile = `${envFile}.tmp`;
    try {
      await writeFile(
        tempFile,
        '# Written by agent-browser-plugin-proton-pass setup. It holds an agent token — keep it 0600.\n' +
          `export PROTON_PASS_SESSION_DIR=${shellQuote(sessionDir)}\n` +
          'export PROTON_PASS_KEY_PROVIDER=fs\n' +
          `export PROTON_PASS_PERSONAL_ACCESS_TOKEN=${shellQuote(token)}\n`,
        { mode: 0o600 }
      );
      await chmod(tempFile, 0o600);
      await rename(tempFile, envFile);
    } catch (error) {
      // A half-written copy holding a live token that nothing sources is worse
      // than no copy at all, and removing it is what makes the sentence below
      // true rather than nearly true.
      await rm(tempFile, { force: true }).catch(() => {});
      throw new Error(
        `Could not write ${envFile}: ${error.message}. The token pass-cli just created is therefore held ` +
          'nowhere: it is a grant nobody has, and only revoking it undoes that — check pass-cli agent list.'
      );
    }
    out(`\nWrote ${envFile} — mode 0600, and the only place the token is stored.\n`);

    // The human's session had two jobs — listing the vaults and minting the
    // token — and both are done. Ending it here is what makes the token the
    // agent's only reach into Pass: a session left signed in sits ungated beside
    // the scoped one, sees every vault, files no audit reason, and is the
    // convenient way around every limit the token exists to impose. It costs one
    // `pass-cli login` before the next setup, and that is the whole of it.
    //
    // Not `--force`, which leaves a session Proton never heard about live on the
    // account: gone is the point. A failure is reported and nothing more — the
    // token is minted and written, and every step below runs as the agent. The
    // call cannot escalate into one against the wrong directory either: recovery
    // needs a token and a session directory in the child environment, and
    // HUMAN_SESSION clears both.
    try {
      await runPassCli(['logout'], human);
      out('Signed your own session out — it is needed only to list the vaults and mint the token.\n');
    } catch (error) {
      // The failure is often after the fact rather than instead of the logout:
      // measured against pass-cli 2.3.3 with PROTON_PASS_KEY_PROVIDER=fs on
      // 2026-09-01, `logout` removed the session directory and *then* failed
      // writing its auth state back — `Error serializing auth: Error getting
      // local key`, exit non-zero, session genuinely gone. Claiming it is still
      // signed in would send someone to log out something that no longer exists,
      // so the message names the check instead of the conclusion.
      out(
        `Signing your own session out reported: ${error.message}\n` +
          'That may be an error after the fact rather than instead of the logout: pass-cli clears ' +
          'the session directory first and can fail writing its auth state back afterwards. Check ' +
          'with pass-cli info — "there is no session" means it is gone. If it still answers, run ' +
          'pass-cli logout again.\n'
      );
    }

    const agent = {
      bin: options.bin,
      env: {
        ...options.env,
        PROTON_PASS_SESSION_DIR: sessionDir,
        PROTON_PASS_KEY_PROVIDER: 'fs',
        PROTON_PASS_PERSONAL_ACCESS_TOKEN: token,
      },
    };
    // A second run of setup finds a session directory that already holds one, and
    // `pass-cli login` refuses that outright — measured: exit 1, `Error: Already
    // authenticated`. Re-running setup is normal (the wrong vault the first time,
    // an expired token, a second machine), so the stale session is cleared first.
    // It is stale by definition: the token that made it has just been replaced.
    //
    // `logout --force` does not ask, so what makes it safe is the environment it
    // runs in — the agent's own PROTON_PASS_SESSION_DIR, never the human's. The
    // probe is `info`, which fails when there is no session, rather than a match
    // on pass-cli's wording: one extra call against a vendor string this project
    // has had to correct more than once.
    //
    // `probe: true` because that failure is the answer here. Without it the
    // plugin's own recovery would log this call in — with the token minted three
    // lines above, in the directory this branch exists to clear — and the probe
    // would report a session it had just created itself.
    if (await runPassCli(['info', '--output', 'json'], { ...agent, probe: true }).then(() => true, () => false)) {
      try {
        // Through the same wrapper the plugin's own recovery lives in, so a
        // logout that itself failed to authenticate would be answered with a
        // logout and a login, and then repeated. Odd in shape, harmless in
        // effect — the end state is the one this branch is trying to reach, and
        // the recovery is spent once. Left as it is on purpose: `setup` is not
        // the place to restructure for it.
        await runPassCli(['logout', '--force'], agent);
      } catch (error) {
        out(
          `Could not clear the agent session already in ${sessionDir}: ${error.message}\n` +
            `The new token is in ${envFile}. Source it, then run pass-cli logout --force and pass-cli login.\n`
        );
        return { ok: false };
      }
      out(
        `Cleared the agent session already in ${sessionDir}. The token it used is configured nowhere now, ` +
          'and stays valid on your account until it expires or you revoke it.\n'
      );
    }

    // Exporting the token establishes nothing: without this login every later
    // command answers `This operation requires an authenticated client`. Proton's
    // own agent instructions, printed beside the token, prescribe the same step.
    try {
      await runPassCli(['login'], agent);
    } catch (error) {
      out(
        `pass-cli login failed: ${error.message}\n` +
          `The token is in ${envFile}. Source it, then run pass-cli login again.\n`
      );
      return { ok: false };
    }

    const report = await runDoctor({
      bin: options.bin,
      env: agent.env,
      // Doctor reads the environment for the key provider and telemetry, so it
      // must see the agent's, not this process's.
      processEnv: { ...process.env, PROTON_PASS_SESSION_DIR: sessionDir, PROTON_PASS_KEY_PROVIDER: 'fs' },
    });
    out(`\n${formatReport(report)}`);
    out(
      `\nIn every shell that will run agent-browser:\n  source ${envFile}\n\nThen, for example:\n` +
        '  agent-browser auth login gmx --credential-provider proton-pass --item "GMX" ' +
        '--url https://www.gmx.net/login\n'
    );
    return { ok: report.ok };
  } catch (error) {
    // Ctrl+C or Ctrl+D at a prompt: Node rejects the pending question with an
    // AbortError, whose message alone ("Aborted with Ctrl+D") answers everything
    // except the question a half-finished setup actually raises. Every prompt
    // comes before the token is created, so the answer is always the same one.
    out(error.code === 'ABORT_ERR' ? '\nCancelled — no token was created.\n' : `${error.message}\n`);
    return { ok: false };
  } finally {
    rl?.close();
  }
}
