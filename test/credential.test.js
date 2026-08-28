import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveCredential } from '../src/credential.js';
import { fakePassCliBin, fakeSequenceEnv } from './fixtures/fake-bin.js';

const FAKE = fakePassCliBin();

/** @param {string[]} modes */
const seq = (modes) => ({ bin: FAKE, env: fakeSequenceEnv(modes) });

/**
 * How often the fake was actually run. The sequence state file counts every
 * invocation, so this is the audit-entry claim measured rather than assumed.
 * @param {{env: {FAKE_PASS_CLI_SEQUENCE: string}}} call
 */
const invocations = (call) => JSON.parse(readFileSync(call.env.FAKE_PASS_CLI_SEQUENCE, 'utf8')).index;

// The TOTP shape, measured 2026-08-20 against pass-cli 2.3.2 on a real login with
// 2FA: `item totp --output json` answers {"totp": "<six digits>", "totp_uri":
// "<the same six digits>"}. The parser read `totp.totp.code` instead, which on
// that answer is undefined, so every real code was dropped in silence — the
// credential resolved, agent-browser filled username and password, and the 2FA
// field stayed empty with no error on any stream. The fake agreed with the wrong
// shape, so no test could notice.
test('a resolved login carries username, password and TOTP', async () => {
  const credential = await resolveCredential(
    { profileName: 'gmx', itemRef: 'GMX', url: 'https://www.gmx.net/login' },
    seq(['vaults', 'items', 'item-view', 'totp'])
  );
  assert.equal(credential.username, 'user@gmx.de');
  assert.equal(credential.password, 'correct-horse-battery');
  assert.equal(credential.totp, '123456');
  // The request's URL, not the item's stored root. agent-browser 0.34.0
  // navigates to whatever comes back and resolves again there, so returning
  // the item's https://www.gmx.net/ would steer the browser off the login
  // page and cost a second audit entry. The request only carries a URL when
  // the human passed --url; that is exactly why --url is documented.
  assert.equal(credential.url, 'https://www.gmx.net/login');
});

test('an item with no stored URL answers with the requested one', async () => {
  // agent-browser rejects a credential with no URL at all ("Credential has no
  // URL"), so an item saved without one must not resolve into a dead end —
  // as long as the login passed --url.
  const credential = await resolveCredential(
    { profileName: 'gh', itemRef: 'GitHub', url: 'http://127.0.0.1:8731/' },
    seq(['vaults', 'items', 'item-view-notp'])
  );
  assert.equal(credential.url, 'http://127.0.0.1:8731/');
});

test('a request without a URL falls back to the item URL', async () => {
  const credential = await resolveCredential(
    { profileName: 'gmx', itemRef: 'GMX' },
    seq(['vaults', 'items', 'item-view', 'totp'])
  );
  assert.equal(credential.url, 'https://www.gmx.net/');
});

test('an explicit null URL — what agent-browser actually sends — falls back too', async () => {
  // Captured verbatim from agent-browser 0.34.0 during an `auth login` without
  // --url: {"itemRef":"GitHub","profileName":"probe","url":null}. The key is
  // present and null, so null is the common shape rather than an edge case,
  // and it must reach the fallback instead of becoming a null `url` field.
  const credential = await resolveCredential(
    { profileName: 'gmx', itemRef: 'GMX', url: null },
    seq(['vaults', 'items', 'item-view', 'totp'])
  );
  assert.equal(credential.url, 'https://www.gmx.net/');
});

test('neither a request nor an item URL omits the field entirely', async () => {
  const credential = await resolveCredential(
    { profileName: 'gh', itemRef: 'GitHub' },
    seq(['vaults', 'items', 'item-view-notp'])
  );
  assert.equal(credential.url, undefined);
  assert.ok(!('url' in credential), 'url must be absent, not present-and-empty');
});

