# Pi coding agent extensions

English | [日本語](README.ja.md)

A small collection of [Pi coding agent](https://pi.dev/) extensions that I use for focused daily development.

## Extensions

| Extension       | What it adds                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `focus-ui`      | Hides successful Bash tool output in the collapsed view, keeps errors visible, and replaces the footer with a compact model, Git, and context status line |
| `turn-recap`    | Shows a short recap after the agent settles, optionally rewrites it with a model, and can prefill the suggested next action in the editor                 |
| `questionnaire` | Adds a structured single- or multi-question tool with option lists and tab navigation                                                                     |
| `plan-mode`     | Adds read-only exploration, plan saving, and execution progress tracking; it uses `questionnaire` for clarification in TUI mode                           |

`questionnaire` and the original `plan-mode` example come from `earendil-works/pi`. This repository keeps attribution in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The plan mode here includes additional plan-file persistence and path-safety checks.

## Preview

### Focus UI footer

The footer keeps the active model, working directory, Git state, context usage, and compaction count visible in one line.

![Focus UI footer showing the active model, Git state, and context usage](docs/images/focus-ui-footer.png)

### Turn recap

After the agent settles, the recap window summarizes the result, changed files, validation, and suggested next action. Fast mode is deterministic; smart mode can rewrite the summary and prepare the next prompt with a model.

![Turn recap window showing the result, changed files, validation, and next action](docs/images/turn-recap.png)

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
      "extensions": ["+extensions/focus-ui.ts", "+extensions/turn-recap.ts"]
    }
  ]
}
```

## Usage

- `Ctrl+O` expands or collapses tool output. With `focus-ui`, successful Bash output is hidden while collapsed; failed commands remain visible.
- `/recap fast` uses the deterministic recap without another model call.
- `/recap smart [provider/model]` uses the selected model, or the configured model when omitted, to rewrite the summary and prepare the next prompt. Use `/recap smart current` to select the active model.
- `/recap on`, `/recap off`, and `/recap status` control or inspect the current session mode.
- In a recap with a prepared prompt, `Enter` puts the next action in Pi's editor without submitting it. `Esc` closes the recap. Existing editor text is never overwritten without confirmation.
- `/plan` or `Ctrl+Alt+P` toggles plan mode.
- `/plan-save [relative-file.md]` saves the current plan without overwriting an explicit path.
- `/todos` shows plan execution progress.

Turn recap defaults to fast mode. To enable smart mode at startup, create `$PI_CODING_AGENT_DIR/turn-recap.json` (normally `~/.pi/agent/turn-recap.json`):

```json
{
  "mode": "smart",
  "model": "switchyard/weak-only",
  "thinkingLevel": "low",
  "timeoutMs": 30000
}
```

The `model` is optional and uses `provider/model` format. When omitted, smart mode uses the active model. `thinkingLevel` is also optional and accepts `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; `low` is usually sufficient for the short JSON response. Smart mode sends the captured final assistant text and deterministic recap facts to that model in a separate completion; it does not append the recap request or response to the main conversation. Invalid output, unavailable models, and timeouts fall back to fast mode for that turn.

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
