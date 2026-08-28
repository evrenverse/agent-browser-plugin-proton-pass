import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL, ok, fail, parseRequest } from '../src/protocol.js';

test('ok() wraps a payload in the protocol envelope', () => {
  const result = ok('manifest', { name: 'proton-pass' });
  assert.equal(result.protocol, PROTOCOL);
  assert.equal(result.success, true);
  assert.deepEqual(result.manifest, { name: 'proton-pass' });
});

test('fail() reports the message and never claims success', () => {
  const result = fail('pass-cli not found');
  assert.equal(result.protocol, PROTOCOL);
  assert.equal(result.success, false);
  assert.equal(result.error, 'pass-cli not found');
});

test('parseRequest() extracts type and request body', () => {
  const parsed = parseRequest('{"protocol":"agent-browser.plugin.v1","type":"plugin.manifest","request":{}}');
  assert.equal(parsed.type, 'plugin.manifest');
  assert.deepEqual(parsed.request, {});
});

test('parseRequest() rejects malformed JSON with a readable message', () => {
  assert.throws(() => parseRequest('not json'), /valid JSON/);
});

test('parseRequest() rejects a non-object JSON body with a sentence, not a TypeError', () => {
  // `null` parses fine, so reading `.protocol` off it used to answer the agent
  // with "Cannot read properties of null" — a backtrace in another language.
  assert.throws(() => parseRequest('null'), /Unsupported protocol/);
  assert.throws(() => parseRequest('42'), /Unsupported protocol/);
});

test('parseRequest() rejects a foreign protocol version', () => {
  assert.throws(
    () => parseRequest('{"protocol":"other.v9","type":"plugin.manifest"}'),
    /agent-browser\.plugin\.v1/
  );
});

test('parseRequest() defaults a missing request body to an object', () => {
  // agent-browser sends one, but the plugin reads a pipe: without the default,
  // every field access downstream is on `undefined` and the agent gets a
  // TypeError instead of a sentence.
  const parsed = parseRequest('{"protocol":"agent-browser.plugin.v1","type":"credential.resolve"}');
  assert.deepEqual(parsed.request, {});
});
