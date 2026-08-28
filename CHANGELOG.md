# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-08-28

### Added

- `setup` accepts `all` (or `*`) at the vault question, so an account with
  twenty-one vaults needs one word rather than twenty-one numbers. Never a
  default and never preselected; the confirmation still enumerates every vault
  and still defaults to no.

- Credential provider plugin for agent-browser over the `agent-browser.plugin.v1`
  stdio protocol: one JSON request on stdin, one response on stdout, then the
  process exits. Answers `plugin.manifest` and `credential.resolve`.
- Item resolution from a `pass://SHARE_ID/ITEM_ID` URI, a `Vault/Title`
  reference, or a bare `Title`. Without a reference, the registrable domain of
  the request's URL — and its first label — are matched against the tokens of
  each item title, which needs `--url` (see below). Zero or several matches
  produce an error that names the candidate titles.
- **`auth login` should carry `--url <the login page>`.** agent-browser sends the
  plugin `"url": null` unless it does; it never reports the page the browser is
  on. Without `--url` the plugin can only answer with the item's stored URL —
  for a Proton Pass item usually the site root — and agent-browser then navigates
  away from the login form, resolves a second time at the page it lands on, and
  files the audit entry with no hostname in the reason. An item that stores no
  URL at all fails with agent-browser's own `Credential has no URL`.
- One `pass-cli item view` per login, and one `item totp` only when the item
  carries a TOTP secret — **one audit entry per login, two with 2FA, when
  `--url` is passed**, both halves measured against a real account (one entry
  on 2026-08-17, two on 2026-08-20); without it, a stored item URL that differs from the
  current page doubles that, because agent-browser navigates and resolves again.
  A third case since the self-healing below, and a conditional one: a login that
  re-authenticates costs one entry more **only when the call that died was an
  audited one**, since the retry is then a second read. The common case is a
  dead `vault list`, which is not audited and costs nothing extra. Whether the
  re-login itself files a monitor event is unverified. `vault list` and `item list` need no reason and
  leave no audit entry.
- The credential's `url` is the one the request named, falling back to the item's
  first stored URL and omitted when there is neither.
- **A credential is refused for a site the item was not stored for.** The
  request's `url` — the `--url` value — is compared against the item's own stored
  `urls` by registrable domain before anything is handed back, and a mismatch is
  an error naming both sides. Without it, naming a real item and pointing `--url`
  at another host had the password and TOTP typed into a page of the agent's
  choosing: the value never entered the transcript, so every guarantee held, and
  it was gone anyway. Per site rather than per host, so a login page on a
  subdomain still resolves. The check sits where the item becomes a credential,
  not beside the matcher, because a `pass://` reference skips matching. Two
  residuals, both documented: an item that stores no URL is bound to nothing, and
  a multi-part public suffix (`a.co.uk` vs `b.co.uk`) compares equal.
  Measured against a real vault on 2026-08-20: the cross-site resolve was
  refused, the same item resolved for its own site and for a subdomain of it,
  and the refusal was audited with the host it was aimed at — so a blocked
  attempt leaves a signed record naming the destination rather than vanishing.
- An answer nobody is left to read is dropped in silence. agent-browser can be
  gone before the response is written — killed, timed out, a daemon restarted
  mid-resolve — and the write then raised `EPIPE`, whose Node default is a full
  stack trace on the one stream this plugin guarantees stays empty. Now the
  tenth case in `test/no-secret-leak.test.js`.
- Cloudflare turned out to be decided by the stealth build's patch count — the
  58-patch free binary never completed its managed challenge, the 73-patch one
  loaded the site in full. But a **login path is protected separately**, and that
  defeats the documented flow: navigating straight to `/login` drew a fresh
  challenge that never cleared, while clicking through from an already-cleared
  home page reached the real form. `auth login --url` navigates, so it always
  enters cold and fails waiting for the username selector. Nothing here can help
  — agent-browser owns the navigation and offers no mode that fills the page
  already open — so the limitation is stated in the README rather than worked
  around. Akamai's refusal in the earlier run was a VPN exit being blocked, which
  the README now says instead of leaving it as an open question.
