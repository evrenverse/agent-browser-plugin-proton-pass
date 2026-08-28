import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installSkill } from '../src/skill-install.js';

const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));

/** Drive `skill install` through the real CLI entry point, cwd pinned to a temp dir. */
function runCliInstall(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [ENTRY, 'skill', 'install', ...args], { cwd }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr })
    );
  });
}

test('installing for claude writes the skill into .claude/skills', async () => {
  const target = mkdtempSync(join(tmpdir(), 'skill-'));
  const code = await installSkill('claude', target);
  assert.equal(code, 0);
  const written = readFileSync(join(target, '.claude/skills/proton-pass-login/SKILL.md'), 'utf8');
  assert.match(written, /name: proton-pass-login/);
});

test('installing for codex writes the skill into .codex/skills', async () => {
  const target = mkdtempSync(join(tmpdir(), 'skill-'));
  await installSkill('codex', target);
  const written = readFileSync(join(target, '.codex/skills/proton-pass-login/SKILL.md'), 'utf8');
  assert.match(written, /Proton Pass/);
});

test('a second install says it overwrote rather than reporting a fresh install', async () => {
  // The copy is unconditional, so a user's edits to SKILL.md are gone either way;
  // the least the command can do is say so.
  const target = mkdtempSync(join(tmpdir(), 'skill-'));
  const first = await runCliInstall([], target);
  const second = await runCliInstall([], target);
  assert.match(first.stdout, /^Installed skill to /);
  assert.match(second.stdout, /^Overwrote skill at /);
});

test('an unknown agent is rejected with a non-zero code', async () => {
  const target = mkdtempSync(join(tmpdir(), 'skill-'));
  assert.equal(await installSkill('emacs', target), 1);
});

// These three drive `runCli`'s actual argv handling, not `installSkill` directly —
// the `--agent=codex` regression (silently falling back to `claude` with exit 0)
// lived in that argv parsing and was invisible to the tests above.
test('CLI: "skill install" with no --agent defaults to claude', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-cli-'));
  const { code } = await runCliInstall([], cwd);
  assert.equal(code, 0);
  assert.ok(existsSync(join(cwd, '.claude/skills/proton-pass-login/SKILL.md')));
});

test('CLI: "skill install --agent=codex" installs into .codex/skills', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-cli-'));
  const { code } = await runCliInstall(['--agent=codex'], cwd);
  assert.equal(code, 0);
  assert.ok(existsSync(join(cwd, '.codex/skills/proton-pass-login/SKILL.md')));
});

test('CLI: "skill install --agent=emacs" fails instead of silently installing claude', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-cli-'));
  const { code, stderr } = await runCliInstall(['--agent=emacs'], cwd);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown agent "emacs"/);
  assert.equal(existsSync(join(cwd, '.claude/skills/proton-pass-login/SKILL.md')), false);
});
