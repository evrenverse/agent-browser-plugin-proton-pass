import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchItems, registrableDomain } from '../src/resolver.js';

const ITEMS = [
  { id: 'item-1', share_id: 'share-1', title: 'GMX', item_type: 'login' },
  { id: 'item-2', share_id: 'share-1', title: 'GitHub', item_type: 'login' },
  { id: 'item-3', share_id: 'share-1', title: 'GMX Business', item_type: 'login' },
  { id: 'item-4', share_id: 'share-1', title: 'Retired Note', item_type: 'note' },
];

test('registrableDomain strips the subdomain', () => {
  assert.equal(registrableDomain('https://www.gmx.net/login'), 'gmx.net');
  assert.equal(registrableDomain('https://github.com'), 'github.com');
  assert.equal(registrableDomain('not a url'), null);
});

test('an exact title match wins even when a prefix match also exists', () => {
  const { matched } = matchItems(ITEMS, { itemRef: 'GMX' });
  assert.equal(matched.id, 'item-1');
});

test('title matching ignores case', () => {
  const { matched } = matchItems(ITEMS, { itemRef: 'github' });
  assert.equal(matched.id, 'item-2');
});

test('an ambiguous reference matches nothing and reports the candidates', () => {
  const { matched, candidates } = matchItems(ITEMS, { itemRef: 'GM' });
  assert.equal(matched, null);
  assert.deepEqual(candidates, ['GMX', 'GMX Business']);
});

test('an unknown reference lists every available title', () => {
  const { matched, candidates } = matchItems(ITEMS, { itemRef: 'Nextcloud' });
  assert.equal(matched, null);
  assert.deepEqual(candidates, ['GMX', 'GitHub', 'GMX Business']);
});

test('without an itemRef the URL host is matched against titles', () => {
  const { matched } = matchItems(ITEMS, { url: 'https://github.com/login' });
  assert.equal(matched.id, 'item-2');
});

test('an ambiguous domain match reports both candidates instead of guessing', () => {
  const { matched, candidates } = matchItems(ITEMS, { url: 'https://www.gmx.net/' });
  assert.equal(matched, null);
  assert.deepEqual(candidates, ['GMX', 'GMX Business']);
});

test('a non-login item is filtered out and never matched or listed as a candidate', () => {
  const { matched, candidates } = matchItems(ITEMS, { itemRef: 'Retired Note' });
  assert.equal(matched, null);
  assert.deepEqual(candidates, ['GMX', 'GitHub', 'GMX Business']);
});

test('a multi-part-suffix host never lets an unrelated title win by substring', () => {
  // Regression test: registrableDomain('https://portal.example.co.uk/login') naively
  // returns 'co.uk', so the derived label is 'co' — a substring of 'amazon.com' but not
  // one of its tokens. Token matching must reject this instead of silently matching.
  const items = [{ id: 'item-x', share_id: 'share-1', title: 'Amazon.com', item_type: 'login' }];
  const { matched, candidates } = matchItems(items, { url: 'https://portal.example.co.uk/login' });
  assert.equal(matched, null);
  assert.deepEqual(candidates, ['Amazon.com']);
});

test('a short title does not win by being a substring of the reference', () => {
  // The reverse direction — reference contains title — is only trusted from
  // three characters up. Without that, an item titled "a" is a substring of
  // almost any reference, becomes the single match, and its password is what
  // gets typed for a login that named something else entirely.
  const items = [
    { id: 'item-a', share_id: 'share-1', title: 'a', item_type: 'login' },
    { id: 'item-b', share_id: 'share-1', title: 'Nextcloud', item_type: 'login' },
  ];
  const { matched, candidates } = matchItems(items, { itemRef: 'Company Payroll' });
  assert.equal(matched, null, 'a one-character title must not answer an unrelated reference');
  assert.deepEqual(candidates, ['a', 'Nextcloud']);
});
