/** Copies SKILL.md into a project's agent skill directory. */
import { mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIRECTORIES = { claude: '.claude/skills', codex: '.codex/skills' };
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'skill', 'SKILL.md');

/**
 * @param {string} agent - "claude" or "codex"
 * @param {string} [projectRoot]
 * @returns {Promise<number>} process exit code
 */
export async function installSkill(agent, projectRoot = process.cwd()) {
  const base = DIRECTORIES[agent];
  if (!base) {
    process.stderr.write(`Unknown agent "${agent}". Supported: ${Object.keys(DIRECTORIES).join(', ')}\n`);
    return 1;
  }
  const targetDir = join(projectRoot, base, 'proton-pass-login');
  await mkdir(targetDir, { recursive: true });
  const target = join(targetDir, 'SKILL.md');
  // Say which of the two happened: a silent overwrite loses whatever the user
  // had edited into the file.
  const verb = existsSync(target) ? 'Overwrote skill at' : 'Installed skill to';
  await copyFile(SOURCE, target);
  process.stdout.write(`${verb} ${join(base, 'proton-pass-login', 'SKILL.md')}\n`);
  return 0;
}
