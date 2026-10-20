# agent-browser-plugin-proton-pass

A Proton Pass credential provider for [agent-browser](https://github.com/vercel-labs/agent-browser).
It resolves a login from Proton Pass and hands it to the browser without the password ever entering
the agent's transcript, `argv`, or shell history. The reasoning behind the design is in `README.md`
and `CHANGELOG.md`.

## Rules

1. **One branch per change.** Work on a branch or worktree and merge it back to `main` once it is
   reviewed and `npm test` and `npm run typecheck` pass.
2. **Distributed from GitHub, never from npm.** `agent-browser plugin add
   evrenverse/agent-browser-plugin-proton-pass` installs the plugin straight from this repository,
   so nothing needs to be on the registry; `package.json` stays `private` and `npm publish` is out of
   scope.
3. **Everything in the repository is English** — code, comments, tests, docs, commit messages.
   Conventional Commits, and **no AI attribution trailers** of any kind.
4. **No runtime dependencies, ever.** `package.json` carries no `dependencies` key. This is a tool
   that handles passwords; supply-chain surface outranks convenience. The devDependencies are
   exactly two: `typescript`, for `--checkJs` type checking without a build step, and `@types/node`,
   without which `tsc` cannot resolve `node:` builtins, `process`, `Buffer` or `NodeJS` and the
   typecheck fails with TS2307/TS2580/TS2552. Both ship only type information, appear in neither
   `files` nor the published tarball, and neither is a runtime dependency — do not delete
   `@types/node` in the belief that it violates this rule.
5. **No secret may reach stderr, `argv`, or disk.** `PROTON_PASS_AGENT_REASON` travels in the child
   environment only. `test/no-secret-leak.test.js` — ten cases — enforces this and gates every
   merge; if it fails, fix the plugin, never the test. The one sanctioned channel for a password is
   the plugin's stdout response to agent-browser.
6. **The protocol is fixed.** Every request and response carries the protocol string
   `agent-browser.plugin.v1`. A failure answers `{"success": false, "error": "…"}` with exit code 0;
   a non-zero exit is reserved for a crash the plugin could not describe.
7. **Names and licence.** The package and the executable are both named
   `agent-browser-plugin-proton-pass`. The licence is MIT. The README states that the project is
   unofficial and not operated by Proton, and that `pass-cli` (GPL-3.0) runs as a subprocess and is
   not linked.
