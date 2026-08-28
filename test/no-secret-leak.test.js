import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakePassCliBin, fakeSequenceEnv } from './fixtures/fake-bin.js';

const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));
const FAKE = fakePassCliBin();
const SENTINEL = 'correct-horse-battery';

/**
 * Drive the plugin as agent-browser would and capture both streams separately.
 *
 * The success path needs a *sequence* of fake responses — vault list, item list,
 * item view, item totp — because a single mode would answer `vault list` with
 * item data and the flow would abort before a secret is ever in play.
 *
 * The agent's three session variables are removed from the child environment
 * unless a case asks for them back — `undefined` deletes rather than empties,
 * the way `setup` reaches the human's session. Without that, this whole file
 * measures the machine it runs on: in a shell that has sourced
 * `~/.proton-pass-agent/env`, as the README tells every shell running
 * agent-browser to do, the plugin under test inherits a token, self-heals
 * mid-sequence, and the case below that must fail stops failing.
 *
 * @param {string} input
 * @param {{modes?: string[], mode?: string, session?: Record<string,string>}} fake
 */
function runPlugin(input, fake) {
  const env = {
    ...process.env,
    PROTON_PASS_SESSION_DIR: undefined,
    PROTON_PASS_KEY_PROVIDER: undefined,
    PROTON_PASS_PERSONAL_ACCESS_TOKEN: undefined,
    PASS_CLI_BIN: FAKE,
    ...(fake.modes ? fakeSequenceEnv(fake.modes) : { FAKE_PASS_CLI_MODE: fake.mode }),
    ...fake.session,
  };
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [ENTRY], { env }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr })
    );
    child.stdin.end(input);
  });
}

const REQUEST = JSON.stringify({
  protocol: 'agent-browser.plugin.v1',
  type: 'credential.resolve',
  capability: 'credential.read',
  request: { profileName: 'gmx', itemRef: 'GMX', url: 'https://www.gmx.net/login' },
});

test('the secret never appears on stderr on the success path', async () => {
  const { code, stdout, stderr } = await runPlugin(REQUEST, {
    modes: ['vaults', 'items', 'item-view', 'totp'],
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes(SENTINEL), 'stdout is the sanctioned channel and must carry it');
  assert.equal(stderr.includes(SENTINEL), false, 'stderr must never carry a secret');
});

// Every one of these modes fails before `item view` ever runs, so the sentinel never
// materialises — a bare "not present" check would pass vacuously even if the plugin
// dumped its state to stderr. Requiring an empty stream also catches a stack trace or
// stray debug output, which `src/index.js` never writes in plugin mode.
for (const mode of ['no-session', 'expired', 'items', 'vaults', 'silent-fail']) {
  test(`stderr is empty in mode "${mode}"`, async () => {
    const { code, stderr } = await runPlugin(REQUEST, { mode });
    assert.equal(code, 0);
    assert.equal(stderr, '');
  });
}

test('a failure midway through the sequence still leaks nothing', async () => {
  const { code, stdout, stderr } = await runPlugin(REQUEST, {
    modes: ['vaults', 'items', 'item-view', 'no-session'],
  });
  assert.equal(code, 0);
  assert.equal(stderr.includes(SENTINEL), false);
  assert.match(stdout, /"success":false/);
  // Tripwire: without this, the assertions above pass identically whether the flow
  // fails at the 4th call (secret already resolved in memory, the point of this case)
  // or the 1st — which would silently demote this case to the vacuous class above.
  assert.match(stdout, /Not logged in to Proton Pass/);
});

test('a malformed request carrying a secret leaks nothing and reports no stack trace', async () => {
  // Truncated JSON, not just gibberish: this proves raw request bytes containing a
  // secret are not echoed back on a parse failure, not merely that "not json" is safe.
  // The echo would land on stdout, where the protocol error goes, so both streams
  // are checked — stderr alone would prove nothing about an echo.
  const { code, stdout, stderr } = await runPlugin(
    `{"protocol":"agent-browser.plugin.v1","password":"${SENTINEL}"`,
    {}
  );
  assert.equal(code, 0);
  assert.match(stdout, /"success":false/);
  assert.equal(stdout.includes(SENTINEL), false, 'the protocol error must not echo the request bytes');
  assert.equal(stderr, '');
});

test('a resolve that re-authenticates midway leaks nothing either', async () => {
  // The ninth path, and the only one that reaches the recovery: without the
  // session variables below the plugin cannot heal, so the other eight say
  // nothing about a branch that runs three extra pass-cli calls and carries the
  // token through two of them.
  const TOKEN = 'pst_test::key';
  const { code, stdout, stderr } = await runPlugin(REQUEST, {
    modes: ['dead-session', 'logout', 'login', 'vaults', 'items', 'item-view', 'totp'],
    session: {
      PROTON_PASS_SESSION_DIR: '/nonexistent/proton-pass-agent',
      PROTON_PASS_KEY_PROVIDER: 'fs',
      PROTON_PASS_PERSONAL_ACCESS_TOKEN: TOKEN,
    },
  });
  assert.equal(code, 0);
  assert.equal(stderr, '', 'a self-heal writes nothing to stderr either');
  // The tripwire: the recovery really did run and the flow really did resolve.
  assert.ok(stdout.includes(SENTINEL), 'the healed resolve answers with the credential');
  for (const [stream, text] of [['stdout', stdout], ['stderr', stderr]]) {
    assert.equal(text.includes(TOKEN), false, `the token must not reach ${stream}`);
  }
});

test('an answer nobody is left to read is dropped in silence, not onto stderr', async () => {
  // The tenth path. agent-browser can be gone before the answer is written —
  // killed, timed out, or a daemon restarted while up to four pass-cli calls
  // were in flight — and the write then raises EPIPE. Node's default for an
  // unhandled stream error is a full stack trace on stderr and a non-zero exit,
  // on the one stream every other case in this file asserts is empty. Nothing
  // here spawns pass-cli: the read end is closed before the request goes in, so
  // whatever the plugin answers has nowhere to go.
  const { code, stderr } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, PASS_CLI_BIN: FAKE, FAKE_PASS_CLI_MODE: 'vaults' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let captured = '';
    child.stderr.on('data', (chunk) => (captured += chunk));
    child.stdout.destroy();
    child.stdin.end(JSON.stringify({ protocol: 'agent-browser.plugin.v1', type: 'plugin.manifest' }));
    child.on('close', (exitCode) => resolve({ code: exitCode, stderr: captured }));
  });
  assert.equal(stderr, '', `a closed pipe must not produce output: ${stderr}`);
  assert.equal(code, 0, 'nor a crash');
});