test('an item without a TOTP field omits totp instead of failing', async () => {
  // The lenient half of the spec's rule, and the only half it covers: "an item
  // without a TOTP secret simply resolves without one". The strict branch added
  // below must stay out of reach of this path, and the call recorder is what
  // proves it — no `item totp` runs at all, so nothing can fail to be read.
  const call = seq(['vaults', 'items', 'item-view-notp']);
  const credential = await resolveCredential({ profileName: 'gh', itemRef: 'GitHub' }, call);
  assert.equal(credential.password, 'hunter2hunter2');
  assert.equal(credential.totp, undefined);
  const argvs = JSON.parse(readFileSync(call.env.FAKE_PASS_CLI_SEQUENCE, 'utf8')).calls.map((one) => one.argv);
  assert.equal(
    argvs.some((/** @type {string[]} */ argv) => argv[0] === 'item' && argv[1] === 'totp'),
    false,
    'an item with no TOTP secret must not cost a second audit entry'
  );
});

// A string is not yet a code, and the accepted branch is where that matters:
// whatever passes here is what agent-browser types into the page. The third case
// is the reason the check is not merely tidiness — `totp` and `totp_uri` were
// measured carrying the same value, so a pass-cli that put the URI in both would
// hand the TOTP *shared secret* to the browser. Refusing it in one field and not
// the other would have been an asymmetry with a real hazard behind it.
//
// The measured happy path is asserted by the first test in this file, against
// this same `totp` mode; these three are what had no cover at all.
for (const [mode, answer] of [
  ['totp-empty', 'an empty string'],
  ['totp-padded', 'a code padded with whitespace'],
  ['totp-uri-answer', 'an otpauth:// URI where the code belongs'],
]) {
  test(`a TOTP answer carrying ${answer} is refused, not typed into the page`, async () => {
    await assert.rejects(
      () =>
        resolveCredential(
          { profileName: 'gmx', itemRef: 'GMX' },
          seq(['vaults', 'items', 'item-view', mode])
        ),
      (/** @type {Error} */ error) => {
        assert.match(error.message, /no code/i);
        // The URI case carries a TOTP secret. An error that echoed the answer
        // would put it in the agent's transcript — worse than the empty field
        // this whole branch exists to prevent.
        assert.equal(error.message.includes('secret=ABC'), false, 'and never echo the answer');
        return true;
      }
    );
  });
}

test('the {code} object shape is still accepted', async () => {
  // Defensive only: no measured pass-cli version answers this way. It costs one
  // ternary, and the cheapest way to be wrong twice is to replace one guess with
  // another.
  const credential = await resolveCredential(
    { profileName: 'gmx', itemRef: 'GMX' },
    seq(['vaults', 'items', 'item-view', 'totp-object'])
  );
  assert.equal(credential.totp, '123456');
});

test('a TOTP call that answers without a readable code fails loudly', async () => {
  // The item declares a TOTP secret and the call succeeded, so this is schema
  // drift, not a missing secret — the same fault the password check throws for.
  // Resolving without the code is what just happened against a real account, and
  // it is invisible: the browser fills two fields of three and the login fails
  // somewhere the agent cannot diagnose.
  await assert.rejects(
    () =>
      resolveCredential(
        { profileName: 'gmx', itemRef: 'GMX' },
        seq(['vaults', 'items', 'item-view', 'totp-alien'])
      ),
    (/** @type {Error} */ error) => {
      assert.match(error.message, /no code/i, 'the message must name what was missing');
      assert.match(error.message, /JSON shape/, 'and name schema drift, as the password check does');
      assert.match(error.message, /pass-cli item totp/, 'and name the command that shows the shape');
      // The alien answer carries six digits under `totp_uri`. An error that
      // relayed the response body would put them in the agent's transcript.
      assert.equal(error.message.includes('123456'), false, 'and carry no part of the answer');
      return true;
    }
  );
});

test('a filled username field wins over the email field', async () => {
  // Proton Pass login items carry both; whichever the human filled in is the
  // one the site expects.
  const credential = await resolveCredential(
    { profileName: 'portal', itemRef: 'GMX' },
    seq(['vaults', 'items', 'item-view-user'])
  );
  assert.equal(credential.username, 'preferred-user');
});

test('an unexpected item shape fails loudly instead of returning nothing', async () => {
  // Schema drift in a future pass-cli must not degrade into a silent empty
  // credential that agent-browser would type as an empty password.
  await assert.rejects(
    () => resolveCredential({ profileName: 'gmx', itemRef: 'GMX' }, seq(['vaults', 'items', 'item-view-alien'])),
    /no password/i
  );
});

