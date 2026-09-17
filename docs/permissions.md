# Tool permissions

Tools are the part of an agent that can damage your machine. Low Context gates
every one of them through a single decision function.

## Modes

| Mode | Reads | Writes / commands |
| --- | --- | --- |
| `safe` | allowed | refused outright |
| `ask` | allowed | require an explicit yes |
| `trusted` | allowed | allowed, except hard denies |

Default is `ask`. Set it per project for a repository you trust, per run with
`--mode`, or globally:

```bash
lc --mode safe "what does this project do?"     # read-only audit
lc --mode trusted "fix the failing tests"       # unattended
lc permissions mode ask
LOW_CONTEXT_PERMISSION_MODE=safe lc "review this"
```

## Rules

```json
{
  "permissions": {
    "mode": "ask",
    "allow": ["read_file", "search_files", "run_command:git status*", "run_command:npm test*"],
    "deny": ["run_command:rm -rf*", "write_file:infra/**", "run_command:*sudo*"]
  }
}
```

Rule forms:

| Form | Matches |
| --- | --- |
| `read_file` | the tool, all arguments |
| `run_command:git status` | exact command |
| `run_command:git *` | command glob |
| `write_file:src/**` | tool restricted to a path glob |
| `delete_file:infra/*` | tool and path |

**Deny always wins**, over allow rules and over the mode. That ordering is
deliberate: a project config can only *tighten* the policy, never widen it. A
malicious repository cannot grant itself permissions your global config denied.

```bash
lc permissions show
lc permissions allow "run_command:npm test*"
lc permissions deny  "run_command:*sudo*"
lc permissions reset
```

## Session bypass — `/nopermission`

Inside an interactive session, `/nopermission` turns confirmations off for the
rest of that session. Use it when you are working in your own repository and the
approval prompts are interrupting real work:

```
project› /nopermission
! Permission bypass ON. File writes and commands run without asking, for this session only.
  Still blocked: deny rules, and catastrophic commands (rm -rf /, fork bombs, curl|sh, force push).

project› /nopermission off      # turn it back on
```

What bypass does **not** change, on purpose:

| Still enforced | Why |
| --- | --- |
| `deny` rules | they are your explicit instructions, not defaults |
| catastrophic command patterns | `rm -rf /`, fork bombs, `curl … \| sh`, `git push --force`, `DROP DATABASE` — a bypass that allowed these would be a bug, not a convenience |
| path containment | writes still cannot escape the project root unless `allow_outside_project` is set |

The bypass is session-scoped and never persisted: restarting `lc` returns you to
`permissions.mode`. `/permissions` always shows the current state, and the banner
shows a warning row while it is on.

## Terminal execution

`run_command` is the highest-risk tool, so it gets the most machinery:

- **risk classification** — mutating, destructive, network, privilege-escalating
  commands are identified by pattern and require confirmation even in `trusted`
- **clear preview** — the exact command, working directory and environment are
  shown before running
- **timeouts** — `permissions.timeout_ms` (default 120s), the process is killed on
  expiry and the partial output plus exit status is returned
- **output limits** — `max_output_bytes` before spilling to an artifact
- **environment allowlist** — `env_allowlist`; by default a command does not
  inherit your full environment, so API keys in your shell are not exposed to
  arbitrary commands
- **working directory** — defaults to the project root
- **path containment** — `allow_outside_project: false` by default
- **cancellation** — Ctrl-C aborts the running process, not just the display

Destructive operations require confirmation when
`require_confirmation_for_destructive` is true:

```
[tool] run_command
  $ rm -rf build/
  ⚠ destructive: recursive delete
  working directory: /home/you/project
  proceed? [y/N]
```

`--yes` approves non-interactively, for CI. It does **not** bypass `deny` rules.

## Filesystem tools

| Tool | Notes |
| --- | --- |
| `read_file` | Range reads for large files; binary detected |
| `list_dir` | Bounded depth and entry count |
| `search_files` | Glob search, ignore rules respected |
| `search_text` | Content search, bounded results |
| `write_file` | Full write; confirmation in `ask` |
| `edit_file` | **Structured patch first** — locate, verify, patch, re-read |
| `create_file` | Refuses to clobber unless told to |
| `delete_file` | Confirmation, undo-aware messaging |
| `move_file` / `copy_file` | Within the project by default |

Edits prefer structured patching over blind replacement (§21):

1. understand the target file (read it)
2. locate the target region
3. verify the assumption against the actual content
4. produce a precise patch
5. re-read the changed region to confirm

A failed edit changes nothing. If the file changed since it was read, the edit is
refused and the region is re-read rather than applied to a stale view.

## Path containment

All filesystem operations are resolved and checked against the project root with
`isInside`, which normalises the path first. `../` traversal, absolute paths
outside the project, and symlink escapes are rejected unless
`allow_outside_project` is explicitly enabled.

## What the model is told

Descriptions and schemas are generated from the tool definitions, so the model sees
exactly what it may call. A tool that is denied for this project is not advertised
to the model at all, which is better than advertising it and then refusing.

## Denial behaviour

A refused tool call is returned to the model as a structured error explaining that
permission was denied — and why — so it can adapt instead of retrying blindly:

```
permission denied: run_command "sudo apt-get install …"
reason: matches deny rule "run_command:*sudo*"
```

The trace records the denial, so `--debug` shows exactly what was refused and by
which rule.
