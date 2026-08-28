import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReason } from '../src/reason.js';

test('the reason names the login profile and the host', () => {
  assert.equal(
    buildReason({ profileName: 'gmx', url: 'https://www.gmx.net/login' }),
    'agent-browser login: gmx (www.gmx.net)'
  );
});

test('a missing URL still yields a usable reason', () => {
  // Also the shape agent-browser 0.34.0 sends whenever the login passed no
  // --url: `url: null`, which `if (context.url)` treats exactly like an absent
  // one. The reason then loses its host — the one datum an auditor cannot
  // reconstruct afterwards, and the third documented reason to pass --url.
  // No separate null case: it would exercise this same branch and could not
  // fail on its own.
  assert.equal(buildReason({ profileName: 'gmx' }), 'agent-browser login: gmx');
});

test('a missing profile name falls back to a generic reason', () => {
  assert.equal(buildReason({}), 'agent-browser credential resolution');
});

test('the reason is capped so pass-cli never rejects it for length, and the host survives truncation', () => {
  const reason = buildReason({ profileName: 'x'.repeat(400), url: 'https://example.com' });
  assert.equal([...reason].length, 300);
  assert.ok(reason.startsWith('agent-browser login: '));
  assert.ok(reason.endsWith(' (example.com)'));
});

test('a pathological hostname is still clamped to the cap, losing its own tail', () => {
  // The host is preserved over the profile only while it fits: the budget is
  // 300 − 21 (prefix) − (host + 3), so a host survives intact up to 276
  // characters and is cut from 277 — past anything DNS permits (253), but the
  // README states the boundary, so the cut end is pinned here too.
  const reason = buildReason({ profileName: 'gmx', url: `https://${'a'.repeat(400)}.example.com` });
  assert.equal([...reason].length, 300);
  assert.ok(reason.endsWith('…'), `the host tail must be clamped, got ${JSON.stringify(reason.slice(-20))}`);
});

test('a profile name that is not a string falls back instead of throwing', () => {
  // The request comes from another process, so the field is whatever was sent.
  // `(context.profileName ?? '').trim()` answered a number with a TypeError,
  // which then became the agent's error message.
  assert.equal(buildReason({ profileName: 42 }), 'agent-browser credential resolution');
  assert.equal(buildReason({ profileName: { name: 'gmx' } }), 'agent-browser credential resolution');
});
