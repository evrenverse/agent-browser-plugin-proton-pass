import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPassCli, runPassCliJson } from '../src/pass-cli.js';
import { fakePassCliBin, fakeSequenceEnv, fakeStderrBin } from './fixtures/fake-bin.js';

const FAKE = fakePassCliBin();
const ESC = String.fromCharCode(27);

/** What pass-cli says when its session is gone and the token is not. */
const DEAD = 'pass-cli failed: failed to authenticate: non-existent session';
/** The agent's own session — a directory the fake never touches, and a token. */
const AGENT_DIR = '/nonexistent/proton-pass-agent';
const TOKEN = 'pst_test::key';

/**
 * A pass-cli whose only failure is that something else on the way out expired.
 * Kept out of the shared fixture on purpose: it stands for everything pass-cli
 * relays from underneath it, not for a shape pass-cli itself was measured to
 * produce.
 */
const fakeExpiringCertificate = () =>
  fakeStderrBin(
    'expiring-certificate',
    'Error: Error creating client features\n\nCaused by:\n' +
      '    0: TLS handshake failed\n' +
      '    1: the server certificate expired on 2026-01-01\n'
  );

/**
 * The variable this file asserts the precedence of, removed from every child
 * environment unless a case puts it back. `undefined` deletes rather than
 * empties, the way `setup` reaches the human's session.
 *
 * Without it these tests measure the machine they run on: an ambient
 * PROTON_PASS_AGENT_REASON wins over the plugin's own by design, so a shell that
 * exports one turns five cases below red for a reason that has nothing to do
 * with the code. `test/no-secret-leak.test.js` clears the three session
 * variables for exactly this reason; this is the fourth.
 */
const NO_AMBIENT_REASON = { PROTON_PASS_AGENT_REASON: undefined };

function withMode(mode) {
  return { bin: FAKE, env: { ...NO_AMBIENT_REASON, FAKE_PASS_CLI_MODE: mode } };
}

/**
 * A scripted run of the fake in the agent's own session, with every invocation
 * recorded — argv and the three session variables it saw. `override` puts a
 * variable back to `undefined`, which removes it from the child environment the
 * way `setup` clears the agent's variables to reach the human's session.
 *
 * @param {string[]} modes
 * @param {Record<string,string|undefined>} [override]
 */
function agentRun(modes, override = {}) {
  const sequence = fakeSequenceEnv(modes);
  const options = {
    bin: FAKE,
    env: {
      ...NO_AMBIENT_REASON,
      ...sequence,
      PROTON_PASS_SESSION_DIR: AGENT_DIR,
      PROTON_PASS_KEY_PROVIDER: 'fs',
      PROTON_PASS_PERSONAL_ACCESS_TOKEN: TOKEN,
      ...override,
    },
  };
  return {
    options,
    calls: () => JSON.parse(readFileSync(sequence.FAKE_PASS_CLI_SEQUENCE, 'utf8')).calls ?? [],
    argvs: () => JSON.parse(readFileSync(sequence.FAKE_PASS_CLI_SEQUENCE, 'utf8')).calls.map((call) => call.argv),
  };
}

test('runPassCliJson parses JSON output', async () => {
  const result = await runPassCliJson(['vault', 'list'], withMode('vaults'));
  assert.equal(result.vaults[0].name, 'Automation');
});

test('a missing binary produces an actionable message', async () => {
  await assert.rejects(
    () => runPassCli(['vault', 'list'], { bin: '/nonexistent/pass-cli' }),
    /not found/i
  );
});

test('a missing session is reported as such', async () => {
  await assert.rejects(() => runPassCli(['vault', 'list'], withMode('no-session')), /not logged in/i);
});

test('an expired agent token names the renew command, not the session', async () => {
  // The fixture's stderr carries `requires an authenticated client` too, on the
  // expectation that an expired token is answered with the wrapper every other
  // unauthenticated call gets. That expectation is reasoning, not a measurement —
  // no token has been let expire against this plugin, and the fixture says so —
  // but if it holds, the order of the branches is what decides whether this reads
  // as an expired token or as a session to re-authenticate. Only one of the two
  // remedies works, and renewing is the one no plugin can do.
  await assert.rejects(() => runPassCli(['item', 'view'], withMode('expired')), (error) => {
    assert.match(error.message, /agent renew/);
    assert.doesNotMatch(error.message, /Not logged in/);
    return true;
  });
});