test('an ambiguous item reference names the candidates', async () => {
  await assert.rejects(
    () => resolveCredential({ profileName: 'gmx', itemRef: 'GM' }, seq(['vaults', 'items'])),
    /GMX, GMX Business/
  );
});

// The README and CHANGELOG both promise "one audit entry per login, or two when
// 2FA is involved". Only `item view` and `item totp` are audited, so the whole
// claim rests on the exact number of calls — a stray one would cost a real audit
// entry and pass every other test in this file unnoticed.
test('a login without TOTP costs exactly three pass-cli calls', async () => {
  const call = seq(['vaults', 'items', 'item-view-notp']);
  await resolveCredential({ profileName: 'gh', itemRef: 'GitHub' }, call);
  assert.equal(invocations(call), 3, 'vault list, item list, item view — and no item totp');
});

test('a login with TOTP costs exactly four pass-cli calls', async () => {
  const call = seq(['vaults', 'items', 'item-view', 'totp']);
  await resolveCredential({ profileName: 'gmx', itemRef: 'GMX' }, call);
  assert.equal(invocations(call), 4, 'vault list, item list, item view, item totp');
});

test('a trailing slash is not silently downgraded to a URL-only match', async () => {
  // "Automation/" names a vault and no title. Splitting it would leave an empty
  // reference, and the URL would then select an item from *any* vault — whose
  // password agent-browser would type. An error naming the candidates is the only
  // safe answer.
  await assert.rejects(
    () =>
      resolveCredential(
        { profileName: 'x', itemRef: 'Automation/', url: 'https://github.com/login' },
        seq(['vaults', 'items', 'item-view-notp'])
      ),
    /Could not identify a single Proton Pass item for "Automation\/"/
  );
});

test('a title containing a slash is not mistaken for a Vault/Title reference', async () => {
  // No vault is called "AWS", so "AWS/Prod" is a title. Looking it up by its
  // suffix instead would collide with "Prod Backup" and be unresolvable.
  const credential = await resolveCredential(
    { profileName: 'aws', itemRef: 'AWS/Prod' },
    seq(['vaults', 'items', 'item-view-notp'])
  );
  assert.equal(credential.password, 'hunter2hunter2');
});

test('the ambiguity message names Vault/Title as the way out', async () => {
  await assert.rejects(
    () => resolveCredential({ profileName: 'gmx', itemRef: 'GM' }, seq(['vaults', 'items'])),
    /Vault\/Title/
  );
});

test('a pass:// URI skips discovery and views the item directly', async () => {
  // Two fake responses only: no vault list, no item list — the URI is already exact.
  const credential = await resolveCredential(
    { profileName: 'gmx', itemRef: 'pass://share-1/item-1' },
    seq(['item-view', 'totp'])
  );
  assert.equal(credential.password, 'correct-horse-battery');
});

test('a pass:// URI from another session names the share mismatch, not a status code', async () => {
  // A human copies the URI out of their own `pass-cli` session; the agent token
  // holds a different share id for the same vault, so Proton answers 422. Relayed
  // verbatim that reads as "Invalid status code: 422 Unprocessable Entity", which
  // tells the agent neither what is wrong nor where the right id comes from.
  await assert.rejects(
    () => resolveCredential({ profileName: 'gmx', itemRef: 'pass://share-1/item-1' }, seq(['foreign-share'])),
    (/** @type {Error} */ error) => {
      assert.match(error.message, /share id/i);
      assert.match(error.message, /item list/);
      // The reference is not a secret, and naming it is what makes the message
      // actionable when several are in play.
      assert.match(error.message, /pass:\/\/share-1\/item-1/);
      return true;
    }
  );
});