- The README names the stealth browser the measurement used and links it, with
  the flags that mattered — and states in the same breath that none of it is a
  recommendation. A patched third-party browser in the slot that types a vault
  password is a threat-model decision, not a detail, and this project cannot
  vouch for a binary from outside anyone's distribution channel. The vendor's
  own pass/fail table is theirs; what is recorded here is one result, one
  machine, one day, four sites, two of which went through. **Nothing in `src/`
  mentions it, and nothing depends on it**: the plugin is spawned by
  agent-browser once the browser already exists, so it cannot configure one even
  in principle, and everything works the same with agent-browser's own Chromium,
  a hosted provider, or an iOS device.
- **A vault id that begins with a dash no longer breaks every lookup in that
  vault.** Base64url allows a leading `-`, and a real vault's `share_id` began
  `-re6…` on 2026-08-26: passed as its own argument, `pass-cli` read it as a
  short flag and answered `error: unexpected argument '-r' found` — for every
  item in that vault, with a message naming nothing the caller did. A share id is
  minted per token, so the same vault resolves fine under a differently-issued
  one; that is why this survived five months of use. Every value that comes from
  the vault now rides on its flag as `--flag=value`, which is the only form that
  works: pass-cli's tip suggests `-- -r`, and `--share-id -- <value>` answers `a
  value is required`. `setup` passes `--vault=<name>` for the same reason, since
  a vault name is a human's to choose.
- **The multi-step limitation is gone, and the documented fallback is no longer the
  best one.** `agent-browser batch` reads its commands from stdin, so a resolved
  value reaches a form without becoming an argument and without the navigation
  `auth login` performs unconditionally. Measured 2026-08-26 against a real
  two-stage shop login — username filled and submitted, password piped in, login
  completed, the value in no `argv` at any point — and against a shop whose submit
  control is a custom element with its real button in a shadow root. The bundled
  skill carries the recipe; the README marks the older `pass-cli run` fallback as
  the weaker path it is, since `bash` expands the value into `argv` before `exec`.
- **Logged into a real bot-protected site end to end, headless**, on 2026-08-26:
  a German B2B shop behind Radware Bot Manager, through `agent-browser auth
  login` → plugin → `pass-cli` → the real vault → the form, landing on the
  account page with the audit entry reading `agent-browser login: hygi
  (www.hygi.de)`. The browser was a patched stealth Chromium handed to
  agent-browser through `--executable-path`, and **the plugin required no change
  at all** — it speaks stdin and stdout, and the browser is on the far side of
  agent-browser. The README now says so, because "why does the login not work"
  usually has its answer one layer down. Two of four shops were reachable this
  way; Cloudflare's challenge never completed and Akamai refuses at the edge
  before a page exists.
- Driven end to end against agent-browser 0.35.0 on 2026-08-26, and three things
  came back that change what the documentation may claim. **agent-browser
  discards the plugin's `error` field and its stderr**, so every message this
  project writes reaches the operator as `✗ Plugin 'proton-pass' returned
  success=false`; the troubleshooting table now says so at the top and is framed
  as the by-hand diagnosis path it actually is. **Its selector heuristic split a
  credential across two forms** — password into the login form, username into a
  newsletter field above it — and then reported success without submitting;
  README and skill now tell callers to pass explicit selectors on any page with
  a second form and to confirm with `agent-browser get url`. And **real shops
  block the browser before a form is reached** (Radware, Cloudflare, outright
  denial on four of four), so the open gap about a real site's login form cannot
  be closed this way. What was validated instead is the link that gap is about:
  a plugin-resolved credential filling a real form and posting the right pair.
  Non-persistence, the request shape and the navigation behaviour were
  re-measured at 0.35.0 and are unchanged.
- **`setup` warns before it touches the human's own session, and refuses without
  a terminal to ask.** It reaches that session to list vaults and mint a token,
  and on Linux without a D-Bus Secret Service the session's database key lives in
  kernel keyutils — where it belongs to the session that made it and evaporates
  with it. pass-cli then finds a database it cannot open and answers with a
  forced logout, taking the login with it. Measured on 2026-08-26 by walking into
  it: `agent create` destroyed a real session. The check reads the environment
  rather than probing, because the probe would be the call that does the damage,
  and it is Linux-only because the macOS keychain does not have this property.
- A forced logout is classified rather than relayed. `Forcing logout for
  security` is not a complaint pass-cli is making, it is an action pass-cli has
  already taken, and the message now says the local state is gone, names
  `PROTON_PASS_KEY_PROVIDER=fs` as the fix, and says what was *not* lost — the
  database is a cache, the vault is untouched. It is never treated as a dead
  session: the recovery would clear state that is already cleared.
- The self-healing session, `doctor` and the whole resolve path were driven
  against a real Proton account on 2026-08-20 for the first time: a session
  destroyed under a live token was rebuilt on the next resolve, the audit entry
  carried `[re-authenticated]`, stderr stayed empty, and the recovery cost no
  extra audit entry because the call that died was `vault list`. Token scoping
  re-measured at one vault of 21.
- A failure is only read as an expired agent token when its stderr names a token
  as well. `expired` alone matched anything underneath `pass-cli` with a lifetime
  of its own: a TLS chain ending in `the server certificate expired on …` was
  answered with `pass-cli agent renew`, a remedy for a token that was fine, and
  one that also suppressed the re-authentication.
- Fields of the request that are not strings are read as absent rather than
  reaching the agent as `(request.itemRef ?? "").trim is not a function`. The
  request crosses a process boundary; a JavaScript backtrace is not a sentence
  naming a fix.
- `pass-cli` stderr is stripped of ANSI escape sequences before any of it is
  relayed in a `pass-cli failed: …` message; 2.3.2 colours it even when stderr
  is not a terminal.
- Audit reasons in the form `agent-browser login: <profile> (<host>)`, passed to
  `pass-cli` in the child environment and never in `argv`, clamped to the CLI's
  300-character limit with the host preserved over the profile name — intact up
  to a 276-character host, beyond which the host itself is cut. The host is
  present only when the login passed `--url`, since that is the only thing that
  puts a URL in the request.
- Errors as plain sentences naming the fix — `pass-cli` missing, no session,
  expired agent token, no vault granted, item not found or ambiguous, item
  without a password — returned as `{"success": false, "error": …}` with exit
  code 0 rather than as a crash.
- A parsed item without a password is a hard error, so schema drift can never
  make agent-browser type an empty password into a form.
- `setup`: one interactive command in place of the five-step manual ritual. It
  lists the vaults the human's own session can see, asks which of them the agent
  may read with **nothing preselected**, repeats the choice back with what it
  grants, and creates no token at all when the answer is empty or the
  confirmation — which defaults to no — is declined. **An agent token grants read
  access to every login in every vault it names**, and that is the decision the
  old sequence never made anyone look at. It then creates the token
  (`--expiration` offered as `1w`, the agent's name as `browser-agent`), writes
  `$HOME/.proton-pass-agent/env` with mode 0600 in a 0700 directory — asking
  first if the file exists, and asking *before* the token is created rather than
  after, so declining cannot strand a live grant nobody holds the token for —
  runs the `pass-cli login` the documentation omitted until 2026-08-17, and ends
  with the `doctor` report and the two commands that follow it. The token is
  never printed and never enters `argv`; it travels in the child environment,
  the way the audit reason does, and reaches disk only in that one file.
- Everything that can fail around the token is ordered so that a failure cannot
  leave one stranded — created on the account, held in no file, and undoable
  only by revoking it. The session directory is made and tightened to 0700
  *before* `agent create`, so an occupied path, a full disk or a permission
  denial surfaces while it still costs nothing. The env file is written beside
  itself and `rename`d into place, which is atomic: the token is never briefly
  readable at whatever mode an older file had, since `writeFile`'s `mode` does
  not apply to a path that already exists. And the two failures that can still
  happen after the token exists — a write that fails, an answer with no readable
  token in it — both say in plain words that a grant nobody holds may now exist
  and that `pass-cli agent list` is where to look.
- `setup` clears a stale agent session before logging in. `pass-cli login`
  refuses a session directory that already holds a session — `Error: Already
  authenticated`, exit 1 — so without this every *second* run failed at the last
  step, after the new token had already been created: a live grant on the
  account and nothing configured to use it. It probes with `pass-cli info`
  rather than matching that wording, and runs `pass-cli logout --force` with the
  agent's own `PROTON_PASS_SESSION_DIR` in the environment, which is the whole
  of what keeps `--force` away from the human's session. A logout that fails
  stops the run and names the directory instead of falling through into a login
  that would fail too, and a cleared session is reported rather than passed over
  in silence — the token it used stays valid on the account until it expires or
  is revoked.
- The plugin re-authenticates itself when it finds the session dead under a
  token that is still valid, instead of stopping at an error nobody is awake to
  read. Measured 2026-08-18: an agent token created with `--expiration 1w`, five
  days of it left, every call in the agent's session answering `failed to
  authenticate: non-existent session` — and `pass-cli logout --force`,
  `pass-cli login`, `pass-cli info` bringing it straight back with the token that
  was in that session's environment all along. Proton prescribes exactly that,
  under "Auto-recovery from logout" in the agent instructions `agent create`
  prints beside the token. The plugin now runs those three steps itself and
  retries the call that failed, **once per request** — a login makes up to four
  `pass-cli` calls and `doctor` three, and one dead session costs one recovery,
  not one per call — and reports the original failure if the retry fails too.
  It fires on either spelling of a failure to authenticate — `failed to
  authenticate: non-existent session`, and the `This operation requires an
  authenticated client` / `there is no session` pair that answers a directory
  no login was ever run in, which is what a clean `logout --force` or a second
  machine with the env file sourced leaves behind. Never on the undecryptable
  local database, which a new login cannot fix. A call can opt out with
  `probe: true`, and `setup`'s `pass-cli info` probe does: its failure is the
  answer it is looking for, not a fault to repair. It needs `PROTON_PASS_PERSONAL_ACCESS_TOKEN` in the
  environment, which is therefore **not only for the first login**, and
  `PROTON_PASS_SESSION_DIR`, which is what keeps `logout --force` — it destroys
  a session and does not ask — provably inside the agent's own directory rather
  than the human's default one. Every audited call after a recovery carries a
  `[re-authenticated]` prefix in its audit reason, ahead of the 300-character
  clamp so truncation cannot eat it: the audit log is where a security-relevant
  event belongs, and with stderr empty on every path and stdout carrying the
  protocol, it is also the only channel left.
- `setup` keeps two sessions apart on purpose. `vault list` and `agent create`
  run in the human's own session, with `PROTON_PASS_SESSION_DIR`,
  `PROTON_PASS_KEY_PROVIDER` and `PROTON_PASS_PERSONAL_ACCESS_TOKEN` actively
  cleared — a shell that has already sourced the env file carries all three, and
  would otherwise list what the previous agent may reach instead of what the
  human has. `login` and `doctor` run in the agent's, with exactly those three
  set. It prompts only when `process.stdin.isTTY`: without a terminal it prints
  the vault list and the commands to run by hand and exits non-zero, so mode
  selection stays argv-based and the plugin path stays unreachable from here.
- `doctor` and `doctor --json`: checks `pass-cli` and its version, vault
  reachability, whether the session is a scoped agent token or a personal one,
  telemetry, and the effective `PROTON_PASS_KEY_PROVIDER` — a warning for a
  keyring, which is also what leaving the variable unset means, a warning for a
  value `pass-cli` does not accept, and a failure once a call has actually hit
  the undecryptable database.
- A named error for the failure an agent hits when it runs outside the login
  session that logged in: `pass-cli`'s key provider defaults to a keyring, a
  keyring key belongs to the session that created it and may not be reachable
  from another — measured on Linux with the kernel keyring — so a process
  elsewhere generates a fresh key and can no longer decrypt the database. The
  message names the setup that avoids it — a `PROTON_PASS_SESSION_DIR` of the
  agent's own plus `PROTON_PASS_KEY_PROVIDER=fs` — instead of relaying
  `hmac check failed for pgno=1`. Reading fails; the human's session files are
  left untouched, checked by their checksums.
- The `pass-cli failed: …` fallback picks the line that carries the cause: the
  longest entry of the numbered run directly under `Caused by:` — only that run,
  since `RUST_BACKTRACE` numbers its frames alike — else the single unnumbered
  line under that header, which is how a lone cause is printed, an invalid
  `PROTON_PASS_KEY_PROVIDER` among them; else the `Error:` summary; else the
  first line that is neither timestamped tracing nor the file position a Rust
  panic has put on its first line since 1.73.
- `skill install [--agent claude|codex]` installs the `proton-pass-login` skill,
  which tells an agent to name items rather than handle values.
- `test/no-secret-leak.test.js`: nine paths driven through the plugin, all
  asserting exit code 0. On three of them a sentinel secret is in play and must
  not appear where it should not; the other five abort before `item view` and
  assert the stricter property that stderr is empty altogether. Runs in
  `npm test`, which CI runs on every push to `main` and every pull request once
  the repository is published.
- MIT licence, security policy with a 90-day coordinated-disclosure window, and a
  README documenting the security model as two lists — what is guaranteed and,
  as plainly, what is not.

### Fixed

- **`setup` cleared `PROTON_PASS_KEY_PROVIDER` and so logged the human out.** The
  variable says where pass-cli keeps its local database key — a machine setting,
  not an agent one — and removing it dropped pass-cli to a keyring it could not
  read, whereupon it logged out the session to protect data it could no longer
  decrypt. Found on the first real run of the command, 2026-08-28.
- A `pass://SHARE_ID/ITEM_ID` reference built from a human session answered
  `Invalid status code: 422 Unprocessable Entity`. Share ids differ per session;
  the error now says so and names both ways out.