test('a refused audit reason is named as such, not relayed raw', async () => {
  // pass-cli 2.3.2, `item totp` with PROTON_PASS_AGENT_REASON unset, measured
  // 2026-08-20 — and the measurement is the point: this branch matched a string
  // nobody had read, and the fixture now carries the real one. It also settled
  // that `item totp` enforces the variable, not `item view` alone, so both
  // audited calls reach here. The plugin always sets a reason, so seeing this is
  // a bug in the plugin, and it must say so rather than relaying Rust prose.
  await assert.rejects(() => runPassCli(['item', 'totp'], withMode('no-reason')), (error) => {
    assert.match(error.message, /requires an audit reason/);
    assert.doesNotMatch(error.message, /pass-cli failed:/, 'the named branch must win over the relay');
    return true;
  });
});

test('a failure with no stderr still names something actionable', async () => {
  await assert.rejects(
    () => runPassCli(['vault', 'list'], withMode('silent-fail')),
    /pass-cli failed: \S/
  );
});

test('a Rust panic relays its message, not the file position and not the note', async () => {
  // Since Rust 1.73 a panic puts the file position on the first line and the
  // message on the second, so relaying the first line is as useless as relaying
  // the last one.
  await assert.rejects(
    () => runPassCli(['item', 'view'], withMode('multiline-fail')),
    (error) => {
      assert.equal(error.message, 'pass-cli failed: called `Option::unwrap()` on a `None` value');
      return true;
    }
  );
});

test('a coloured failure is relayed without ANSI escape sequences', async () => {
  // pass-cli 2.3.2 colours its stderr even when stderr is not a TTY, and this
  // detail goes straight into the protocol `error` the agent reads. Raw escape
  // sequences there are noise at best and a broken terminal at worst.
  await assert.rejects(
    () => runPassCli(['vault', 'list'], withMode('coloured-fail')),
    (error) => {
      assert.ok(
        !error.message.includes(ESC),
        `escape sequences survived: ${JSON.stringify(error.message)}`
      );
      assert.match(error.message, /^pass-cli failed: .*ERROR.*Vault access was revoked$/);
      return true;
    }
  );
});

test('an undecryptable local database names the key provider, not the hmac line', async () => {
  // The failure an agent hits when it runs in a different login session from the
  // one that logged in: pass-cli's own key is out of reach, so it made a new one.
  await assert.rejects(
    () => runPassCli(['vault', 'list'], withMode('local-key-fail')),
    (error) => {
      assert.match(error.message, /PROTON_PASS_KEY_PROVIDER=fs/);
      assert.match(error.message, /PROTON_PASS_SESSION_DIR/);
      assert.match(error.message, /pass-cli logout --force/);
      assert.doesNotMatch(error.message, /hmac|pgno/i, 'the tracing line explains nothing');
      return true;
    }
  );
});

test('an unrecognised Caused by chain relays its cause, not the tracing line or a backtrace frame', async () => {
  await assert.rejects(
    () => runPassCli(['vault', 'list'], withMode('chain-fail')),
    (error) => {
      assert.equal(
        error.message,
        'pass-cli failed: Request to https://pass-api.proton.me timed out after 30s'
      );
      return true;
    }
  );
});

test('a single unnumbered cause is relayed, not the generic summary above it', async () => {
  // With one cause pass-cli leaves the number off, and the summary above it —
  // `Error: Error creating client features` — is what every failure of this shape
  // announces itself with. The cause is the whole message.
  await assert.rejects(
    () => runPassCli(['vault', 'list'], withMode('single-cause-fail')),
    (error) => {
      assert.equal(
        error.message,
        "pass-cli failed: Invalid PROTON_PASS_KEY_PROVIDER value: 'file'. Valid values are 'fs', 'keyring', or 'env'"
      );
      return true;
    }
  );
});

