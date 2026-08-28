---
name: proton-pass-login
description: Use when an agent must log in to a website with credentials stored in Proton Pass — resolves them through agent-browser without the password entering the transcript.
---

# Logging in with Proton Pass

Passwords resolve through a plugin, out of your reach. You name an item; you
never see, request, or handle the value.

## Setup

**A human runs this, not you.** `setup` asks which vaults the agent may read,
and the answer decides how much of a person's password vault you can reach —
that question is theirs. It creates the token, writes
`~/.proton-pass-agent/env` (mode 0600), logs the agent in, and prints `doctor`:

```bash
npm i -g github:evrenverse/agent-browser-plugin-proton-pass   # this package
pass-cli login                              # the human's own session first
agent-browser-plugin-proton-pass setup      # asks, then does the rest
source ~/.proton-pass-agent/env             # in every shell that runs agent-browser
agent-browser plugin add evrenverse/agent-browser-plugin-proton-pass --name proton-pass
```

**Both references above are the GitHub form on purpose.** This package is not on
npm and will not be — `agent-browser plugin add` resolves a reference by shape,
and a bare name would send it to the registry, where it finds nothing. Only the
first line and the last are yours to run; the two in between belong to the human.

The token creation repeats every time the token expires — see rule 4. `setup`
needs a terminal, so it is one of the things to hand back to the human rather
than attempt; without one it prints the vault list and the manual commands and
exits non-zero. The README's "Doing it by hand" section is that manual path, and
its `pass-cli login` step is not optional: without it every command answers
`Error: This operation requires an authenticated client`, however correctly the
token is exported. Walking that path a second time needs a
`pass-cli logout --force` before the login — in a shell where
`PROTON_PASS_SESSION_DIR` is already exported, never without it — since the
directory already holds a session and `login` refuses one. `setup` does that
step itself.

`pass-cli share list` shows what the token can reach, vaults and directly shared
items both; `pass-cli test` checks it can talk to the Proton API at all.

## Logging in

```bash
agent-browser open https://www.gmx.net/login
agent-browser auth login gmx --credential-provider proton-pass --item "GMX" \
  --url https://www.gmx.net/login \
  --username-selector '#user' --password-selector '#pw' --submit-selector '#submit'
agent-browser get url          # confirm you landed past the login
```

**`agent-browser get url` is not optional, and the selectors are not decoration.** Measured: on a page with a newsletter form above the login form, agent-browser typed the password into the right field and the username into the *newsletter* field, then printed `✓ Logged in as …` without submitting anything. That line means the fields were filled, never that the login succeeded. Give the three selectors every time, not only when a page has two forms: without `--submit-selector` agent-browser takes the first plausible submit button, and on a shop that is the **search box** — measured 2026-08-27 on two shops that answered a login attempt with "Der eingegebene Suchbegriff ist leider zu kurz". Then check the URL afterwards.

**When a login fails you will see one line: `✗ Plugin 'proton-pass' returned success=false`.** agent-browser discards the plugin's own message, so nothing tells you whether the item was ambiguous, the token expired, or the site did not match the item. Resolve it by hand to find out — that is where the real sentence lives:

```bash
echo '{"protocol":"agent-browser.plugin.v1","type":"credential.resolve","request":{"profileName":"x","itemRef":"GMX","url":"https://www.gmx.net/login"}}' \
  | agent-browser-plugin-proton-pass
```

**Always pass `--url`, with the same login page you opened.** agent-browser does
not tell the plugin where the browser is; without `--url` it sends `url: null`,
the plugin can only answer with the item's stored URL — usually the site root —
and agent-browser then navigates away from the form, reads the item a second
time, and files the audit entry without a hostname. If the item stores no URL at
all, the login fails with `✗ Credential has no URL`.

If the item title is unknown, ask the human — or read the candidate titles from
the error message, which lists them. Titles are not secrets.

**`--url` must name a page on the item's own site.** The plugin compares the two
and refuses a credential for a site the item was not saved for, naming both
hosts — pointing a real item at an unrelated host is how a password ends up
somewhere it does not belong, so this is a refusal, not a warning. If the login
genuinely happens elsewhere, at an identity provider for instance, ask the human
to add that URL to the item in Proton Pass. Do not work around it by dropping
`--url`.

## Rules

1. **Never ask for a password value, never print one, never write one to a file.**
   Refer to items by title only.
2. Usernames and TOTP codes may appear in chat. Passwords are always `****`.
3. **After a login, do not run `get value`, `get html`, or `snapshot` against a
   password field, and take no screenshot of a filled login form.** The value is
   in the DOM at that point.