- The forced-logout message claimed "the local state is already gone" for a
  session it cannot identify — it only knows the directory the failing call used.
  It now names that scope and points at `pass-cli info` before any web login.
- `--help` exited 1. It exits 0; an unknown subcommand still exits 1.

- **TOTP codes were silently dropped, on every 2FA item, always.** `item totp
  --output json` was believed to answer `{"totp": {"code": "…"}}` — a shape
  assumed in the plan's Task 5 and reproduced in the fake, **never cited from the
  `pass-cli` source and never entered in the design's "Verified assumptions"
  table**. That is the finding, and it is sharper than a wrong citation would
  have been: the table was not wrong here, it was *incomplete*. A JSON shape the
  parser depends on was never subjected to the table's rule at all, and an
  unmarked assumption reads exactly like a verified one once it is in the code.
  Measured against `pass-cli` 2.3.2 on **2026-08-20**, driving the plugin
  against a real account with a real 2FA login, it answers `{"totp": "<six
  digits>", "totp_uri": "<the same six digits>"}`: `totp` is the code as a plain
  string, and `totp_uri` carries those same digits rather than a URI — recorded
  as observed, not explained, and worth knowing that `item view` uses that same
  field name for a real `otpauth://` URI. Reading `totp.totp.code` off the real
  answer yields `undefined`, so the credential resolved **without** the code and
  with no error anywhere: agent-browser filled username and password and left the
  2FA field empty. The fake `pass-cli` reproduced the same wrong shape, so all of
  the tests agreed with it and none could fail. The parser now takes the string,
  keeps `{code}` as a defensive branch (no measured version produces it), and
  does **not** read the code out of `totp_uri` — the same field name means two
  different things in two commands, and guessing is what caused this.
