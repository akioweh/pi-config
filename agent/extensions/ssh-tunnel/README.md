# SSH Tool-forwarding

When activated, transparently "forwards" tools onto a remote via SSH.
This is to replicate the *effect* of running Pi directly on the remote, but without requiring the installation of Pi itself (and configuration of credentials) on the remote.
Crucially, the model needs not (and will not be able to) know about any active forwarding.
I.e., this is *transparent*.

> [!NOTE]
> While this is architecturally similar to a tool-call sandbox (if the remote *is* the sandbox), this implementation is *not* security-oriented and should not be used as such.

## Design

### Scope

We only forward the `read`, `write`, `edit`, and `bash` core tools.
Pi's default-off additional tools -- `ls`, `grep`, and `find` -- are *not* forwarded (will error if enabled & called).
Calls made through `codemode` also work.

The experimental `powershell` tool is also not supported (and errors).

We also auto-load `AGENTS.md` (and similar) instruction files from the specified remote dir.

### Environmental Assumptions

The remote is assumed to be reachable via ordinary `OpenSSH` connections and have

- `cat`
- `mkdir`
- `bash` or `sh`
- `mktemp`
- `chmod`
- `tar`

### Activation Model

SSH-forwarding is session-scoped: to activate forwarding, it must be done when creating a new session, where it will persist.
This model avoids the potential semantic problems of allowing forwarding on/off toggling between turns.

Host information is persistent in the session data to make SSH-forwarded sessions transparently resumable.

### Local Resource Forwarding

Some filesystem resources (e.g., skills, Pi docs, tool spill files) exist only on the *local* machine, but need be accessible by SSH-forwarded `bash`/`read`.

So, we *publish* these resources to the remote's filesystem, and rewrite paths that reference them in text fed to the LLM.

## Implementation Details

### SSH

**Authentication**: Pi ran in interactive mode allows password and host-key prompts; RPC/print mode uses noninteractive SSH auth.

**Connection Reuse**: A control master is used to avoid re-connection/auth overhead per tool-call.

### Resource Publication

We publish into `TMPDIR`.
Directories and related resources are staged locally and transferred as one tar archive over SSH.
Internal symlinks are copied by value; escaping links and cycles are rejected.
Each session load creates a fresh publication root; older roots are retained for references from previous turns.

### Session Persistence & Plugin Activation

- all SSH-forwarded sessions are stored in one dedicated directory: `~/.pi/agent/ssh-workspace/`
- this directory has the SSH-forwarding code as a project-local extension (`./core/` symlinked into `~/.pi/agent/ssh-workspace/.pi/extensions/`)
  - therefore, when opening any SSH-forwarded session, Pi will, per its built-in feature, automagically load this code that enables SSH-forwarding
- SSH-forwarded sessions have a special transcript entry (tree root node) used to persist the host & path
  - the extension reads this for seamless resumes
  - being the root node facilitates session forking, and is achieved by only allowing SSH-forwarding to be created as new sessions

### Activation UX

`/ssh user@host[:path]` creates a new SSH-forwarded session, similar in spirit to `/new`.

This command can be run whenever and wherever (regardless of Pi's cwd); `path` declares the cwd on the remote host.
When already in an SSH-forwarded session, omitting the command argument creates a session to the same host & path.

> [!NOTE]
> `/new` is blocked in SSH-forwarded sessions to prevent creating "regular" sessions in the dedicated storage directory.
> Similarly, the user should not launch Pi from within `~/.pi/agent/ssh-workspace`.

### Bash Cancellation

We need a reliable way to kill remote bash calls.
This is needed for timeouts/user-aborts and cleanup on disconnect.

Current solution is an EOF watcher script wrapping all bash commands that kills the process group on connection close.