4. **An expired token and a dead session are different failures.** Tell them
   apart before asking anyone for anything.
   - `The Proton Pass agent token has expired…` — the token itself is gone.
     Only a human can renew it; everything below applies.
   - `pass-cli failed: failed to authenticate: non-existent session` — the
     session died while the token is still valid, which happens well inside a
     token's lifetime (measured with five days of a `1w` token left).
   - `Not logged in to Proton Pass. Ask a human to run: pass-cli login` — no
     session was ever made where the agent looks for one.

     **The plugin heals both itself**: `logout --force`, `login`, and the call
     again, once per request, at the cost of one extra audit entry. Seeing
     either message anyway means it could not — usually because
     `PROTON_PASS_PERSONAL_ACCESS_TOKEN` or `PROTON_PASS_SESSION_DIR` is missing
     from the environment agent-browser runs in. Ask the human to `source
     ~/.proton-pass-agent/env` there, not to renew anything. Never run
     `pass-cli logout --force` yourself: without the agent's
     `PROTON_PASS_SESSION_DIR` exported it wipes the human's own session, and
     `--force` does not ask.

   The token's lifetime is whatever `--expiration` was set to when it was
   created (`1h, 1d, 1w, 1m, 3m, 6m, 1y`; `setup` offers `1w` as its default).
   Once it expires, ask the human to renew it. **Do not guess the agent's
   name.** While the session is still valid, `doctor`'s `session kind` detail
   spells the whole `pass-cli agent renew` command out with the name already in
   it — quote it verbatim. Once the token has expired that is gone: `pass-cli
   info` fails, and the detail becomes the expired-token message with a literal
   `<name>` placeholder in it, so the name is not recoverable from `doctor` at
   the moment you need it. Ask the human for it. (That expired branch is matched
   on a guessed stderr string and has never been observed against a real expired
   token, so treat a surprising message there as unknown rather than as proof of
   anything.) Never fall back to a personal session — that drops scoping and the
   audit trail. To check your own footing before blaming the site, run
   `agent-browser-plugin-proton-pass doctor --json` and read `.ok` and
   `.checks[] | select(.name == "session kind")`. A `session recovery` check in
   that list means the session was gone and was rebuilt during that run — worth
   telling the human. It is not a verdict on anything else: **read the rest of
   that same report and let it win.** If `vault access` or `session kind` failed
   in it, that failure is the answer, whatever the recovery line says.
5. Prefer `--confirm-actions plugin:proton-pass:credential.read` in interactive
   sessions so a human approves each secret read.

**A `pass://` URI belongs to one session only.** Share ids differ between a human login and each agent token, so a URI a human copied out of their own `pass-cli` answers 422 under your token. Use the title — titles are the same for everyone.

## Filling a page without navigating

`auth login` navigates before it fills, always — even when the browser is already on
exactly that URL (measured against 0.35.0; see
[agent-browser#1728](https://github.com/vercel-labs/agent-browser/issues/1728)). Three
situations break because of it: a login path that only answers a challenge when you arrive
by clicking, a consent banner you dismissed that comes back with the reload, and a
two-step form where the reload throws away step one.

For those, `fill-commands` emits exactly what `agent-browser batch` expects, and `batch`
reads it from **stdin** — so the value travels through a pipe and never becomes an argument:

```bash
source ~/.proton-pass-agent/env

agent-browser-plugin-proton-pass fill-commands --item "GMX" \
  --username-selector '#user' --password-selector '#pw' \
  | agent-browser batch
```

Add `--totp-selector` when the item carries a code, `--url` when the audit entry should name
the host. The command refuses to run when stdout is a terminal: without a pipe the value
would go on screen and into the scrollback of whoever typed it.

Then submit yourself — `agent-browser eval` on the button, or a click.

**Never `agent-browser fill "#pw" "$PASSWORD"`.** That is the one thing this project exists
to prevent: the value lands in `argv`, which is world-readable through `/proc` on Linux.
And use plain `batch`, never `batch --json` — the JSON form echoes every command back to
stdout, including the value it just filled.

Use `auth login` where it works. It is shorter, it waits for the fields, and it reports
failures. Reach for the pipe above only when the navigation is the problem.

## Multi-step logins

Two-stage flows — email, Next, then password — are reachable with the same tool. The split
is what matters: **a username is not a secret and may go in `argv`; a password may not.**

```bash
agent-browser open https://example.com/login
agent-browser fill '#username' 'the.user@example.com'   # not a secret
agent-browser eval '(function(){document.querySelector("#username").form
                     .querySelector("button[type=submit]").click()})()'
# the password field appears; then:
agent-browser-plugin-proton-pass fill-commands --item "GMX" --password-selector '#pw' \
  | agent-browser batch
# then submit
```

`auth login` cannot do this on its own: it waits for both fields on one page and its reload
would return you to step one.

An older fallback, `pass-cli run --env-file secrets.env -- bash -c 'agent-browser fill "#pw"
"$PW"'`, is documented in the README and is **worse than the pipe above**: `bash` expands
`$PW` before `exec`, so the value does sit in that process's `argv` for as long as it runs.
Prefer stdin.

## Pages that fight back

Not this plugin's business, and the plugin cannot help with any of it — it is spawned once
the browser already exists and dies before a key is pressed. Recorded because these three
cost real time:

- **Consent banners cover the submit control**, and clicking them is not always simple: a
  Usercentrics layer lives in a shadow root where an ordinary query does not reach.
  `UC_UI.denyAllConsents()`, `OneTrust.RejectAll()` and `Cookiebot.decline()` cover the
  common vendors; otherwise walk `document.querySelectorAll('*')` for `shadowRoot` and look
  for the reject button inside.
- **Submit controls are not always `<button>`.** One large shop uses a custom element whose
  real button sits in its shadow root, so no selector heuristic finds it. `element.shadowRoot
  .querySelector('button').click()` does.
- **Bot protection may gate the login path alone.** Where the home page loads and `/login`
  answers with a challenge, arriving by an in-page click can pass where direct navigation
  does not — which is the first situation in the section above.

## A code that arrives by email

Some sites answer a correct password with a verification code sent to the account's mailbox.
The credential provider cannot supply it: the code does not exist until after the form is
submitted, and by then the plugin has exited. Fetch it from wherever that mail lands and
fill it through the same stdin pipe. The code is short-lived and single-use, so the argv
rule is softer here than for a password — but stdin costs nothing extra.

## Anything else about Proton Pass

Run `pass-cli agent instructions` for the vendor's own reference rather than
guessing at commands.
