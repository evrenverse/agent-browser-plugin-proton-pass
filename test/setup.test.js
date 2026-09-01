import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup } from '../src/setup.js';
import { fakePassCliBin, fakeSequenceEnv } from './fixtures/fake-bin.js';

const FAKE = fakePassCliBin();
/** The token the `agent-create` fixture answers with. It must never be seen again. */
const TOKEN = 'pst_test::key';

/**
 * What setup calls, in order: its own preflight `--version`, the human's
 * `vault list`, `agent create`, the human's `logout`, then the probe for a session already
 * in the agent's directory — `no-session` here, so there is none — the agent's `login`, then
 * doctor's three.
 */
const HAPPY = [
  'version',
  'vaults-many',
  'agent-create',
  'logout',
  'no-session',
  'login',
  'version',
  'vaults-many',
  'info-token',
];

/** Answers that walk the happy path: vaults, confirmation, lifetime, agent name. */
const ANSWERS = ['1 3', 'y', '1w', ''];

/**
 * A run of setup with every prompt answered from a queue and every printed line
 * captured, so nothing here needs a terminal — or a real pass-cli.
 *
 * @param {{modes?: string[], answers?: string[], home?: string}} [setup]
 */
function harness({ modes = HAPPY, answers = ANSWERS, home = mkdtempSync(join(tmpdir(), 'setup-home-')) } = {}) {
  const queue = [...answers];
  const printed = [];
  const asked = [];
  const options = {
    bin: FAKE,
    env: fakeSequenceEnv(modes),
    home,
    // Pinned, not inherited: the key-provider hazard check reads the ambient
    // environment, so a developer box exporting PROTON_PASS_KEY_PROVIDER=fs sees
    // setup ask its questions while CI, which exports nothing, sees it stop at the
    // hazard before the first one. That difference cost a red first CI run on
    // 2026-08-28 — every test here states the environment it means.
    processEnv: { PROTON_PASS_KEY_PROVIDER: 'fs' },
    ask: async (/** @type {string} */ question) => {
      asked.push(question);
      return queue.shift() ?? '';
    },
    out: (/** @type {string} */ text) => printed.push(text),
  };
  return {
    options,
    asked,
    home,
    sessionDir: join(home, '.proton-pass-agent'),
    envFile: join(home, '.proton-pass-agent', 'env'),
    output: () => printed.join(''),
    /** Every fake invocation, with the argv and the session variables it saw. */
    calls: () => JSON.parse(readFileSync(options.env.FAKE_PASS_CLI_SEQUENCE, 'utf8')).calls ?? [],
  };
}

/** @param {Array<{mode: string, argv: string[]}>} calls */
const created = (calls) => calls.find((call) => call.mode === 'agent-create');

test('the chosen vaults reach agent create as repeated --vault, in the order they were typed', async () => {
  const run = harness();
  const result = await runSetup(run.options);
  assert.equal(result.ok, true);
  assert.deepEqual(created(run.calls()).argv, [
    'agent',
    'create',
    'browser-agent',
    '--expiration=1w',
    '--vault=Automation',
    '--vault=Archive',
  ]);
});

test('a comma-separated selection is read the same way as a space-separated one', async () => {
  const run = harness({ answers: ['2,3', 'y', '1w', ''] });
  await runSetup(run.options);
  assert.deepEqual(created(run.calls()).argv.slice(-2), ['--vault=Team Logins', '--vault=Archive']);
});

test('"all" grants every vault, so 21 vaults need one word rather than 21 numbers', async () => {
  const run = harness({ answers: ['all', 'y', '1w', ''] });
  await runSetup(run.options);
  assert.deepEqual(created(run.calls()).argv.slice(-3), [
    '--vault=Automation',
    '--vault=Team Logins',
    '--vault=Archive',
  ]);
  // Breadth this wide is worth a sentence of its own: the enumerated confirmation
  // reads the same for one vault as for all of them.
  assert.match(run.output(), /all 3 vaults this account can see/);
});