- **What the TOTP branch accepts is checked, not assumed.** A code must be a
  string, non-empty, unpadded, and free of `://`. The last of those is the one
  with a hazard behind it: `otpauth://totp/…?secret=…` is a string, so a bare
  type check would have handed agent-browser the TOTP **shared secret** to type
  into the page — the same hazard `totp_uri` is refused for, and the 2026-08-20
  measurement showed `totp` and `totp_uri` carrying the same value, so the pair is
  demonstrably unstable. Deliberately **not** a digits-only rule, which would
  break a working login if Proton ever served a Steam-style alphanumeric code; a
  JSON number stays refused, since `90694` cannot be told from `090694`.
- **A TOTP answer with no readable code is now a hard error**, matching the rule
  for an item that parses without a password. The distinction the design draws is
  the one that decides it: an item *without* a TOTP secret still resolves without
  one and never makes the call, which is what "a missing TOTP is not an error"
  means. An item that declares a secret, whose call succeeded, and whose answer
  carries no code is schema drift — and letting that pass quietly is precisely
  the defect above.

### Notes

- Zero runtime dependencies: `package.json` carries no `dependencies` key.
  `setup` prompts through `node:readline/promises`, not a prompt library.
- **`setup` has not been run end to end against a real Proton account**, and all
  twenty-six of its tests drive it through the fake `pass-cli`. Its three
  uncertain calls were measured against the real binary on 2026-08-17: `agent
  create` answers with a JSON object of exactly `token` and `instruction`, the
  token prefixed `pst_`; `pass-cli login` works spawned through `execFile`, with
  the token in the child environment and no shell involved; and it refuses a
  session directory that already holds a session. The last of those was a defect
  in this command, not a detail — see the stale-session entry above.
