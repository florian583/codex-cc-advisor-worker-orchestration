# Codex ↔ Claude Code advisor-worker orchestration

Durable file mailboxes, exact-session delivery, and separate advisor/implementer skills.
Codex can advise Claude Code, or either CLI can act as a worker.

## Requirements

- Bun (tested with 1.3.5), Node.js 22.18+ with native TypeScript support, Git.
- Claude Code with plugin Channels and development-channel support.
- Codex CLI with Unix-socket App Server, `--remote`, `turn/steer`, `turn/start`, and hooks.
  These interfaces are experimental; older CLIs may not support this workflow.
- Both sessions run as the same local user and can read the same mission directory.
  Windows and cross-machine operation are not supported by this Unix-socket wrapper.
- Each CLI uses its own existing authentication. No API keys belong in this repository.

## Claude Code: install from GitHub

```sh
claude plugin marketplace add florian583/codex-cc-advisor-worker-orchestration
claude plugin install advisor-worker-orchestration@codex-cc-advisor-worker-orchestration
```

This public repository needs no GitHub credentials to install. First plugin startup installs locked
dependencies with Bun, with lifecycle scripts disabled; network access and a writable
plugin cache are required. Installation logs go to stderr, never MCP stdout.

Start a **new** Claude session with the Channel enabled:

```sh
claude --dangerously-load-development-channels plugin:advisor-worker-orchestration@codex-cc-advisor-worker-orchestration
```

This enables an experimental plugin Channel; it does not disable tool approvals.
Ask Claude to use the plugin's `architect-mailbox-implementer` skill and give it the
absolute mission directory. Plugin installation alone does not activate the Channel.
Use `/mcp` to confirm the server loaded. Existing sessions are not silently migrated.

## Codex CLI: install separately

Clone to a permanent location (moving it invalidates configured absolute paths):

```sh
git clone https://github.com/florian583/codex-cc-advisor-worker-orchestration.git
cd codex-cc-advisor-worker-orchestration
bun install --frozen-lockfile --ignore-scripts
codex mcp add advisor-worker-orchestration -- bun "$PWD/src/server-codex.ts"
node scripts/codex-hooks-config.mjs
```

The last command **prints**, rather than installs, a hooks fragment with absolute
paths. Merge its entries into your Codex user `hooks.json` (normally `~/.codex/hooks.json`),
preserving existing hooks and avoiding duplicate entries. In user `config.toml`, merge
these settings into existing tables; do not create duplicate TOML tables:

```toml
[features]
hooks = true
plugin_hooks = true

[mcp_servers.advisor-worker-orchestration]
enabled = false
# Keep the command/args written by `codex mcp add` above.
```

The server stays disabled in ordinary Codex sessions; the wrapper enables it only
for orchestrated launches. Install the advisor and worker skills using your Codex
skill installer, or run these from the checkout to copy skills without overwriting:

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -Rn skills/architect-mailbox-claude-implementer "${CODEX_HOME:-$HOME/.codex}/skills/"
cp -Rn skills/architect-mailbox-implementer "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Existing skill copies need a deliberate update; `cp -n` leaves them unchanged.
The `.codex-plugin` manifest exposes
skills only; it does **not** replace the MCP/hook setup above.

From your target project, run the wrapper by absolute checkout path:

```sh
bun /absolute/path/codex-cc-advisor-worker-orchestration/src/cli-codex.ts --advisor
```

Ask Codex to use `architect-mailbox-claude-implementer` and supply the same mission
directory. `--worker` selects the other role. The optional Claude wrapper is
`bun /absolute/path/codex-cc-advisor-worker-orchestration/src/cli.ts --worker`.
Neither wrapper requires an alias named `codex-orchestrated`; that name in diagnostics
means this checkout's `src/cli-codex.ts` wrapper.

## Session protocol

1. Create a shared mission directory containing `ARCHITECT-STEER.md` and
   `ARCHITECT-QUESTIONS.md`; optional `SPECS.md` defines acceptance.
2. Advisor owns STEER and watches QUESTIONS. Worker owns QUESTIONS and watches STEER.
3. Each calls `arm_advisor_worker_mailbox` with the absolute inbound path. Codex also
   passes its exact session ID announced by the SessionStart hook. Read immediately after arming.