test('"all" is a word, not a shortcut past the confirmation', async () => {
  // Answering the confirmation with anything but yes must still create nothing —
  // the convenience is in naming the vaults, never in skipping the question.
  const run = harness({ answers: ['all', ''] });
  const result = await runSetup(run.options);
  assert.equal(result.ok, false);
  assert.match(run.output(), /Cancelled/);
  assert.equal(
    run.calls().some((call) => call.mode === 'agent-create'),
    false
  );
});

test('an empty selection creates no token and exits non-zero', async () => {
  // The default is nothing, and nothing is a valid answer: a token grants read
  // access to whole vaults, so it must not be possible to create one by pressing
  // Enter past a question.
  const run = harness({ answers: [''] });
  const result = await runSetup(run.options);
  assert.equal(result.ok, false);
  assert.equal(created(run.calls()), undefined, 'no token may be created without a vault choice');
  assert.equal(run.calls().length, 2, '--version and vault list, and nothing after them');
  assert.equal(existsSync(run.envFile), false);
  assert.match(run.output(), /no token was created/i);
  // The run ends at the question itself. Without this, an empty selection that
  // fell through to a confirmation defaulting to no would pass this test too —
  // and "every vault, unless you say otherwise" would be one typo from live.
  assert.equal(run.asked.length, 1, 'nothing chosen is the end of the run, not the start of a confirmation');
});

test('out-of-range and non-numeric input ask again instead of proceeding', async () => {
  // `0` is the one that has to be caught rather than clamped: the list is
  // 1-based, so `names[-1]` is undefined and a regression would confirm "read
  // every login in: " with nothing after it, then send `--vault undefined`.
  const run = harness({ answers: ['4', '0', 'two', '1,x', '1 1', 'y', '1w', ''] });
  const result = await runSetup(run.options);
  assert.equal(result.ok, true);
  const vaultQuestions = run.asked.filter((question) => /which vaults/i.test(question));
  assert.equal(vaultQuestions.length, 5, 'four rejected answers, then the one that was a choice');
  // `1 1` is a typo, not a second grant.
  const argv = created(run.calls()).argv;
  assert.deepEqual(argv.slice(-1), ['--vault=Automation']);
  assert.equal(argv.filter((a) => a.startsWith('--vault=')).length, 1, 'a repeated index grants once');
  assert.match(run.output(), /read every login in: Automation\./);
});

test('declining the confirmation creates no token', async () => {
  const run = harness({ answers: ['1', 'n'] });
  const result = await runSetup(run.options);
  assert.equal(result.ok, false);
  assert.equal(created(run.calls()), undefined);
  assert.match(run.output(), /no token was created/i);
});

test('the confirmation defaults to no, so Enter cancels rather than grants', async () => {
  const run = harness({ answers: ['1', ''] });
  assert.equal((await runSetup(run.options)).ok, false);
  assert.equal(created(run.calls()), undefined);
});

test('the confirmation names the vaults and says what read access means', async () => {
  const run = harness();
  await runSetup(run.options);
  assert.match(run.output(), /Automation, Archive/);
  assert.match(run.output(), /every login/i);
});

test('a lifetime pass-cli does not accept asks again', async () => {
  // `2w` is the plausible wrong guess: it reads like the others and is not on the
  // list. Answering `1d` after it proves the second answer is the one used.
  const run = harness({ answers: ['1', 'y', '2w', '1d', ''] });
  await runSetup(run.options);
  const argv = created(run.calls()).argv;
  assert.ok(argv.includes('--expiration=1d'), `expected --expiration=1d, got ${JSON.stringify(argv)}`);
});

test('an empty answer to the lifetime question takes the default', async () => {
  // The default is the answer most runs will give, so it is the one worth
  // pinning: nothing else in the suite would notice it changing.
  const run = harness({ answers: ['1 3', 'y', '', ''] });
  await runSetup(run.options);
  const argv = created(run.calls()).argv;
  assert.ok(argv.includes('--expiration=1m'), `expected --expiration=1m, got ${JSON.stringify(argv)}`);
});