test('a dead session during a resolve is healed once, not once per call', async () => {
  // Four calls go through one options object here, and doctor's three go through
  // another. One dead session must cost one logout and one login, not one per
  // call — the extra `item view` audit entry is the wanted cost, four logouts
  // would not be.
  const call = {
    bin: FAKE,
    env: {
      ...fakeSequenceEnv(['dead-session', 'logout', 'login', 'vaults', 'items', 'item-view', 'totp']),
      PROTON_PASS_SESSION_DIR: '/nonexistent/proton-pass-agent',
      PROTON_PASS_KEY_PROVIDER: 'fs',
      PROTON_PASS_PERSONAL_ACCESS_TOKEN: 'pst_test::key',
    },
  };
  const credential = await resolveCredential({ profileName: 'gmx', itemRef: 'GMX' }, call);
  assert.equal(credential.password, 'correct-horse-battery', 'the login still resolves');
  const argvs = JSON.parse(readFileSync(call.env.FAKE_PASS_CLI_SEQUENCE, 'utf8')).calls.map((one) => one.argv);
  assert.equal(argvs.filter((argv) => argv[0] === 'logout').length, 1);
  assert.equal(invocations(call), 7, 'the four calls a TOTP login costs, plus logout, login and the one retry');
});

// The destination is the one part of a request an agent writes freely, and
// agent-browser navigates to whatever the credential carries. Naming a real item
// and pointing --url somewhere else is therefore a way to have a vault password
// typed into a page of the agent's choosing — the value never passes through the
// agent, and the guarantee about transcripts still holds, while the password is
// gone anyway. The item's own `urls` are the vault's record of where it belongs.
test('an item is refused for a site it was not stored for', async () => {
  const call = seq(['vaults', 'items', 'item-view']);
  await assert.rejects(
    () =>
      resolveCredential(
        { profileName: 'gmx', itemRef: 'GMX', url: 'https://evil.example/collect' },
        call
      ),
    (/** @type {Error} */ error) => {
      assert.match(error.message, /evil\.example/, 'the message names where the login was pointed');
      assert.match(error.message, /gmx\.net/, 'and where the item actually belongs');
      assert.equal(error.message.includes('correct-horse-battery'), false, 'and never the value');
      return true;
    }
  );
  // The refusal has to land before the code is fetched: an item totp here would
  // be a second audit entry bought for a login that is not going to happen.
  assert.equal(invocations(call), 3, 'vault list, item list, item view — and no item totp');
});

test('a pass:// reference is bound to the item site as well', async () => {
  // The URI path skips discovery entirely, so a check living beside the matcher
  // would leave the shortest route to a credential unbound.
  await assert.rejects(
    () =>
      resolveCredential(
        { profileName: 'gmx', itemRef: 'pass://share-1/item-1', url: 'https://evil.example/collect' },
        seq(['item-view'])
      ),
    /not saved for/
  );
});

test('a login page on a subdomain of the item site is not refused', async () => {
  // Compared by registrable domain, not by host: a stored URL is usually the
  // site root while the login form sits on a subdomain or a path. Refusing that
  // would break the flow the README documents.
  const credential = await resolveCredential(
    { profileName: 'gmx', itemRef: 'GMX', url: 'https://login.gmx.net/portal' },
    seq(['vaults', 'items', 'item-view', 'totp'])
  );
  assert.equal(credential.password, 'correct-horse-battery');
  assert.equal(credential.url, 'https://login.gmx.net/portal');
});

test('an item that stores no URL is bound to nothing and resolves anywhere', async () => {
  // The documented residual, pinned so it stays a decision rather than becoming
  // one by accident: with no stored URL there is nothing to compare against, and
  // this is the flow where --url is the only URL there is.
  const credential = await resolveCredential(
    { profileName: 'gh', itemRef: 'GitHub', url: 'https://anything.example/login' },
    seq(['vaults', 'items', 'item-view-notp'])
  );
  assert.equal(credential.url, 'https://anything.example/login');
});

test('the no-password error describes the shape without quoting it', async () => {
  // The object this fires on is one the parser did not understand, so what it
  // holds is unknown — here a TOTP secret sitting where the password was. An
  // error built from JSON.stringify(login) would put that in the agent's
  // transcript, which is the one thing this plugin exists to prevent.
  await assert.rejects(
    () => resolveCredential({ profileName: 'gmx', itemRef: 'GMX' }, seq(['vaults', 'items', 'item-view-nopw'])),
    (/** @type {Error} */ error) => {
      assert.match(error.message, /no password/i);
      assert.equal(error.message.includes('secret=ABC'), false, 'the TOTP secret must not be quoted');
      assert.equal(error.message.includes('correct-horse-battery'), false, 'nor anything else it found');
      return true;
    }
  );
});

