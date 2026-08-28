#!/usr/bin/env node
/**
 * Two modes, decided by argv:
 *   no arguments   -> plugin mode: one JSON request on stdin, one response on stdout
 *   a subcommand   -> human CLI: setup, doctor, skill install, --version
 * The plugin path never parses arguments. The CLI path reads stdin in exactly one
 * place — `setup`'s prompts — and only when stdin is a terminal, which a request
 * from agent-browser never is.
 */
import { ok, fail, parseRequest } from './protocol.js';
import { resolveCredential } from './credential.js';
import { runDoctor, formatReport } from './doctor.js';
import { runSetup } from './setup.js';
import { installSkill } from './skill-install.js';
import { runFillCommands } from './fill-commands.js';

const MANIFEST = {
  name: 'proton-pass',
  capabilities: ['credential.read'],
  description: 'Resolve credentials from Proton Pass via pass-cli',
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function runPlugin() {
  let response;
  try {
    const { type, request } = parseRequest(await readStdin());
    if (type === 'plugin.manifest') {
      response = ok('manifest', MANIFEST);
    } else if (type === 'credential.resolve') {
      response = ok('credential', await resolveCredential(request));
    } else {
      response = fail(`Unsupported request type "${type}".`);
    }
  } catch (error) {
    response = fail(error.message);
  }
  // agent-browser can be gone before the answer is written — killed, timed out,
  // or a daemon restarted while up to four pass-cli calls were in flight. The
  // write then raises EPIPE on a stream nothing is listening to, and Node's
  // default for that is a full stack trace on stderr and a non-zero exit: the
  // one stream this plugin guarantees stays empty on every path. Nobody is left
  // to read the answer, so there is nothing to do but stop quietly.
  process.stdout.on('error', (error) => {
    if (error.code !== 'EPIPE') throw error;
  });
  process.stdout.write(JSON.stringify(response));
}

async function runCli(argv) {
  const [command, ...rest] = argv;
  if (command === '--version' || command === '-v') {
    const { version } = JSON.parse(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(new URL('../package.json', import.meta.url), 'utf8')
      )
    );
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (command === 'setup') {
    return (await runSetup()).ok ? 0 : 1;
  }
  if (command === 'doctor') {
    const report = await runDoctor();
    // The report is already an object; --json lets an agent check its own
    // footing and react precisely instead of parsing prose.
    process.stdout.write(rest.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    return report.ok ? 0 : 1;
  }
  if (command === 'fill-commands') {
    // The credential leaves on stdout so it can be piped into `agent-browser
    // batch`, which reads its commands from stdin — the one route into a form
    // that keeps a value out of argv when `auth login` cannot be used.
    const { code, stdout, stderr } = await runFillCommands(rest);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    return code;
  }
  if (command === 'skill' && rest[0] === 'install') {
    // Accept both `--agent codex` and `--agent=codex`; a `--agent` with no
    // value is a usage error, not a silent fall-through to the default.
    const eqForm = rest.find((arg) => arg.startsWith('--agent='));
    if (eqForm) return installSkill(eqForm.slice('--agent='.length));
    const flagIndex = rest.indexOf('--agent');
    if (flagIndex === -1) return installSkill('claude');
    const value = rest[flagIndex + 1];
    if (value === undefined) {
      process.stderr.write('--agent requires a value: claude or codex\n');
      return 1;
    }
    return installSkill(value);
  }
  // `--help` is a question answered, not a usage error: it exits 0. A typo like
  // `doctorr` reaches the same text but exits 1, so a script can tell them apart.
  const askedForHelp = command === '--help' || command === '-h' || command === 'help';
  process.stdout.write(
    'agent-browser-plugin-proton-pass\n\n' +
      '  (no arguments)         plugin mode — reads one JSON request on stdin\n' +
      '  setup                  interactive: choose vaults, create the token, write the env file\n' +
      '  doctor [--json]        check pass-cli, session, vault access and platform\n' +
      '  fill-commands --item <ref> --password-selector <css> [...]\n' +
      '                         emit agent-browser batch commands on stdout; pipe into: agent-browser batch\n' +
      '  skill install [--agent claude|codex]  install the agent skill (default: claude)\n' +
      '  --version\n'
  );
  return command && !askedForHelp ? 1 : 0;
}

// A bare invocation on a terminal is a human who typed the name, not agent-browser
// piping a request: waiting on stdin there would hang with no output and no prompt.
if (process.argv.length <= 2 && !process.stdin.isTTY) {
  await runPlugin();
} else {
  // Not process.exit(): stdout is asynchronous for pipes on macOS and exit()
  // does not flush it, which would truncate `doctor --json` mid-object.
  process.exitCode = await runCli(process.argv.slice(2));
}
