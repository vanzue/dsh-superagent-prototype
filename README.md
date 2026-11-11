# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

Native Windows is supported with PowerShell 7 and a Node-based background controller; WSL and tmux are not required. See [Native Windows deployment](docs/006-deployment.md#native-windows).

### Read-only monitoring

For a public repository dashboard without any agent execution, configure a **fresh profile/home and state directory**:

```yaml
- id: dsh-superagent
  config:
    stateDir: C:\superagent-monitor\state
    mode: monitor
    monitor:
      repository: microsoft/intelligent-terminal
      pollSeconds: 900
- id: dsh-superagent-github
  disabled: true
```

The same Superagent sidebar now displays open Issues/PRs, recent comments/review comments and public events, and seven days of GitHub Actions runs across branches. No model or GitHub credentials are needed or read: this mode uses anonymous, fixed-endpoint GET requests only. It never constructs the execution Runtime, Engine, sessions, tools or outbox; all mutating management requests return 403, including attempts to resume processing. `observe` in execution mode is **not** this guarantee.

Snapshots are stored independently from tickets and bound to the repository. Execution databases cannot be reused for monitoring, and monitor state cannot be converted into execution state. Existing execution profiles should remain paused or stopped. Do not copy their credentials into the monitor home. These application boundaries are not an OS sandbox.

Collection defaults to every 15 minutes and backs off for the shared anonymous GitHub rate limit. Refreshing the view only reads the local snapshot. Lists paginate up to 2,000 records each and report incomplete results. GitHub public events are delayed and limited to 300, so seven-day activity/review-decision coverage is best-effort, not an audit log. CI shows Actions runs, not every external check. Sync times, errors, limits and coverage are visible in the dashboard.

### Fork collaboration

The optional `dsh-superagent/fork-watch` plugin adds daily full reconciliation of upstream Issues (open and closed), Discussions, comments and replies into the configured fork. Enable `dsh-superagent-fork`, configure the `github-mirror` Source's upstream, and enable the `github-discussions` Source. GitHub Discussions and at least one category must exist on the fork. The dashboard shows progress, recent mirror links, errors and the next full reconciliation.

Use a separate execution profile with `explicitMentionsOnly: true`, `eval.mode: off`, and explicit allowed-sender lists for GitHub and GitHub Discussions. Only newly authored, allowlisted human mentions enter the Engine; imported content, old mentions, unaddressed followups and bot events cannot wake an agent. The main agent cannot change these Source/allowlist settings through its settings tools. Copilot remains the worker backend, and replies stay on the originating fork thread.

Point the agent CLI at a wrapper invoking `node lib/fork-gh.js --config <private-json> -- <gh arguments>`. The JSON names `fork`, `upstream` and the underlying bot `cli`. The guard permits upstream reads, restricts REST write routes to the fork, forces ordinary issue/PR commands to the fork, validates supported Discussion mutations and their node ownership, and restricts git credentials by repository path. Arbitrary GraphQL mutations, repository transfers, project operations and automatic merges are refused. This is **an application/CLI guardrail, not credential-level or OS isolation**; another executable or credential can bypass it. A fork-scoped GitHub App is the stronger alternative.

Mirrors retain source URLs, authors and timestamps in their bodies; GitHub assigns new IDs and the bot authors the actual posts. Source text and metadata are fenced; provenance URLs are inline code, not active links, because even a normal Issue URL would create an unwanted cross-reference on the upstream timeline. Long content is split rather than truncated. Original labels/category are retained as metadata; a matching fork Discussion category is used where available, otherwise General. Local comments are never overwritten. Removed upstream comment text is marked and retained for history, not deleted. Reactions, votes, attachment binaries, PRs and git branches are not replicated by this feature.

The first backfill is paced (12 seconds between writes by default) and can take hours. Subsequent cycles fully inventory source and destination, updating only differences. Markers prevent duplicate creation after uncertain responses; the schedule, progress and write pacing persist across restarts. A failed cycle reports its failure and retries, rather than claiming the full sync completed. Do not enable a second mirror writer for the same fork.

### Copilot orchestrator

**Ordinary Web Chat is a separate model path.** For a fully Copilot-backed profile, also enable the optional `dsh-superagent-copilot-model` entry (`dsh-superagent/copilot-model`), setting its absolute `executable` and private `directory`. Set the host's `agent-default-model` to `{ provider: copilot, model: auto }`, select that model for existing chats, and disable unused API-key providers. Chat, generated titles, and compaction then use Copilot CLI sign-in too; selecting Copilot only in the orchestrator/worker settings does not change ordinary Chat.

The host model adapter preserves Chat history, streaming, cancellation and DSH tool permissions. It forwards the current conversation to a fresh ACP inference session, exposes only the host's current tool schemas, and returns at most one tool **proposal** per step. The CLI never executes that tool; DSH validates, authorizes and executes it, and supplies the actual result on the next step. Native CLI tools and built-in MCPs are disabled. Temporary CLI histories are removed after the owned process exits; the durable conversation remains in DSH. Copilot controls model context/output limits; provider stop sequences are refused explicitly.

The Eval settings independently select the **orchestrator backend** (`eval.backend`: `dsh` by default, or `copilot`) and its `eval.copilot` executable, home and model. Backend/configuration changes are panel-only and restart the service. With both orchestrator and workers set to Copilot, DSH remains the Windows/web host but performs no orchestrator or worker inference; existing Copilot sign-in supplies model access, not an OpenRouter or DeepSeek API key.

The Copilot orchestrator receives candidates and worker reports through a serial durable queue and uses authenticated, turn-scoped MCP tools for routing and replies. Built-in CLI tools, built-in GitHub MCP, personal instructions and configuration-changing framework tools are not exposed. Notices update its context without waking it. Turns load the same persisted Copilot session; message receipts prevent duplicate delivery, and evaluation timeouts begin only after receipt. The panel's main-session button opens recent Copilot transcript entries instead of a nonexistent DSH session.

An interrupted or uncertain send blocks the main queue. Inspect the transcript and recorded decisions, then use the overview's recovery action. It discards the interrupted delivery rather than replaying it, allowing other queued messages to proceed with reconciliation instructions; explicitly requeue any missed request. Switching backends cannot bypass an unresolved Copilot turn. Source image attachments currently require the DSH orchestrator; the ACP orchestrator fails image reads explicitly rather than guessing, while explicit tasks can still be delegated to workers.

### Copilot workers

The Execution settings can select **GitHub Copilot (ACP)** for new tickets independently of the orchestrator backend. Existing tickets retain their backend, and DSH and Copilot share the worker limit.

Install and sign in to a Copilot CLI with ACP support, then configure its absolute executable path and model (`auto` by default). On Windows prefer the native `copilot.exe`; `copilot.ps1` also works. Each ticket gets its own managed `COPILOT_HOME` below the configured root (default: `<stateDir>/copilot`). Authentication must be available to that home, normally through the system credential store. No API key or personal MCP configuration is copied.

Copilot inference identity is separate from the deployment's GitHub bot identity. Workers inherit the existing `gh` shim and git credential isolation, strip ambient secret-shaped environment variables, and disable built-in GitHub MCP servers. These are guardrails, **not an OS sandbox**: workers still run as the host's OS user.

Followups queue until the current ACP turn finishes, then load the same session in a new process. Reports use the existing ticket-scoped tools through authenticated loopback MCP. Idle, ordinary assistant text and process exit do not complete a ticket. Interrupted sends are marked failed rather than automatically replayed; explicitly retry or send new instructions after reconciling external effects. Detached processes, subagents and schedules are not supported by this backend.

Copilot transcripts remain available through `orchestrator_read` (`ticket/<id>/transcript`); the panel labels these tickets as Copilot rather than opening a nonexistent DSH worker session. Keep existing services on their previous build until the new backend has been verified in an isolated profile.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