test('an answer that does not parse is reported without quoting pass-cli stdout', async () => {
  // stdout is where pass-cli prints values: on `item view` it is the whole item.
  // Relaying it into the sentence the agent reads would be a full leak through
  // an error path, and the merge gate cannot see it — that test scans stderr.
  await assert.rejects(
    () => resolveCredential({ profileName: 'gmx', itemRef: 'GMX' }, seq(['not-json-secret'])),
    (/** @type {Error} */ error) => {
      assert.match(error.message, /not valid JSON/);
      assert.equal(error.message.includes('correct-horse-battery'), false, 'no part of stdout may be relayed');
      return true;
    }
  );
});

test('a non-string itemRef answers with a sentence, not a TypeError', async () => {
  // The request crosses a process boundary. `(request.itemRef ?? '').trim()`
  // answered a numeric one with "…trim is not a function", which then became the
  // protocol error — a JavaScript backtrace where a fix belongs.
  await assert.rejects(
    () => resolveCredential({ profileName: 'gmx', itemRef: 42 }, seq(['vaults', 'items'])),
    (/** @type {Error} */ error) => {
      assert.doesNotMatch(error.message, /is not a function|undefined/i);
      assert.match(error.message, /Could not identify a single Proton Pass item/);
      return true;
    }
  );
});

test('urls arriving as a bare string yields no URL rather than its first character', async () => {
  // Without the Array.isArray guard, indexing a string hands agent-browser "h".
  const credential = await resolveCredential(
    { profileName: 'gh', itemRef: 'GitHub' },
    seq(['vaults', 'items', 'item-view-urlstr'])
  );
  assert.equal(credential.password, 'hunter2hunter2');
  assert.ok(!('url' in credential), `url must be absent, got ${JSON.stringify(credential.url)}`);
});

test('a token granted no vault gets the sentence that names the grant command', async () => {
  await assert.rejects(
    () => resolveCredential({ profileName: 'gmx', itemRef: 'GMX' }, seq(['vaults-none'])),
    /No Proton Pass vault is reachable.*agent access grant/
  );
});

test('the audited calls carry the arguments the audit claim rests on', async () => {
  // `--output json` is what makes the answer parseable at all, and
  // `--filter-state active` is what keeps a trashed item out of the match. Both
  // can be deleted without any other test noticing, because the fake answers by
  // mode rather than by argv.
  const call = seq(['vaults', 'items', 'item-view-notp']);
  await resolveCredential({ profileName: 'gh', itemRef: 'GitHub' }, call);
  const argvs = JSON.parse(readFileSync(call.env.FAKE_PASS_CLI_SEQUENCE, 'utf8')).calls.map((one) => one.argv);
  assert.deepEqual(argvs[1], [
    'item', 'list', '--share-id=share-1',
    '--filter-type', 'login', '--filter-state', 'active', '--output', 'json',
  ]);
  assert.deepEqual(argvs[2], ['item', 'view', '--share-id=share-1', '--item-id=item-2', '--output', 'json']);
});

test('an id that begins with a dash is bound to its flag, not read as one', async () => {
  // Measured 2026-08-26 against a real vault: `share_id` began `-re6…`, and
  // passed as its own argument pass-cli answered `error: unexpected argument
  // '-r' found` — for every item in that vault. A share id is minted per token,
  // so this is a lottery a token loses about once in sixty-four, and it loses it
  // obscurely: the message names nothing the caller did.
  const call = seq(['vaults-dashed', 'items', 'item-view-notp']);
  await resolveCredential({ profileName: 'gh', itemRef: 'GitHub' }, call);
  const argvs = JSON.parse(readFileSync(call.env.FAKE_PASS_CLI_SEQUENCE, 'utf8')).calls.map((one) => one.argv);
  const listing = argvs[1];
  assert.ok(
    listing.includes('--share-id=-rDASHED'),
    `the id must ride on its flag, got ${JSON.stringify(listing)}`
  );
  assert.equal(
    listing.some((argument) => argument === '-rDASHED'),
    false,
    'and must never stand alone, where a parser reads it as a flag'
  );
});
