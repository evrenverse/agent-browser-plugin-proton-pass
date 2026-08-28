import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, buildCommands, runFillCommands } from '../src/fill-commands.js';
import { fakePassCliBin, fakeSequenceEnv } from './fixtures/fake-bin.js';

const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));
const FAKE = fakePassCliBin();

/** A resolver that answers without a vault, so these stay about the shaping. */
const resolver = (credential) => async () => credential;
const CRED = { username: 'octocat', password: 'hunter2hunter2', totp: '123456' };
/** stdout is a pipe in every real use; the TTY refusal has its own case. */
const piped = (extra = {}) => ({ isTTY: false, ...extra });

test('the selectors are addressed by flag, in either spelling', () => {
  const { options, error } = parseArgs([
    '--item', 'GMX', '--password-selector=#pw', '--username-selector', '#u',
  ]);
  assert.equal(error, undefined);
  assert.equal(options.itemRef, 'GMX');
  assert.equal(options.passwordSelector, '#pw');
  assert.equal(options.usernameSelector, '#u');
});

test('an unknown option is a usage error, not a silently ignored argument', () => {
  // A mistyped selector flag that were ignored would produce a batch that fills
  // nothing, and agent-browser would report success over an empty form.
  const { error } = parseArgs(['--item', 'GMX', '--passwrd-selector', '#pw']);
  assert.match(error, /Unknown option "--passwrd-selector"/);
});

test('a flag without a value is refused rather than swallowing the next flag', () => {
  const { error } = parseArgs(['--item', '--password-selector', '#pw']);
  // `--item` takes `--password-selector` as its value; the missing one is caught
  // at the end, where `#pw` has no flag in front of it.
  assert.match(error, /Unknown option "#pw"|requires a value/);
});

test('only the fields that were asked for are filled', () => {
  const { commands } = buildCommands(CRED, { passwordSelector: '#pw' });
  assert.deepEqual(commands, [['fill', '#pw', 'hunter2hunter2']]);
});

test('the order is username, password, totp — the order a form is filled in', () => {
  const { commands } = buildCommands(CRED, {
    totpSelector: '#otp', passwordSelector: '#pw', usernameSelector: '#u',
  });
  assert.deepEqual(commands.map((c) => c[1]), ['#u', '#pw', '#otp']);
});

test('a selector for a value the item does not carry is an error, not an empty fill', () => {
  // An empty fill would clear a field the page had prefilled, and agent-browser
  // would then submit the form with nothing in it.
  const { error } = buildCommands({ password: 'x' }, { passwordSelector: '#pw', totpSelector: '#otp' });
  assert.match(error, /no totp/);
});

test('a terminal is refused, because a pipe is the whole point', async () => {
  // Run by hand without a pipe, the value would land in the scrollback of
  // whoever typed it. That is the one outcome this command must not produce.
  const result = await runFillCommands(
    ['--item', 'GMX', '--password-selector', '#pw'],
    { isTTY: true, resolve: resolver(CRED) }
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Refusing to write a credential to a terminal/);
  assert.equal(result.stdout, undefined, 'and nothing is written');
});

test('the commands land on stdout as one JSON line, ready for batch', async () => {
  const result = await runFillCommands(
    ['--item', 'GMX', '--username-selector', '#u', '--password-selector', '#pw'],
    piped({ resolve: resolver(CRED) })
  );
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), [
    ['fill', '#u', 'octocat'],
    ['fill', '#pw', 'hunter2hunter2'],
  ]);
  assert.equal(result.stderr, undefined, 'and stderr stays empty on the success path');
});

test('a resolve that fails reports the sentence and writes no commands', async () => {
  const result = await runFillCommands(
    ['--item', 'GMX', '--password-selector', '#pw'],
    piped({ resolve: async () => { throw new Error('The Proton Pass agent token has expired.'); } })
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /token has expired/);
  assert.equal(result.stdout, undefined);
});

test('a missing --item is a usage error before anything is resolved', async () => {
  let called = false;
  const result = await runFillCommands(
    ['--password-selector', '#pw'],
    piped({ resolve: async () => { called = true; return CRED; } })
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--item is required/);
  assert.equal(called, false, 'no audit entry may be spent on a malformed call');
});

test('a call with no selector at all is refused rather than emitting an empty batch', async () => {
  const result = await runFillCommands(['--item', 'GMX'], piped({ resolve: resolver(CRED) }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /At least one selector/);
});

test('CLI: the whole thing works against the fake vault, and argv carries no value', async () => {
  // The end-to-end shape an agent uses: one process, stdout piped onward.
  const { stdout, stderr, code } = await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [ENTRY, 'fill-commands', '--item', 'GitHub', '--username-selector', '#u', '--password-selector', '#pw'],
      { env: { ...process.env, PASS_CLI_BIN: FAKE, ...fakeSequenceEnv(['vaults', 'items', 'item-view-notp']) } },
      (error, out, err) => resolve({ stdout: out, stderr: err, code: error?.code ?? 0 })
    );
    child.stdin.end();
  });
  assert.equal(code, 0);
  assert.equal(stderr, '', 'no secret and no noise on stderr');
  assert.deepEqual(JSON.parse(stdout), [
    ['fill', '#u', 'octocat'],
    ['fill', '#pw', 'hunter2hunter2'],
  ]);
});