test('the audit reason travels in the environment, never in argv', async () => {
  const reason = 'agent-browser login: gmx (www.gmx.net)';
  const result = await runPassCliJson(['item', 'view'], {
    ...withMode('echo-env'),
    reason,
  });
  assert.equal(result.reason, reason);
  assert.ok(
    result.argv.every((arg) => !arg.includes(reason)),
    `argv must not carry the reason, got ${JSON.stringify(result.argv)}`
  );
});

test('a reason already set by the caller is respected, not overwritten', async () => {
  const result = await runPassCliJson(['item', 'view'], {
    bin: FAKE,
    env: { FAKE_PASS_CLI_MODE: 'echo-env', PROTON_PASS_AGENT_REASON: 'preset' },
    reason: 'other',
  });
  assert.equal(result.reason, 'preset');
});

test('a dead session is logged back in and the original call retried, in that order', async () => {
  // The failure this exists for: the token still had five days to run, the
  // session behind it did not. Proton's own agent instructions prescribe these
  // three commands under "Auto-recovery from logout".
  const run = agentRun(['dead-session', 'logout', 'login', 'vaults']);
  const result = await runPassCliJson(['vault', 'list', '--output', 'json'], run.options);
  assert.equal(result.vaults[0].name, 'Automation', 'the caller gets the answer, not the error');
  assert.deepEqual(run.argvs(), [
    ['vault', 'list', '--output', 'json'],
    ['logout', '--force'],
    ['login'],
    ['vault', 'list', '--output', 'json'],
  ]);
  // `logout --force` destroys a session and does not ask. What makes it safe is
  // where it points — the agent's own directory, never the default one, which
  // is the human's.
  for (const call of run.calls()) {
    assert.equal(call.env.PROTON_PASS_SESSION_DIR, AGENT_DIR, `${call.argv[0]} ran outside the agent's session`);
    assert.equal(call.env.PROTON_PASS_KEY_PROVIDER, 'fs');
  }
});

test('with no token there is nothing to log in with, so the original error stands', async () => {
  const run = agentRun(['dead-session', 'logout', 'login', 'vaults'], {
    PROTON_PASS_PERSONAL_ACCESS_TOKEN: undefined,
  });
  await assert.rejects(
    () => runPassCli(['vault', 'list'], run.options),
    (error) => {
      assert.equal(error.message, DEAD);
      return true;
    }
  );
  assert.equal(run.calls().length, 1, 'a logout with no way back in leaves the agent worse off than it was');
});

test("without a session directory of the agent's own, nothing is logged out", async () => {
  // The guarantee `setup` establishes for its own `logout --force`, kept here:
  // with PROTON_PASS_SESSION_DIR unset, pass-cli uses its default directory —
  // the human's — so a token alone must never be enough to trigger this.
  const run = agentRun(['dead-session', 'logout', 'login', 'vaults'], { PROTON_PASS_SESSION_DIR: undefined });
  await assert.rejects(() => runPassCli(['vault', 'list'], run.options), (error) => {
    assert.equal(error.message, DEAD);
    return true;
  });
  assert.equal(run.calls().length, 1, "the human's session is not this plugin's to destroy");
});

test('a retry that fails is one failure — the original one, not a pile', async () => {
  // The retry fails differently on purpose. Relaying *its* message would answer
  // a question the caller never asked, about a session rebuilt half a second
  // ago; relaying both would be the pile.
  const run = agentRun(['dead-session', 'logout', 'login', 'chain-fail']);
  await assert.rejects(
    () => runPassCli(['vault', 'list'], run.options),
    (error) => {
      assert.equal(error.message, DEAD);
      return true;
    }
  );
  assert.equal(run.calls().length, 4, 'one logout, one login, one retry — and then it stops');
});

test('an undecryptable local database is not re-authenticated', async () => {
  // A new session cannot fix a key the process cannot reach, and `logout --force`
  // there is the human's own repair, spelled out in the message it already gets.
  const run = agentRun(['local-key-fail', 'logout', 'login', 'vaults']);
  await assert.rejects(() => runPassCli(['vault', 'list'], run.options), /PROTON_PASS_KEY_PROVIDER=fs/);
  assert.equal(run.calls().length, 1, 'no logout, no login, no retry');
});

