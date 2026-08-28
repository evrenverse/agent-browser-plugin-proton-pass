import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../src/doctor.js';
import { fakePassCliBin, fakeSequenceEnv } from './fixtures/fake-bin.js';

const FAKE = fakePassCliBin();
const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));

/** doctor calls in this order: --version, vault list, info. */
const seq = (info) => ({ bin: FAKE, env: fakeSequenceEnv(['version', 'vaults', info]) });

const find = (report, name) => report.checks.find((check) => check.name === name);

/**
 * The runnable part of a hint: from the `pass-cli` it names up to the em dash that
 * ends it. A hint is copied and pasted, so what precedes the prose has to be shell
 * and nothing else — an unquoted `[Agent] browser-agent` or a trailing
 * `(or 1d, 1w, …)` both die at the prompt.
 */
const command = (detail) => detail.slice(detail.indexOf('pass-cli')).split(' — ')[0];

test('a missing pass-cli fails the first check and stops', async () => {
  const report = await runDoctor({ bin: '/nonexistent/pass-cli' });
  assert.equal(report.ok, false);
  assert.equal(report.checks[0].status, 'fail');
  assert.match(report.checks[0].detail, /not found/i);
  assert.equal(report.checks.length, 1, 'no point checking vaults without a binary');
});

test('a reachable vault passes and names the vault', async () => {
  const report = await runDoctor(seq('info-token'));
  assert.equal(find(report, 'vault access').status, 'ok');
  assert.match(find(report, 'vault access').detail, /Automation/);
});

test('a token session passes and names the token for renewal', async () => {
  const report = await runDoctor(seq('info-token'));
  const session = find(report, 'session kind');
  assert.equal(session.status, 'ok');
  assert.match(session.detail, /browser-agent/);
});

test('the renew command drops the display name\'s [Agent] prefix and quotes what is left', async () => {
  // `info` reports `[Agent] browser-agent`; `agent renew` takes `browser-agent`.
  // Interpolated raw, the hint emitted an unquoted, bracketed, space-containing
  // name — a command that cannot run.
  const report = await runDoctor(seq('info-agent-token'));
  const session = find(report, 'session kind');
  assert.equal(session.status, 'ok');
  assert.match(session.detail, /token session "\[Agent\] browser-agent"/, 'the detail keeps the display name');
  // Pinned exactly, not matched loosely: this hint is copied to a prompt, so both
  // the name and where the command stops are the property under test.
  assert.equal(command(session.detail), "pass-cli agent renew 'browser-agent' --expiration 1h");
  // And the prose the command stops for is the point of stopping — without this
  // the alternatives could be deleted wholesale and the suite would stay green.
  assert.match(session.detail, /also accepts 1d, 1w, 1m, 3m, 6m, 1y$/);
});

test('an apostrophe in the agent name is escaped, not left to end the quoting', async () => {
  const report = await runDoctor(seq('info-quoted-token'));
  const session = find(report, 'session kind');
  // POSIX: leave the quoting, emit a literal quote, re-enter. `sh -c` on the
  // result passes `browser's agent` through as one argument.
  assert.equal(command(session.detail), String.raw`pass-cli agent renew 'browser'\''s agent' --expiration 1h`);
});

test('a personal session warns, because it is unscoped and unaudited', async () => {
  const report = await runDoctor(seq('info-personal'));
  const session = find(report, 'session kind');
  assert.equal(session.status, 'warn');
  // The same shape rule as the renew hint: the command ends before the prose does.
  assert.equal(command(session.detail), 'pass-cli agent create <name> --expiration 1h --vault <vault>');
});

test('telemetry left enabled is a warning, not a failure', async () => {
  const report = await runDoctor({ ...seq('info-token'), processEnv: {} });
  assert.equal(find(report, 'telemetry').status, 'warn');
});

test('telemetry switched off passes', async () => {
  // Without this the warn branch is the only one ever taken, so the ok branch
  // could name anything at all and every test here would still be green.
  const report = await runDoctor({
    ...seq('info-token'),
    processEnv: { PROTON_PASS_DISABLE_TELEMETRY: '1' },
  });
  assert.equal(find(report, 'telemetry').status, 'ok');
  assert.match(find(report, 'telemetry').detail, /disabled/);
});

test('the default key provider warns, D-Bus or no D-Bus', async () => {
  // The false negative this check exists for: on the machine where an agent could
  // not decrypt the database, DBUS_SESSION_BUS_ADDRESS was set the whole time.
  const report = await runDoctor({
    ...seq('info-token'),
    processEnv: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
  });
  const keyProvider = find(report, 'key provider');
  assert.equal(keyProvider.status, 'warn');
  assert.match(keyProvider.detail, /unset/);
  assert.match(keyProvider.detail, /PROTON_PASS_KEY_PROVIDER=fs/);
});

test('a filesystem key provider passes and says why', async () => {
  const report = await runDoctor({ ...seq('info-token'), processEnv: { PROTON_PASS_KEY_PROVIDER: 'fs' } });
  const keyProvider = find(report, 'key provider');
  assert.equal(keyProvider.status, 'ok');
  assert.match(keyProvider.detail, /login session/);
});

