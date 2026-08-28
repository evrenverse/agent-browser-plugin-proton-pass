# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**[open a draft advisory](https://github.com/evrenverse/agent-browser-plugin-proton-pass/security/advisories/new)**.
It is private to you and the maintainer, it keeps the report and the fix in one
place, and it needs no email address on either side. Do not open a public issue
for a security report.

Include what you need to make the finding reproducible: the version
(`agent-browser-plugin-proton-pass --version`), the `pass-cli` version, the
platform, and the smallest sequence of steps that shows the problem. **Never
send a real password, token, or vault item** — a redacted transcript or a
sentinel value is enough.

You should get an acknowledgement within 7 days. GitHub notifies the maintainer
of a new advisory, so if nothing comes back in that time, assume it was missed
rather than ignored and add a comment to the same advisory.

## Coordinated disclosure

This project follows a **90-day** coordinated-disclosure window. The clock
starts when the report arrives. Within those 90 days a fix ships, or the report
is answered with why it is not a vulnerability. After 90 days you are free to
disclose publicly, whether or not a fix exists — earlier if a fix has already
shipped and we agree on a date.

Reporters are credited in `CHANGELOG.md` unless they ask not to be. There is no
bounty; this is an unpaid side project.

## Supported versions

Only the latest released version is supported. This project is at 0.1.0 and
unreleased, so no version is in maintenance yet.

## Out of scope

Some behaviour looks like a vulnerability but is documented, deliberate, and
listed in the README's ["Not guaranteed"](README.md#not-guaranteed-and-stated-as-plainly)
section. Reports about the following will be closed as known behaviour:

- **An agent with shell access and the same session can call `pass-cli item view`
  itself.** This plugin is not a sandbox. It is the convenient path, made
  accountable by token scoping and Proton's audit log. Hard separation between
  the agent and the vault needs a separate user context, and that is out of this
  project's reach.
- **The password is readable from the DOM after a login.** `get value`,
  `get html`, `snapshot`, and screenshots can all surface a filled field. The
  bundled skill forbids them against password fields; nothing enforces it.
- **`pass-cli run` does not mask files, values under five characters, or
  anything not resolved from a `pass://` reference.** These are `pass-cli`'s
  documented masking limits, restated in the README, not defects in this plugin.
- **Vulnerabilities in `pass-cli`, Proton Pass, or agent-browser themselves.**
  Report those to their respective maintainers; this project only calls them.

In scope is anything that breaks a claim from the README's "Guaranteed" list:
a secret reaching `argv`, stderr, a log, a file, or the agent's transcript
through this plugin; an audited read that loses its reason; or a failure path
that leaks a value it should have swallowed.
