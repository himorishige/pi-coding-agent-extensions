# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- Disables built-in edit/write tools while preserving other active tools
- Restricts Bash to an allowlist of read-only commands
- Uses the `questionnaire` tool for clarifying questions in TUI sessions
- Saves the full generated plan as Markdown under a project-local path
- Extracts numbered steps from `Plan:` sections
- Shows plan progress in a widget during execution
- Tracks completed steps with explicit `[DONE:n]` markers
- Restores plan state when a session resumes

## Commands

- `/plan` - Toggle plan mode
- `/todos` - Show current plan progress
- `/plan-save [relative-file.md]` - Save the current plan without overwriting an existing explicit path
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Usage

1. Enable plan mode with `/plan` or `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent should output a numbered plan under a `Plan:` header:

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. Choose "Save plan to file" or "Execute the plan" when prompted
5. During execution, the agent marks steps complete with `[DONE:n]` tags
6. Progress widget shows completion status

## Plan Files

By default, plans are written below the current project root using:

```text
plans/{date}-{slug}.md
```

Configure the project-local destination in `.pi/plan-mode.json`:

```json
{
  "outputDirectory": "plans",
  "fileNamePattern": "{date}-{slug}.md"
}
```

Supported filename placeholders:

- `{date}` - Local date in `YYYY-MM-DD` format
- `{slug}` - Session name, or the first plan step when the session is unnamed

`/plan-save` uses the configured destination. `/plan-save docs/my-plan.md` writes to an explicit relative file. Explicit files are never overwritten; generated names receive `-2`, `-3`, and so on when needed.

Absolute paths, `..` traversal, and output directories resolving through symlinks outside the project are rejected. Project configuration is loaded only for trusted projects.

## How It Works

### Plan Mode (Read-Only)

- Built-in edit/write tools disabled
- Other active tools remain available
- Bash commands filtered through a conservative single-command allowlist
- TUI sessions can ask structured questions through `questionnaire`
- RPC, JSON, and print modes fall back to questions in the normal response
- Agent creates a plan without making changes

### Execution Mode

- Full tool access restored
- Agent executes steps in order
- `[DONE:n]` markers track completion
- Widget shows progress

### Command Allowlist

Safe commands (allowed):

- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Shell control operators such as pipes, command substitution, and command chaining are also blocked. This guardrail reduces accidental writes; it is not an OS-level sandbox. The remaining read tools can still expose any file the Pi process is allowed to read, so use Pi's permission rules or a sandbox when a stronger boundary is required.

Blocked commands:

- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`