- The design spec's sentence "the CLI path never reads stdin" is amended, in
  place and marked as deliberate: `setup` reads stdin for its prompts and only
  on a TTY. What the sentence protected is unchanged — the two modes are still
  chosen by `argv` alone.
- Requires Node >= 22 and `pass-cli` on `PATH`. Verified against `pass-cli` 2.3.2.
- The plugin's `credential.resolve` path was exercised against the real
  agent-browser binary, 0.34.0, with a stand-in `pass-cli` and a throwaway login
  form on localhost: the verbatim request shape (`"url": null` without `--url`),
  one successful `auth login --url` that filled and submitted the form at one
  resolve, and the absence of any persisted profile afterwards.
- **Manual end-to-end verification against a real Proton Pass account,
  2026-08-17.** `pass-cli` 2.3.2, agent-browser 0.34.0, one Linux/WSL machine, a
  throwaway vault with one login item, and a single-page form on localhost. It
  covered: a login that filled the real username and the real 40-character
  password and landed past the form; **one `ItemRead` audit entry per login** in
  `pass-cli agent monitor`, carrying `reason="agent-browser login: <profile>
  (<host>)"`, and a second login adding exactly one more with its own profile
  name; a token scoped to one vault seeing that one and none of the other
  nineteen on the account; the real password absent from `~/.agent-browser`, the
  agent's session directory, both shell histories, the test server's log, and any
  live process's `argv` at the time of the sweep across `/proc/*/cmdline` — that
  last one point-in-time, so it can only fail to contradict the guarantee the
  code and `test/no-secret-leak.test.js` establish; `doctor` green against a real
  agent session, with `--json` reporting `ok: true`; and the unknown-item error
  naming the vault's one real login title as its candidate.
