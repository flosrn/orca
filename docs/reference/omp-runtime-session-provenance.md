# OMP runtime session provenance

OMP computes whether a runtime session is a task child. Builds whose public
`ExtensionContext` carries `ctx.agent.kind` answer it directly: `sub` never owns
the pane's session status, and only `main` can report root readiness (below).
The older, undocumented `ctx.agentKind` field is still honoured for `sub` but is
never read as positive root identity.

On runtimes without `ctx.agent`, the status extension uses the session manager's
parent header and nested task transcript path only when a root owner is already
known. A nested transcript with no known owner remains eligible because it may
have been resumed directly as the pane's main session.

The remaining child-first case on those runtimes is inherently ambiguous to Orca:
task children and resumed child transcripts have the same public session-manager
shape, so the conservative fallback avoids silencing valid resumed sessions.

Older runtimes retain the manager-identity guard. That guard assumes the main
session reaches Orca's callback before any child. An earlier user extension can
initialize a child during session_start and violate that assumption. Keep the
ownership merge assessment conditional until the combined flow is validated.
Neither callback timeouts, UI presence, nor transcript paths establish runtime
ownership.

The guard remains scoped to one pane and launch token. It does not define how
several independent SDK/ACP roots sharing one process and pane should be attributed.

## Root readiness receipt

Automatic preparation cleanup needs positive evidence that the worktree's agent
took over. On `session_start`, the status extension posts `session_start` with
`root_session_ready: true`, `root_session_id` and `status_owner_module` only when:

- the runtime is OMP and `ctx.agent.kind === 'main'`;
- `ctx.sessionManager.getSessionId()` returns a non-empty ID.

A transcript filename is not required, so an idle root session without an initial
prompt, or an ephemeral one, still reports readiness. A child session, including a
depth-zero child, never does. The fields also ride on every later status post from
that runner until `session_switch` clears them. `status_owner_module` is the
resolved path of the extension module that owns the pane's status.

Orca turns any status post carrying the receipt into takeover evidence only
through authenticated hook ingestion (the local hook token or the SSH relay
channel), and only when the pane key, launch token and live provider incarnation
all match the agent pane registered for that preparation, so a coalesced
`session_start` post still counts through a later snapshot. A tool-approval
request, the agent pane's exit or a replaced incarnation withdraws it, and a
receipt arriving after the exit is ignored.
A runtime or extension that predates the receipt gives no cleanup authority: the preparation pane stays
open.
Over SSH or WSL the relay normalizes status first, so it forwards the validated
receipt beside that status as the optional `rootReadiness` envelope field. An
OMP `session_start` has no status of its own; the relay still forwards its
receipt, with an empty payload that every Orca version drops after ingest. An
older relay omits the field and an older Orca ignores it, so mixed versions
retain the preparation pane.

For `wait-for-setup`, the agent starts inside a nested Bash or PowerShell gate,
not the pane's interactive shell. The gate reinstalls the same shared OMP shell
wrapper before evaluating the agent command so the managed `--extension` path
is retained. No mutable OMP home or user-owned extension is rewritten.

## One status owner per pane launch

Orca's shell wrapper passes its managed copy with `--extension`, while OMP loads
ambient extensions first and deduplicates only identical resolved paths, so the
user-owned `~/.omp/agent/extensions/orca-agent-status.ts` and the managed copy can
both load in one process. Each copy claims a process-global registration keyed by
`ORCA_PANE_KEY` and `ORCA_AGENT_LAUNCH_TOKEN` and records its resolved module path.
The first module to claim owns the pane launch; a copy at another path binds
nothing, and a reload or new session runner of the owning module binds once per
runner.

Rollout requirement: the owned copy (maintained in `flosrn/omp`) must implement the
same receipt and ownership claim before cleanup is expected on a host. An unported
owned copy does not claim the registration, so the managed copy still reports
readiness, but both copies keep posting status. Port the owned copy on each
deployment host through its own configuration distribution; Orca installation
never overwrites it. Verify each host with its actual OMP binary, because loader
and rebind behaviour are version-specific.