test('the token reaches the re-login in the environment, never in argv', async () => {
  const run = agentRun(['dead-session', 'logout', 'login', 'vaults']);
  await runPassCliJson(['vault', 'list', '--output', 'json'], run.options);
  for (const call of run.calls()) {
    assert.ok(
      call.argv.every((argument) => !argument.includes(TOKEN)),
      `argv must not carry the token, got ${JSON.stringify(call.argv)}`
    );
  }
  // The tripwire for the assertion above: the token did travel, just not in argv.
  const login = run.calls().find((call) => call.argv[0] === 'login');
  assert.equal(login.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN, TOKEN);
});

test('every audited call after a re-authentication says so in its reason', async () => {
  // The only channel left: stderr is empty on every path by merge gate, and
  // stdout is the protocol. The audit log is where a security-relevant event
  // belongs anyway — `pass-cli agent monitor` shows the read *and* that the
  // session behind it had just been rebuilt.
  const run = agentRun(['dead-session', 'logout', 'login', 'echo-env']);
  const reason = 'agent-browser login: gmx (www.gmx.net)';
  const result = await runPassCliJson(['item', 'view'], { ...run.options, reason });
  assert.equal(result.reason, `[re-authenticated] ${reason}`);
  assert.ok(
    result.argv.every((argument) => !argument.includes('re-authenticated')),
    'the reason stays out of argv, marker and all'
  );
});

test('a reason longer than the audit limit keeps the marker and loses the tail', async () => {
  // pass-cli caps the reason at 300 characters. The marker is what the operator
  // cannot reconstruct from anywhere else, so it goes in front of the clamp.
  const run = agentRun(['dead-session', 'logout', 'login', 'echo-env']);
  const result = await runPassCliJson(['item', 'view'], { ...run.options, reason: 'x'.repeat(400) });
  assert.equal([...result.reason].length, 300);
  assert.ok(result.reason.startsWith('[re-authenticated] '), 'the marker survives truncation');
});

test('one call object gets one re-authentication, however often it is reused', async () => {
  // A resolve makes up to four calls through the same options object, and a
  // doctor run three. One dead session must not become four logouts.
  const run = agentRun(['dead-session', 'logout', 'login', 'vaults', 'dead-session']);
  await runPassCliJson(['vault', 'list', '--output', 'json'], run.options);
  await assert.rejects(() => runPassCli(['vault', 'list'], run.options), (error) => {
    assert.equal(error.message, DEAD);
    return true;
  });
  assert.equal(run.argvs().filter((argv) => argv[0] === 'logout').length, 1);
  assert.equal(run.calls().length, 5, 'the second dead session is reported, not healed a second time');
});

test('a session that was never created heals too, and says so in the reason', async () => {
  // The second dead-session state, and the more reachable one: a clean
  // `logout --force`, a fresh machine where someone sourced the env file and
  // never logged in, or the window inside `setup` between writing that file and
  // the login step. pass-cli spells it differently; the token is sitting right
  // there and the remedy is the same three commands.
  const run = agentRun(['no-session', 'logout', 'login', 'echo-env']);
  const reason = 'agent-browser login: gmx (www.gmx.net)';
  const result = await runPassCliJson(['item', 'view'], { ...run.options, reason });
  assert.deepEqual(run.argvs(), [['item', 'view'], ['logout', '--force'], ['login'], ['item', 'view']]);
  assert.equal(result.reason, `[re-authenticated] ${reason}`, 'the audit log records this state as well');
});

test('a call marked as a probe is never healed, whatever it fails with', async () => {
  // `setup` asks `info` whether a session already exists and reads the failure
  // as the answer "no". A probe that healed itself would answer yes to its own
  // question — and its logout would run against the session `setup` is about to
  // replace. The exclusion belongs at the call site, where it can be read.
  const run = agentRun(['no-session', 'logout', 'login', 'vaults']);
  await assert.rejects(
    () => runPassCli(['info', '--output', 'json'], { ...run.options, probe: true }),
    (error) => {
      assert.equal(error.message, 'Not logged in to Proton Pass. Ask a human to run: pass-cli login');
      return true;
    }
  );
  assert.equal(run.calls().length, 1, 'a probe asks once and takes the answer');
});

