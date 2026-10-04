# Pi coding agent extensions

English | [日本語](README.ja.md)

A small collection of [Pi coding agent](https://pi.dev/) extensions that I use for focused daily development.

## Extensions

| Extension        | What it adds                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `focus-ui`       | Hides successful Bash output when collapsed, keeps errors visible, and shows model, thinking level, Git, and context status in the footer          |
| `questionnaire`  | Adds a structured single- or multi-question tool with option lists and tab navigation                                                              |
| `session-recall` | Searches structurally filtered text from prior local sessions and, after explicit confirmation, queries a selected model about an opaque reference |
| `plan-mode`      | Adds read-only exploration, plan saving, and execution progress tracking; it uses `questionnaire` for clarification in TUI mode                    |

`questionnaire` and the original `plan-mode` example come from `earendil-works/pi`. This repository keeps attribution in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The plan mode here includes additional plan-file persistence and path-safety checks.

## Preview

### Focus UI footer

The footer keeps the active model and thinking level, working directory, Git state, context usage, and compaction count visible in one line. Model and thinking use Pi's compact `model:level` notation.

![Focus UI footer showing the active model, thinking level, Git state, and context usage](docs/images/focus-ui-footer.png)

## Install

Pi packages execute code with your user permissions. Review the source before installing.

```bash
pi install git:github.com/himorishige/pi-coding-agent-extensions
```

Restart Pi after installation. Update later with:

```bash
pi update --extensions
```

To load only selected extensions, use Pi's package resource filter in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/himorishige/pi-coding-agent-extensions",
      "extensions": ["+extensions/focus-ui.ts", "+extensions/questionnaire.ts"]
    }
  ]
}
```

## Usage

- `Ctrl+O` expands or collapses tool output. With `focus-ui`, successful Bash output is hidden while collapsed; failed commands remain visible.
- `session_recall_search` performs literal, case-insensitive search only in `$PI_CODING_AGENT_DIR/sessions` (the default agent directory is returned by `getAgentDir()`; `PI_CODING_AGENT_DIR` overrides it). It returns opaque references, modified dates, and match counts—not paths, raw records, or snippets. A successful search lazily enables `session_recall_query`.
- Recall structurally admits only text blocks in user/assistant message records; it excludes summaries, thinking, images, tool calls/results, and custom/raw JSONL entries. This is not semantic secret sanitization: allowed user/assistant text can still contain secrets. Each query has a fresh TUI confirmation which explicitly warns that it may send secrets, then transmits a bounded, match-centered projection with nearby allowed context to the selected model.
- Discovery and reads are bounded (up to 300 candidates, 8 MiB per ordinary session, and 128 MiB total content); symlinks, escaping paths, and changed files fail closed using portable best-effort descriptor identity checks. Node lacks `openat`, so this is not a claim of a fully race-free filesystem boundary.
- `/session-recall` lets you select the current or an available configured query model. Its optional `$PI_CODING_AGENT_DIR/session-recall.json` accepts only `model` (`provider/model`, including IDs containing `/`), `thinkingLevel`, and `timeoutMs` (1000–120000).
- `/plan` or `Ctrl+Alt+P` toggles plan mode.
- `/plan-save [relative-file.md]` saves the current plan without overwriting an explicit path.
- `/todos` shows plan execution progress.

Plan mode is a convenience guardrail, not an OS-level sandbox. Its Bash allowlist blocks shell control operators and known mutating options, but the remaining read tools can still access files readable by the Pi process. Use permission rules or a sandbox when you need a stronger boundary.

Plan files default to `plans/{date}-{slug}.md`. A trusted project can override this in `.pi/plan-mode.json`:

```json
{
  "outputDirectory": "plans",
  "fileNamePattern": "{date}-{slug}.md"
}
```

## Compatibility

The current version is tested with `@earendil-works/pi-coding-agent` 0.84.2. Pi's extension API changes quickly, so check the repository when upgrading Pi.

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for adapted upstream examples.