test('the token never enters argv, and reaches pass-cli login in the environment', async () => {
  const run = harness();
  await runSetup(run.options);
  for (const call of run.calls()) {
    assert.ok(
      call.argv.every((argument) => !argument.includes(TOKEN)),
      `argv must not carry the token, got ${JSON.stringify(call.argv)}`
    );
  }
  const login = run.calls().find((call) => call.mode === 'login');
  // The tripwire for the assertion above: the token did travel, just not in argv.
  assert.equal(login.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN, TOKEN);
  assert.equal(login.env.PROTON_PASS_KEY_PROVIDER, 'fs');
  assert.equal(login.env.PROTON_PASS_SESSION_DIR, run.sessionDir);
  assert.equal(run.output().includes(TOKEN), false, 'the token is never printed');
});

test("the vault list, the token and the logout run in the human's session, not the agent's", async () => {
  // The ambient environment is the trap: a shell that has already sourced the env
  // file carries all three variables, and reading the vaults through them would
  // list what the *previous* agent may reach rather than what the human has.
  const ambient = {
    PROTON_PASS_SESSION_DIR: process.env.PROTON_PASS_SESSION_DIR,
    PROTON_PASS_KEY_PROVIDER: process.env.PROTON_PASS_KEY_PROVIDER,
    PROTON_PASS_PERSONAL_ACCESS_TOKEN: process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN,
  };
  process.env.PROTON_PASS_SESSION_DIR = '/tmp/some-other-agent';
  process.env.PROTON_PASS_KEY_PROVIDER = 'fs';
  process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN = 'pst_ambient::key';
  const run = harness();
  try {
    await runSetup(run.options);
  } finally {
    for (const [key, value] of Object.entries(ambient)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const [, vaultList, agentCreate, humanLogout] = run.calls();
  for (const call of [vaultList, agentCreate, humanLogout]) {
    assert.equal(call.env.PROTON_PASS_SESSION_DIR, null, `${call.mode} must not reuse the agent's session directory`);
    assert.equal(call.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN, null, `${call.mode} must not reuse the agent's token`);
    // But not the key provider: see HUMAN_SESSION. Clearing it is what logs the
    // human out, and the test below is the one that says so.
    assert.equal(call.env.PROTON_PASS_KEY_PROVIDER, 'fs', `${call.mode} must keep the machine's key provider`);
  }
});

test('the key provider survives into the human session, because clearing it logs the human out', async () => {
  // Measured 2026-08-27 on WSL: `setup` cleared PROTON_PASS_KEY_PROVIDER alongside
  // the agent's two variables, pass-cli fell back to a kernel keyring it could not
  // read, and it logged the human out to protect the database — destroying the
  // session this command exists to configure. The provider is a machine setting,
  // not an agent one, so it belongs in the child unchanged.
  const ambient = process.env.PROTON_PASS_KEY_PROVIDER;
  process.env.PROTON_PASS_KEY_PROVIDER = 'fs';
  const run = harness();
  try {
    await runSetup(run.options);
  } finally {
    if (ambient === undefined) delete process.env.PROTON_PASS_KEY_PROVIDER;
    else process.env.PROTON_PASS_KEY_PROVIDER = ambient;
  }
  for (const call of run.calls()) {
    assert.notEqual(
      call.env.PROTON_PASS_KEY_PROVIDER,
      null,
      `${call.mode} ran without a key provider — that is the call that destroys the session`
    );
  }
});

test('the env file holds exactly the three exports', async () => {
  const run = harness();
  await runSetup(run.options);
  const contents = readFileSync(run.envFile, 'utf8');
  const exports = contents.split('\n').filter((line) => line.startsWith('export '));
  assert.equal(exports.length, 3, `three exports and no more, got ${JSON.stringify(exports)}`);
  assert.match(contents, /^export PROTON_PASS_SESSION_DIR=/m);
  assert.match(contents, /^export PROTON_PASS_KEY_PROVIDER=fs$/m);
  assert.match(contents, /^export PROTON_PASS_PERSONAL_ACCESS_TOKEN=/m);
  assert.ok(contents.includes(TOKEN), 'the file is the one place the token belongs');
  assert.ok(contents.includes(run.sessionDir), 'the session directory is the agent’s own');
});

test('the env file is written 0600 in a 0700 directory', { skip: process.platform === 'win32' }, async () => {
  const run = harness();
  await runSetup(run.options);
  assert.equal(statSync(run.envFile).mode & 0o777, 0o600);
  assert.equal(statSync(run.sessionDir).mode & 0o777, 0o700);
});

test(
  'a directory and env file left loose by hand are tightened, not left as found',
  { skip: process.platform === 'win32' },
  async () => {
    // The state the README's own manual path produces: `mkdir` under a default
    // umask, `>` into a file. Neither `mkdir` nor `writeFile` applies its mode to
    // a path that already exists, so without the chmod and the rename the token
    // would land in a 0644 file inside a 0755 directory — world-readable, on the
    // re-run path this command makes ordinary.
    const run = harness({ answers: [...ANSWERS, 'y'] });
    mkdirSync(run.sessionDir, { recursive: true });
    chmodSync(run.sessionDir, 0o755);
    writeFileSync(run.envFile, 'export PROTON_PASS_PERSONAL_ACCESS_TOKEN=the-old-one\n');
    chmodSync(run.envFile, 0o644);
    assert.equal((await runSetup(run.options)).ok, true);
    assert.equal(statSync(run.sessionDir).mode & 0o777, 0o700);
    assert.equal(statSync(run.envFile).mode & 0o777, 0o600);
  }
);

test(
  'a temporary file left behind at a loose mode does not carry that mode onto the token',
  { skip: process.platform === 'win32' },
  async () => {
    // `writeFile` never creates one looser than 0600, so this needs a human or
    // root inside a 0700 directory — but its mode is not applied to a path that
    // already exists, and the file is renamed *onto* the one the token lives in.
    // Measured without the chmod on it: the run ends with env at 0666.
    const run = harness();
    mkdirSync(run.sessionDir, { recursive: true });
    writeFileSync(`${run.envFile}.tmp`, 'left over from a run that died\n');
    chmodSync(`${run.envFile}.tmp`, 0o666);
    assert.equal((await runSetup(run.options)).ok, true);
    assert.equal(statSync(run.envFile).mode & 0o777, 0o600);
  }
);

test('a session directory that cannot be created stops the run before the token exists', async () => {
  // Measured shape: `EEXIST: file already exists, mkdir …`. Anything wrong with
  // the directory has to surface here, where it costs nothing — after the token
  // is minted the same failure leaves a grant nobody holds.
  const run = harness();
  writeFileSync(run.sessionDir, 'a regular file where the directory belongs\n');
  const result = await runSetup(run.options);
  assert.equal(result.ok, false);
  assert.equal(created(run.calls()), undefined, 'the failure must land before agent create');
  assert.match(run.output(), /Could not prepare/);
  assert.ok(run.output().includes(run.sessionDir));
  assert.match(run.output(), /no token was created/i);
});

test('an existing env file is not overwritten without consent, and no token is created', async () => {
  // The order matters as much as the question: asked after the token existed, a
  // "no" here would leave a live grant nobody holds the token for.
  const run = harness({ answers: ['1', 'y', '1w', '', 'n'] });
  mkdirSync(run.sessionDir, { recursive: true });
  writeFileSync(run.envFile, 'export PROTON_PASS_PERSONAL_ACCESS_TOKEN=the-old-one\n');
  const result = await runSetup(run.options);
  assert.equal(result.ok, false);
  assert.equal(created(run.calls()), undefined, 'declining must abort before the token exists');
  assert.match(readFileSync(run.envFile, 'utf8'), /the-old-one/);
});

test('an existing env file is overwritten once consent is given', async () => {
  const run = harness({ answers: ['1', 'y', '1w', '', 'y'] });
  mkdirSync(run.sessionDir, { recursive: true });
  writeFileSync(run.envFile, 'export PROTON_PASS_PERSONAL_ACCESS_TOKEN=the-old-one\n');
  assert.equal((await runSetup(run.options)).ok, true);
  const contents = readFileSync(run.envFile, 'utf8');
  assert.ok(contents.includes(TOKEN));
  assert.equal(contents.includes('the-old-one'), false);
});

test('without a terminal it prints the vaults and the manual commands, and creates nothing', async () => {
  // The spec keeps the plugin path and the CLI path apart by argv alone; setup
  // prompts only on a TTY, and stdin under the test runner is not one.
  const run = harness();
  delete run.options.ask;
  const result = await runSetup(run.options);
  assert.equal(result.ok, false);
  assert.equal(created(run.calls()), undefined);
  assert.match(run.output(), /Automation/);
  assert.match(run.output(), /Team Logins/);
  assert.match(run.output(), /pass-cli agent create/);
  assert.match(run.output(), /pass-cli login/);
});

test("the human's session is signed out once the token exists, and only ever its own", async () => {
  // Which session a logout ends is decided by the environment it runs in, and
  // the test above pins that for every human call including this one. What is
  // left to say here is when it happens and what it is: after the token exists,
  // because a session ended before that leaves setup unable to mint one — and
  // plain rather than `--force`, so the session is gone on the account too.
  const run = harness();
  assert.equal((await runSetup(run.options)).ok, true);
  const [, , create, logout] = run.calls();
  assert.equal(create.mode, 'agent-create', 'the logout comes after the token exists, never before it');
  assert.deepEqual(logout.argv, ['logout'], 'plain, so the session is gone on the account and not just here');
  assert.match(run.output(), /Signed your own session out/);
});

test('a logout that fails is reported, and setup carries on', async () => {
  // By this point the token exists on the account and in the file. Abandoning
  // the run over a session that would not close would leave a live grant that
  // nothing is logged in to use — a worse end state than the one being
  // reported, and reachable only by treating tidying up as load-bearing.
  const run = harness({
    modes: ['version', 'vaults-many', 'agent-create', 'silent-fail', 'no-session', 'login', 'version', 'vaults-many', 'info-token'],
  });
  assert.equal((await runSetup(run.options)).ok, true, 'the agent is set up either way');
  assert.match(run.output(), /Signing your own session out reported/);
  // The check, not a conclusion: the same failure covers a logout that worked.
  assert.match(run.output(), /Check with pass-cli info/);
  assert.equal(run.output().includes(TOKEN), false);
});

test('a second run clears the session already in the agent directory, then logs in', async () => {
  // `pass-cli login` refuses a directory that already holds a session — measured:
  // exit 1, `Error: Already authenticated`. Without this the second run of setup
  // fails *after* minting a token: a live grant, nothing configured.
  const run = harness({
    modes: ['version', 'vaults-many', 'agent-create', 'logout', 'info-token', 'logout', 'login', 'version', 'vaults-many', 'info-token'],
  });
  const result = await runSetup(run.options);
  assert.equal(result.ok, true, 'a second run must reach a working end state');
  const [, , , humanLogout, probe, logout, login] = run.calls();
  assert.deepEqual(humanLogout.argv, ['logout'], "the human's session is ended once the token exists");
  assert.deepEqual(probe.argv, ['info', '--output', 'json']);
  assert.deepEqual(logout.argv, ['logout', '--force'], 'the stale session is cleared before the login');
  assert.deepEqual(login.argv, ['login']);
  // What makes `logout --force` safe is where it points: the agent's own
  // directory. Without PROTON_PASS_SESSION_DIR the same command wipes the
  // human's session, and --force does not ask.
  for (const call of [probe, logout]) {
    assert.equal(call.env.PROTON_PASS_SESSION_DIR, run.sessionDir);
    assert.equal(call.env.PROTON_PASS_KEY_PROVIDER, 'fs');
  }
  assert.match(run.output(), /Cleared the agent session already in/);
});

test('a stale session that cannot be cleared is reported, not logged in over', async () => {
  const run = harness({ modes: ['version', 'vaults-many', 'agent-create', 'logout', 'info-token', 'silent-fail'] });
  const result = await runSetup(run.options);
  assert.equal(result.ok, false);
  assert.equal(run.calls().length, 6, 'no login attempt after a logout that failed');
  assert.match(run.output(), /Could not clear the agent session already in/);
  assert.ok(run.output().includes(run.sessionDir), 'the directory to fix by hand is named');
  assert.equal(run.output().includes(TOKEN), false, 'a failure path prints no token either');
});

test('a failed login says where the token is, and does not print it', async () => {
  // The token is already on the account and already in the file by this point,
  // so the message has to name the file rather than the token.
  const run = harness({ modes: ['version', 'vaults-many', 'agent-create', 'logout', 'no-session', 'silent-fail'] });
  const result = await runSetup(run.options);
  assert.equal(result.ok, false);
  assert.match(run.output(), /pass-cli login failed/);
  assert.ok(run.output().includes(run.envFile), 'the file that holds it is named');
  assert.equal(run.output().includes(TOKEN), false, 'a failure path prints no token either');
  assert.ok(readFileSync(run.envFile, 'utf8').includes(TOKEN), 'and the file really does hold it');
});

test('a write that fails after the token exists says the grant is held nowhere', async () => {
  // A directory where the env file belongs: the write lands, the rename onto it
  // does not. The token is on the account by then and in no file, which is the
  // one outcome that cannot be undone by re-running — only by revoking.
  const run = harness({ answers: [...ANSWERS, 'y'] });
  mkdirSync(run.envFile, { recursive: true });
  const result = await runSetup(run.options);
  assert.equal(result.ok, false);
  assert.ok(created(run.calls()), 'the token really was created before the failure');
  assert.match(run.output(), /grant nobody has/);
  assert.match(run.output(), /pass-cli agent list/);
  assert.equal(run.output().includes(TOKEN), false);
  // "Held nowhere" has to be true: the half-written copy is removed, or a live
  // token would sit in a file nothing sources and nobody knows about.
  assert.equal(existsSync(`${run.envFile}.tmp`), false, 'no temporary file may survive with the token in it');
});

test('an agent create whose answer carries no token says the grant may exist anyway', async () => {
  // The one failure that can leave a live grant behind: the command ran, and
  // whatever came back held no token to write down.
  const run = harness({ modes: ['version', 'vaults-many', 'null-body'] });
  const result = await runSetup(run.options);
  assert.equal(result.ok, false);
  assert.match(run.output(), /pass-cli agent list/);
  assert.equal(existsSync(run.envFile), false);
  // Which branch said so is the property under test, and the loose assertions
  // above cannot tell. Without the shape check the run walks on and dies at the
  // write instead — with an undefined token, on a message that also names
  // `pass-cli agent list`, leaving all three assertions above satisfied by the
  // wrong path. The run must stop at `agent create`, before anything is written
  // and before pass-cli is asked a fourth time.
  assert.match(run.output(), /gave no token this could read/);
  assert.equal(run.calls().length, 3, 'the run stops at agent create, not three calls later');
});

test('Ctrl+D at a prompt reports that nothing was created, because nothing was', async () => {
  // Node rejects the pending question with an AbortError. Its own message says
  // only that the run was aborted, which is not what the human needs to hear.
  const run = harness();
  run.options.ask = async () => {
    throw Object.assign(new Error('Aborted with Ctrl+D'), { code: 'ABORT_ERR' });
  };
  const result = await runSetup(run.options);
  assert.equal(result.ok, false);
  assert.equal(created(run.calls()), undefined);
  assert.match(run.output(), /no token was created/i);
});

test('a missing pass-cli fails with the sentence that names the fix', async () => {
  const run = harness();
  run.options.bin = '/nonexistent/pass-cli';
  const result = await runSetup(run.options);
  assert.equal(result.ok, false);
  assert.match(run.output(), /not found/i);
  assert.equal(existsSync(run.envFile), false);
});

test('the run ends with the doctor report and the two commands that follow it', async () => {
  const run = harness();
  await runSetup(run.options);
  assert.match(run.output(), /session kind: token session/, 'doctor runs against the session just created');
  assert.match(run.output(), new RegExp(`source ${run.envFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(run.output(), /agent-browser auth login .*--credential-provider proton-pass/);
});

test("the probe for a stale session is answered, not healed into one", async () => {
  // The probe runs in the agent's session with the new token exported, which is
  // exactly the footing the plugin re-authenticates from. It must not: `setup`
  // asks whether a session is already there, and a probe that logged itself in
  // would answer its own question wrong, then clear the session it had just
  // made and log in again — four pass-cli calls to reach the state the failure
  // already described.
  const run = harness();
  assert.equal((await runSetup(run.options)).ok, true);
  const argvs = run.calls().map((call) => call.argv);
  assert.equal(
    argvs.filter((argv) => argv[1] === '--force').length,
    0,
    'nothing was there, so nothing is cleared — the plain logout is the human session ending'
  );
  assert.equal(argvs.filter((argv) => argv[0] === 'login').length, 1);
  assert.equal(run.calls().length, HAPPY.length, 'the happy path is still nine calls');
});

test(
  'an apostrophe in the home path is escaped, so the env file survives sourcing',
  { skip: process.platform === 'win32' },
  async () => {
    // The file exists to be `source`d. Written with naive quoting, a path like
    // /home/o'brien ends the quoting mid-value: at best the export is wrong, at
    // worst what follows is read as shell. `doctor` escapes the same way for its
    // renew hint and has a test for it; this copy had none.
    const home = mkdtempSync(join(tmpdir(), "setup-o'brien-"));
    const run = harness({ home });
    assert.equal((await runSetup(run.options)).ok, true);
    const contents = readFileSync(run.envFile, 'utf8');
    const dir = contents.match(/^export PROTON_PASS_SESSION_DIR=(.*)$/m)[1];
    const echoed = execFileSync('sh', ['-c', `${contents}\nprintf %s "$PROTON_PASS_SESSION_DIR"`], {
      encoding: 'utf8',
    });
    assert.equal(echoed, run.sessionDir, `the shell read ${JSON.stringify(dir)} as ${JSON.stringify(echoed)}`);
  }
);

// setup reaches the human's own session to list vaults and mint a token. If that
// session's key is not reachable from this process, pass-cli does not merely
// fail — measured 2026-08-24, it logs that session out. These three pin that the
// warning fires on the hazard, stays quiet otherwise, and stops before any of it.
const LINUX_KEYRING = { processEnv: {}, platform: 'linux' };

test('a keyring key provider is warned about before anything reaches the human session', async () => {
  const run = harness({ answers: ['n'] });
  const result = await runSetup({ ...run.options, ...LINUX_KEYRING });
  assert.equal(result.ok, false);
  assert.match(run.output(), /forced logout/i, 'the warning names what it costs');
  assert.match(run.output(), /PROTON_PASS_KEY_PROVIDER=fs/, 'and the fix');
  // The point of warning first: only the harmless --version has run.
  assert.equal(run.calls().length, 1, 'nothing may reach the human session before the answer');
  assert.equal(created(run.calls()), undefined);
});

test('the warning can be overridden, because a working keyring is not a hazard', async () => {
  // A Linux desktop with gnome-keyring is fine, and this check cannot tell that
  // apart without making the very call that would do the damage. So it asks.
  const run = harness({ answers: ['y', ...ANSWERS] });
  assert.equal((await runSetup({ ...run.options, ...LINUX_KEYRING })).ok, true);
  assert.ok(created(run.calls()), 'answering yes carries on');
});

test('a filesystem key provider triggers no warning at all', async () => {
  // Without this the warn branch is the only one ever taken, and the check could
  // fire unconditionally while every assertion above stayed green.
  const run = harness();
  const result = await runSetup({ ...run.options, processEnv: { PROTON_PASS_KEY_PROVIDER: 'fs' }, platform: 'linux' });
  assert.equal(result.ok, true);
  assert.doesNotMatch(run.output(), /forced logout/i);
  assert.equal(run.asked.filter((q) => /Continue anyway/.test(q)).length, 0, 'and asks nothing extra');
});

test('without a terminal the hazard stops the run instead of asking', async () => {
  const run = harness();
  delete run.options.ask;
  const result = await runSetup({ ...run.options, ...LINUX_KEYRING });
  assert.equal(result.ok, false);
  assert.equal(run.calls().length, 1, 'no vault list, no token');
});
