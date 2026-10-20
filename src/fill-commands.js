/**
 * Emit `agent-browser batch` commands that fill a form with a resolved credential.
 *
 * This exists because `auth login` navigates before it fills — unconditionally,
 * even when the browser is already on the target URL (agent-browser 0.35.0,
 * measured; see agent-browser#1728). Where that reload is the problem — a login
 * path that only answers for an in-page arrival, a consent banner that comes
 * back, the second stage of a two-step form — the credential has to reach the
 * page some other way.
 *
 * `agent-browser batch` reads its commands from **stdin**, so it is that other
 * way: the value travels through a pipe and never becomes an argument. This
 * subcommand is the left-hand side of that pipe, and it is squarely this
 * project's business — the same credential the plugin already resolves, shaped
 * as fill commands instead of a protocol response. What stays out of scope is
 * everything about the browser: dismissing consent layers, finding a submit
 * control, clicking it. The plugin has no browser and cannot help there.
 */
import { resolveCredential } from './credential.js';

/** Selectors are addressed by flag; a value is never one of them. */
const FLAGS = {
  '--item': 'itemRef',
  '--url': 'url',
  '--username-selector': 'usernameSelector',
  '--password-selector': 'passwordSelector',
  '--totp-selector': 'totpSelector',
  '--profile': 'profileName',
};

const USAGE =
  'agent-browser-plugin-proton-pass fill-commands --item <ref> <at least one selector>\n' +
  '  selectors: [--username-selector <css>] [--password-selector <css>] [--totp-selector <css>]\n' +
  '  [--url <login page>] [--profile <name>]\n\n' +
  'Writes agent-browser batch commands to stdout. Pipe it:\n' +
  '  … fill-commands --item "GMX" --username-selector "#u" --password-selector "#pw" | agent-browser batch\n';

/**
 * @param {string[]} argv arguments after the subcommand
 * @returns {{options: Record<string,string>, error?: string}}
 */
export function parseArgs(argv) {
  /** @type {Record<string,string>} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inlineValue] = argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], undefined];
    const key = FLAGS[flag];
    if (!key) return { options, error: `Unknown option "${flag}".` };
    const value = inlineValue ?? argv[++i];
    if (value === undefined) return { options, error: `${flag} requires a value.` };
    options[key] = value;
  }
  return { options };
}

/**
 * Build the batch commands for a credential.
 *
 * A field is only filled when both a selector was given and the credential
 * carries that value — a fill with an empty value would clear a field the site
 * had prefilled, and a selector for a field the item does not have is a typo
 * worth surfacing rather than a silent no-op.
 *
 * @param {{username?: string, password?: string, totp?: string}} credential
 * @param {Record<string,string>} options
 * @returns {{commands: Array<string[]>, error?: string}}
 */
export function buildCommands(credential, options) {
  /** @type {Array<string[]>} */
  const commands = [];
  const pairs = [
    ['usernameSelector', 'username'],
    ['passwordSelector', 'password'],
    ['totpSelector', 'totp'],
  ];
  for (const [selectorKey, valueKey] of pairs) {
    const selector = options[selectorKey];
    if (!selector) continue;
    const value = credential[valueKey];
    if (!value) {
      return { commands, error: `${selectorKey.replace('Selector', '')} selector was given, but the item carries no ${valueKey}.` };
    }
    commands.push(['fill', selector, value]);
  }
  return { commands };
}

/**
 * @param {string[]} argv arguments after the subcommand
 * @param {{isTTY?: boolean, resolve?: typeof resolveCredential}} [io]
 * @returns {Promise<{code: number, stdout?: string, stderr?: string}>}
 */
export async function runFillCommands(argv, io = {}) {
  const { options, error } = parseArgs(argv);
  if (error) return { code: 1, stderr: `${error}\n\n${USAGE}` };
  if (!options.itemRef) return { code: 1, stderr: `--item is required.\n\n${USAGE}` };
  if (!options.passwordSelector && !options.usernameSelector && !options.totpSelector) {
    return { code: 1, stderr: `At least one selector is required.\n\n${USAGE}` };
  }
  // The whole point is that the value goes down a pipe. On a terminal it would
  // go on the screen instead, and from there into the scrollback of whoever ran
  // it — so a terminal is refused rather than served.
  if (io.isTTY ?? process.stdout.isTTY) {
    return { code: 1, stderr: 'Refusing to write a credential to a terminal. Pipe this into agent-browser batch.\n' };
  }

  const resolve = io.resolve ?? resolveCredential;
  let credential;
  try {
    credential = await resolve({
      itemRef: options.itemRef,
      url: options.url ?? null,
      profileName: options.profileName ?? 'fill-commands',
    });
  } catch (failure) {
    return { code: 1, stderr: `${failure.message}\n` };
  }

  const built = buildCommands(credential, options);
  if (built.error) return { code: 1, stderr: `${built.error}\n` };
  return { code: 0, stdout: `${JSON.stringify(built.commands)}\n` };
}