4. Write newest blocks first, preserve history, acknowledge substantive revisions.
5. When idle, finish the turn and remain armed with the wrapper open. No polling loop needed.
6. Disarm to end the arrangement. READY/DONE is a review request, not acceptance.

Claude receives Channel notifications. Codex receives `turn/steer` while active and
`turn/start` while idle through its private App Server. Closed sessions cannot wake.
A transport acknowledgment proves acceptance only, never that the model read the file.
Lost acknowledgments are retained as unknown rather than blindly retried. Ambiguous
recipients fail closed; the bridge never invents sessions or grants approvals.

### What to ask each agent

Replace `/absolute/project` and the task/files with your actual project. Use the
same mission directory in both prompts. Start with a bounded task, not a whole codebase.

**Codex advisor:**

> Use architect-mailbox-claude-implementer. You are the advisor; a separate Claude
> Code session is the implementer. Mission: /absolute/project/.claude/handoff/example.
> Create the two mailbox files if absent, preserve existing content, and arm
> ARCHITECT-QUESTIONS.md with your exact session ID. Task: fix [specific problem],
> limited to [files]. Write the plan and acceptance checks in ARCHITECT-STEER.md.
> Review worker evidence before approving completion. When waiting, finish your
> turn but stay armed; do not loop the wait tool.

**Claude Code worker:**

> Use the advisor-worker-orchestration plugin's architect-mailbox-implementer skill.
> Mission: /absolute/project/.claude/handoff/example. You are the implementer.
> Arm ARCHITECT-STEER.md, read the latest order, and implement only approved scope.
> Write acknowledgments, questions, changed files, and test evidence in
> ARCHITECT-QUESTIONS.md. Never edit STEER. When blocked or awaiting review, finish
> the turn and stay armed for Channel messages. No recurring backup monitor while
> the Channel works.

If the worker starts before the advisor creates the mailboxes, create the directory
and empty protocol files yourself or let the advisor finish setup first.

### Quick delivery check

Ask the worker to report `READY FOR TEST` in QUESTIONS. Codex should wake, reread it,
and send a harmless acknowledgment order through STEER; Claude should then wake.
Verify both acknowledgments contain the current revision. This checks both directions
without authorizing product edits. A server merely appearing in `/mcp` is insufficient.

### Updating and uninstalling

Use Claude Code's plugin manager to update or uninstall this plugin/marketplace.
For Codex, update the checkout, run the locked dependency install again, and deliberately
refresh installed skill copies. Start new wrapper sessions after changes; keep active
work intact. To uninstall, remove only this MCP entry with
`codex mcp remove advisor-worker-orchestration`, its three hook entries, and its skill
directories. Preserve other MCP servers, hooks, and user settings.

## Troubleshooting and boundaries

- No Codex identity: check the SessionStart hook and launch through the wrapper.
- No idle wake: check the returned arm transport; long-poll-only is not live steering.
- `delivery-unknown`: inspect the target session before retrying; duplicate work is unsafe.
- `busy` after a crash: inspect the exact stale receipt lock before removing it.
- Bootstrap timeout: confirm no dependency installer remains before removing its lock.
- No permanent polling daemon is installed. Backup file monitor is optional; run at
  most one when primary transport is unavailable. File touches do not trigger that helper.
- State is local: `~/.local/state/advisor-worker-orchestration/armed.d` and
  `~/.codex/advisor-worker-orchestration`. Keep it private; it includes paths/session metadata.
- Existing local installations using custom state paths must explicitly align
  `ADVISOR_WORKER_ARM_DIR` on both sides; this package does not migrate live sessions.
- Fleet notification tools currently target registered **Codex** sessions. A Claude
  worker can communicate with a single Codex advisor via the ordinary file watcher;
  do not assume every fleet tool exists in the Claude server.

## Development

```sh
bun install --frozen-lockfile --ignore-scripts
bun test
```

Tests exercise file notifications, real subprocess MCP handshakes, hooks, routing,
and simulated App Server races. Simulated transport tests are not proof of model
inference or every installed CLI version. Do not test against someone's active mission.