test('a value pass-cli does not accept is reported as that, not lectured about keyrings', async () => {
  // `file` is the plausible wrong guess, and pass-cli rejects it on startup rather
  // than falling back to anything. The same branch catches a miscased `FS`.
  const report = await runDoctor({ ...seq('info-token'), processEnv: { PROTON_PASS_KEY_PROVIDER: 'file' } });
  const keyProvider = find(report, 'key provider');
  assert.equal(keyProvider.status, 'warn');
  assert.match(keyProvider.detail, /"file" is not a value pass-cli accepts/);
  assert.doesNotMatch(keyProvider.detail, /belongs to the login session/);
});

test('a database pass-cli cannot decrypt fails the check, whatever the environment claims', async () => {
  const report = await runDoctor({
    bin: FAKE,
    env: fakeSequenceEnv(['version', 'local-key-fail', 'local-key-fail']),
    processEnv: { PROTON_PASS_KEY_PROVIDER: 'fs' },
  });
  const keyProvider = find(report, 'key provider');
  assert.equal(keyProvider.status, 'fail', 'a failed call outranks a guess from the environment');
  assert.match(keyProvider.detail, /logout --force/);
  assert.equal(report.ok, false);
});

test('a non-object vault listing reports the intended sentence, not a TypeError', async () => {
  const report = await runDoctor({
    bin: FAKE,
    env: fakeSequenceEnv(['version', 'null-body', 'info-token']),
  });
  const vaultAccess = find(report, 'vault access');
  assert.equal(vaultAccess.status, 'fail');
  assert.match(vaultAccess.detail, /agent access grant/);
});

test('a session rebuilt during the run is reported, not passed off as healthy', async () => {
  // doctor is the one caller whose recovery leaves no trace anywhere else: it
  // sets no reason and none of its three calls is audited, so `[re-authenticated]`
  // cannot fire. Without a line of its own, a human running doctor to find out
  // why the agent stopped overnight is shown four ticks and told nothing.
  const report = await runDoctor({
    bin: FAKE,
    env: {
      ...fakeSequenceEnv(['version', 'dead-session', 'logout', 'login', 'vaults', 'info-token']),
      PROTON_PASS_SESSION_DIR: '/nonexistent/proton-pass-agent',
      PROTON_PASS_KEY_PROVIDER: 'fs',
      PROTON_PASS_PERSONAL_ACCESS_TOKEN: 'pst_test::key',
    },
    processEnv: { PROTON_PASS_KEY_PROVIDER: 'fs', PROTON_PASS_DISABLE_TELEMETRY: '1' },
  });
  assert.equal(find(report, 'vault access').status, 'ok', 'the retry really did succeed');
  const recovery = find(report, 'session recovery');
  assert.ok(recovery, `no recovery line in ${JSON.stringify(report.checks.map((c) => c.name))}`);
  assert.equal(recovery.status, 'warn');
  assert.match(recovery.detail, /logout --force/);
  assert.equal(report.ok, true, 'a repaired session is a working session, so the run still passes');
});

test('an untroubled run carries no recovery line', async () => {
  const report = await runDoctor(seq('info-token'));
  assert.equal(find(report, 'session recovery'), undefined);
});

test('a recovery that failed is not reported as a session rebuilt', async () => {
  // Session gone *and* token expired: `logout --force` destroys what local state
  // was left, the re-login cannot replace it, and nothing was rebuilt. Saying
  // otherwise would be the wrong remedy arriving through the very channel that
  // exists to carry the right one — the skill reads a recovery line as "the
  // token is fine", and here `vault access` says it is not.
  const report = await runDoctor({
    bin: FAKE,
    env: {
      ...fakeSequenceEnv(['version', 'dead-session', 'logout', 'expired', 'dead-session']),
      PROTON_PASS_SESSION_DIR: '/nonexistent/proton-pass-agent',
      PROTON_PASS_KEY_PROVIDER: 'fs',
      PROTON_PASS_PERSONAL_ACCESS_TOKEN: 'pst_test::key',
    },
    processEnv: { PROTON_PASS_KEY_PROVIDER: 'fs', PROTON_PASS_DISABLE_TELEMETRY: '1' },
  });
  assert.match(find(report, 'vault access').detail, /agent renew/, 'the run really did hit the failed recovery');
  assert.equal(report.ok, false);
  assert.equal(find(report, 'session recovery'), undefined, 'nothing was rebuilt, so nothing may claim it was');
});

// The report object is what every test above checks. These two drive the CLI
// that wraps it — the interface the README documents for agents and for shell
// scripts — and neither the --json branch nor the exit code had a caller here.
/** @param {string[]} args @param {Record<string,string>} env */
function runCliDoctor(args, env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [ENTRY, 'doctor', ...args],
      { env: { ...process.env, PASS_CLI_BIN: FAKE, ...env } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
    );
  });
}

test('CLI: doctor --json emits the report as an object an agent can read', async () => {
  const { code, stdout } = await runCliDoctor(['--json'], fakeSequenceEnv(['version', 'vaults', 'info-token']));
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map((/** @type {{name: string}} */ check) => check.name),
    ['pass-cli', 'vault access', 'session kind', 'telemetry', 'key provider']
  );
  assert.equal(code, 0, 'a passing run exits 0, warnings and all');
});

test('CLI: doctor exits 1 when a check failed', async () => {
  // The README states this outright, and a script that gates on it is the whole
  // point of the code. Without the CLI in the loop, `return 0` unconditionally
  // passes every test in this file.
  const { code, stdout } = await runCliDoctor([], { PASS_CLI_BIN: '/nonexistent/pass-cli' });
  assert.equal(code, 1);
  assert.match(stdout, /✗ pass-cli:/);
});
