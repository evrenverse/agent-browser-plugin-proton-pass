/**
 * Return a path that execFile can run as if it were pass-cli.
 *
 * POSIX: the shebang carries it, so the .js path itself is enough.
 * Windows: .js is not executable, so emit a .cmd shim that forwards to node.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./fake-pass-cli.js', import.meta.url));

export function fakePassCliBin() {
  if (process.platform !== 'win32') {
    chmodSync(SCRIPT, 0o755);
    return SCRIPT;
  }
  const shim = SCRIPT.replace(/\.js$/, '.cmd');
  writeFileSync(shim, `@echo off\r\nnode "${SCRIPT}" %*\r\n`);
  return shim;
}

/**
 * Environment that makes successive fake invocations answer differently, so a
 * test can mirror a real call chain: vault list -> item list -> item view -> totp.
 *
 * This lives in the fixture, not in the plugin: the production code must not
 * carry a parameter that exists only for tests.
 *
 * @param {string[]} modes
 * @returns {{FAKE_PASS_CLI_SEQUENCE: string}}
 */
export function fakeSequenceEnv(modes) {
  const file = join(mkdtempSync(join(tmpdir(), 'fake-pass-cli-')), 'sequence.json');
  writeFileSync(file, JSON.stringify({ modes, index: 0 }));
  return { FAKE_PASS_CLI_SEQUENCE: file };
}

/**
 * A throwaway executable that writes `stderr` and exits 1, for failure shapes
 * that belong to one test rather than to the shared fake — anything pass-cli
 * relays from a layer below it, whose wording is not pass-cli's own.
 *
 * @param {string} name a label, so a failing test names a readable path
 * @param {string} stderr what the process writes before it exits
 * @returns {string} a path execFile can run
 */
export function fakeStderrBin(name, stderr) {
  const dir = mkdtempSync(join(tmpdir(), `fake-${name}-`));
  const script = join(dir, 'fake.js');
  writeFileSync(
    script,
    `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(1);\n`
  );
  // The same split as fakePassCliBin above: a shebang carries a .js file on
  // POSIX, and Windows needs a .cmd that forwards to node.
  if (process.platform !== 'win32') {
    chmodSync(script, 0o755);
    return script;
  }
  const shim = join(dir, 'fake.cmd');
  writeFileSync(shim, `@echo off\r\nnode "${script}" %*\r\n`);
  return shim;
}