test('a logout that fails leaves the original failure standing', async () => {
  const run = agentRun(['dead-session', 'chain-fail']);
  await assert.rejects(() => runPassCli(['vault', 'list'], run.options), (error) => {
    assert.equal(error.message, DEAD);
    return true;
  });
  assert.equal(run.calls().length, 2, 'no login is attempted over a logout that failed');
});

test('a re-login that names its own fix hands that one on', async () => {
  // The re-login is the experiment that tells an expired token from a dead
  // session, and it is the only place that answer exists. Discarding it hands
  // the agent `non-existent session`, which the skill reads as "source the env
  // file, do not renew anything" — the opposite of what an expired token needs.
  const run = agentRun(['dead-session', 'logout', 'expired']);
  await assert.rejects(() => runPassCli(['vault', 'list'], run.options), (error) => {
    assert.match(error.message, /agent renew/);
    assert.doesNotMatch(error.message, /non-existent session/, 'one failure, and the actionable one');
    return true;
  });
});

test('a re-login that only relays stderr does not replace the original failure', async () => {
  // The `pass-cli failed: …` fallback carries pass-cli's own words about a
  // session that no longer exists. It names no fix, so it is not worth
  // displacing the failure the caller's own call produced.
  const run = agentRun(['dead-session', 'logout', 'chain-fail']);
  await assert.rejects(() => runPassCli(['vault', 'list'], run.options), (error) => {
    assert.equal(error.message, DEAD);
    return true;
  });
  assert.equal(run.calls().length, 3);
});

test('the one recovery is spent even when it fails', async () => {
  const run = agentRun(['dead-session', 'logout', 'expired', 'dead-session']);
  await assert.rejects(() => runPassCli(['vault', 'list'], run.options), /agent renew/);
  await assert.rejects(() => runPassCli(['vault', 'list'], run.options), (error) => {
    assert.equal(error.message, DEAD, 'the second call is reported, not healed on a second attempt');
    return true;
  });
  assert.equal(run.argvs().filter((argv) => argv[0] === 'logout').length, 1);
  assert.equal(run.calls().length, 4);
});

test("a reason the caller preset is still marked when the session was rebuilt", async () => {
  // The preset wins as the text — that is the older rule and it stands — but the
  // marker is not the plugin's reason, it is the only record that a session was
  // rebuilt. An operator who sets their own reason must not lose it.
  const run = agentRun(['dead-session', 'logout', 'login', 'echo-env']);
  const result = await runPassCliJson(['item', 'view'], {
    ...run.options,
    env: { ...run.options.env, PROTON_PASS_AGENT_REASON: 'an operator string' },
    reason: 'the plugin would have said this',
  });
  assert.equal(result.reason, '[re-authenticated] an operator string');
});

test('a recovery that failed leaves no [re-authenticated] mark on later calls', async () => {
  // The marker asserts that the session behind a read was rebuilt, so it reads
  // the same set `doctor`'s line does. No caller today can reach this — a failed
  // recovery throws, and the one caller that catches and carries on, `doctor`,
  // files no reason — which is exactly why the claim is pinned here rather than
  // left to the shape of the callers that happen to exist.
  const run = agentRun(['dead-session', 'logout', 'expired', 'echo-env']);
  const options = { ...run.options, reason: 'agent-browser login: gmx (www.gmx.net)' };
  await assert.rejects(() => runPassCli(['vault', 'list'], options), /agent renew/);
  const result = await runPassCliJson(['item', 'view'], options);
  assert.equal(result.reason, 'agent-browser login: gmx (www.gmx.net)', 'nothing was rebuilt, so nothing says so');
});

test('a failure carrying a secret on stdout relays no part of it', async () => {
  // execFile hands the callback both streams. pass-cli prints values on stdout
  // and diagnostics on stderr, so the relay reads stderr — and nothing pins that
  // choice, which is one character away from putting an item into the sentence
  // the agent reads. The merge-gate test cannot catch it either: it scans
  // stderr, and this would travel on stdout.
  await assert.rejects(() => runPassCli(['item', 'view'], withMode('stdout-secret-fail')), (error) => {
    assert.equal(error.message, 'pass-cli failed: the vault could not be opened');
    assert.equal(error.message.includes('correct-horse-battery'), false, 'stdout must not be relayed');
    return true;
  });
});

