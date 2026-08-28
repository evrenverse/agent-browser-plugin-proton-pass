import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));

test('plugin.manifest answers with the name and capability that plugin add reads', async () => {
  // `agent-browser plugin add` discovers both from this response. A typo in
  // either breaks registration silently, so it is pinned rather than assumed.
  const response = await new Promise((resolve) => {
    const child = execFile(process.execPath, [ENTRY], (error, stdout) => resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ protocol: 'agent-browser.plugin.v1', type: 'plugin.manifest' }));
  });
  assert.equal(response.protocol, 'agent-browser.plugin.v1');
  assert.equal(response.success, true);
  assert.equal(response.manifest.name, 'proton-pass');
  assert.deepEqual(response.manifest.capabilities, ['credential.read']);
});