- What that run did **not** cover: any real site's login form, and therefore
  agent-browser's selector heuristic against markup not written for the test
  (none was needed for the test's own form: no `--username-selector` or
  `--password-selector` was passed and the heuristic found both fields);
  multi-step flows; and every platform but the one it ran on. The stderr string
  `describe()` matches for an **expired agent token** was not observed either and
  remains a guess; the one it matches for a **rejected audit reason** is no longer
  a guess — see the 2026-08-20 run under Fixed. `plugin.manifest` stays
  unverifiable until publication (see below).
- `doctor`'s renew hint was wrong until that run found it: `pass-cli info`
  reports an agent token's display name, `[Agent] <name>`, and the hint
  interpolated it raw into a `pass-cli agent renew` command — bracketed,
  space-containing and unquoted, so it could not run. It now strips the prefix
  and quotes the name, escaping an apostrophe in it the POSIX way rather than
  letting it end the quoting. It also no longer implies `1h` is the only `--expiration`
  — the other spans are named as prose *after* the command rather than inside it,
  since a `(or 1d, 1w, …)` in the middle of a hint is the same defect again: the
  line stops being pasteable. `test/doctor.test.js` pins the runnable part of both
  the renew and the `agent create` hint exactly.
- The documented setup was incomplete until that run found it: exporting
  `PROTON_PASS_PERSONAL_ACCESS_TOKEN` establishes no session, and every command
  answers `This operation requires an authenticated client` until `pass-cli
  login` has run with it. README and the skill now carry that step. Proton's own
  agent instructions prescribe the same pair, an isolated
  `PROTON_PASS_SESSION_DIR` included, which independently confirms the
  recommendation this project arrived at by measurement.
- `plugin.manifest` was **not** exercised, and cannot be before publication.
  `plugin list` and `plugin show` echo the configured `agent-browser.json` entry
  without ever spawning the plugin; `plugin add`, which does ask for the manifest,
  accepts only an npm name, an `@scope/name`, or an `owner/repo`. Until this
  package is published, `test/manifest.test.js` is that handler's only cover.
- Two more measurements from the 2026-08-20 run, both under Fixed above and both
  recorded here because they close open claims. `item totp` **enforces**
  `PROTON_PASS_AGENT_REASON` exactly as `item view` does — without it the call
  refuses with `Agent sessions must set the PROTON_PASS_AGENT_REASON environment
  variable before running item commands.`, which is also the string `describe()`
  matches for a rejected audit reason and had until then been a guess. And a real
  2FA login cost **two** audit entries, one for `item view` and one for `item
  totp`, which is the half of the audit-cost claim the 2026-08-17 run could not
  reach.