test('a chain that ends on filler relays its cause, not its deepest entry', async () => {
  // pass-cli chains run from generic wrapper down to concrete cause and then
  // trail off — the measured local-key failure ends `4: Error code 0: not an
  // error`. Taking the last entry would relay exactly that.
  await assert.rejects(() => runPassCli(['vault', 'list'], withMode('filler-chain-fail')), (error) => {
    assert.equal(error.message, 'pass-cli failed: Request to https://pass-api.proton.me timed out after 30s');
    return true;
  });
});

test('something other than a token expiring is not answered with agent renew', async () => {
  // `expired` alone matched anything underneath pass-cli that has a lifetime.
  // Measured against a TLS chain, the bare substring answered `pass-cli agent
  // renew` — a remedy for a token that was fine, and one that also suppresses
  // the re-authentication, since this branch marks no dead session.
  const bin = fakeExpiringCertificate();
  await assert.rejects(() => runPassCli(['vault', 'list'], { bin }), (error) => {
    assert.doesNotMatch(error.message, /agent renew/, 'the token was never the problem');
    assert.match(error.message, /certificate expired/);
    return true;
  });
});

test('the measured no-session stderr classifies as a session, not as a relay', async () => {
  // The shape a real pass-cli 2.3.2 answers with in an empty session directory
  // carries a coloured tracing line, an `Error:` summary, and both matching
  // strings at once. Each of those reaches a different part of `describe`, and
  // the fixture that stood here before had none of them — so the branch this
  // pins was only ever exercised against a line written from reasoning.
  await assert.rejects(() => runPassCli(['vault', 'list'], withMode('no-session')), (error) => {
    assert.equal(error.message, 'Not logged in to Proton Pass. Ask a human to run: pass-cli login');
    assert.equal(error.message.includes(ESC), false, 'and no escape sequence survives');
    assert.doesNotMatch(error.message, /main\.rs|Command is not logout/, 'the tracing line explains nothing');
    return true;
  });
});

test('the wording a real dead token produces is answered with renew, and not re-authenticated', async () => {
  // Measured 2026-08-24: an agent token created with --expiration 1h, used four
  // days later. Until then no run had produced this wording, and the `expired`
  // branch was narrowed on reasoning alone — it now insists the failure names a
  // token, which this does. What it must not do is mark the failure as a dead
  // session: a login cannot fix a token that is gone, and a recovery here would
  // destroy the local state and then fail.
  await assert.rejects(() => runPassCli(['login'], withMode('expired-token-login')), (error) => {
    assert.match(error.message, /agent renew/);
    assert.equal(error.kind, undefined, 'a token that is gone is not a session to rebuild');
    return true;
  });
});

test('a forced logout names the session it hit and the check before re-authenticating', async () => {
  // Measured 2026-08-24, and it cost a real session: run against a directory
  // whose key it could not reach, pass-cli logged that session out. The generic
  // relay would have passed `Forcing logout for security` along as though it
  // were a complaint. It is not — it is an action pass-cli already took.
  //
  // But it took it in the directory *that call* used, and the earlier wording
  // ("the local state is already gone") claimed more than stderr can support.
  // Measured 2026-08-28: setup hit this in a child process, printed the sentence,
  // and a human ran logout --force plus a browser login for a session that was
  // never touched. So the message points at the one-second check first.
  await assert.rejects(() => runPassCli(['agent', 'create'], withMode('forced-logout')), (error) => {
    assert.match(error.message, /logged out the session/, 'the message must say what happened');
    assert.match(error.message, /pass-cli info/, 'and name the cheap check before a web login');
    assert.match(error.message, /PROTON_PASS_KEY_PROVIDER=fs/, 'and name the fix');
    assert.match(error.message, /No vault data is lost/, 'and say what it did not cost');
    assert.doesNotMatch(error.message, /^pass-cli failed:/, 'the named branch must win over the relay');
    // Never a dead session: the recovery would run logout --force against state
    // that pass-cli has already cleared, and then a login that cannot help.
    assert.notEqual(error.kind, 'authentication-failed');
    return true;
  });
});
