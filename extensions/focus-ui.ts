import {
  createBashToolDefinition,
  type ExtensionAPI,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { basename } from "node:path";

const DIRECTORY_MAX_LENGTH = 15;
const MODEL_MAX_LENGTH = 24;
const CONTEXT_BAR_WIDTH = 6;
const GIT_REFRESH_INTERVAL_MS = 5_000;

type GitStatus = {
  staged: number;
  modified: number;
  untracked: number;
};

function shorten(value: string, maxWidth: number): string {
  return truncateToWidth(value, maxWidth, "…");
}

export function formatModelLabel(
  modelName: string | undefined,
  thinkingLevel: string | undefined,
): string {
  const model = shorten(modelName || "?", MODEL_MAX_LENGTH);
  return `${model}:${thinkingLevel || "off"}`;
}

function getTextOutput(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n")
    .trimEnd();
}

function parseGitStatus(output: string): GitStatus {
  const status: GitStatus = { staged: 0, modified: 0, untracked: 0 };

  for (const line of output.split("\n")) {
    if (line.length < 2) continue;
    const index = line[0];
    const worktree = line[1];

    if (index === "?" && worktree === "?") {
      status.untracked += 1;
      continue;
    }
    if (["A", "M", "D", "R"].includes(index)) status.staged += 1;
    if (["M", "D"].includes(worktree)) status.modified += 1;
  }

  return status;
}

function sameGitStatus(left: GitStatus, right: GitStatus): boolean {
  return (
    left.staged === right.staged &&
    left.modified === right.modified &&
    left.untracked === right.untracked
  );
}

export default function focusUi(pi: ExtensionAPI) {
  const baseBash = createBashToolDefinition(process.cwd());

  pi.registerTool({
    ...baseBash,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const settings = SettingsManager.create(ctx.cwd, undefined, {
        projectTrusted: ctx.isProjectTrusted(),
      });
      const bash = createBashToolDefinition(ctx.cwd, {
        commandPrefix: settings.getShellCommandPrefix(),
        shellPath: settings.getShellPath(),
      });
      return bash.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context) {
      if (!context.expanded) return new Container();

      const timeout = args.timeout
        ? theme.fg("muted", ` (timeout ${args.timeout}s)`)
        : "";
      return new Text(
        theme.fg("toolTitle", theme.bold(`$ ${args.command}`)) + timeout,
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const output = getTextOutput(result);
      const shouldShow = expanded || context.isError;
      if (!shouldShow) return new Container();

      const lines: string[] = [];
      if (!expanded && context.isError) {
        lines.push(
          theme.fg("toolTitle", theme.bold(`$ ${context.args.command}`)),
        );
      }

      if (output) {
        const color = context.isError ? "error" : "toolOutput";
        lines.push(...output.split("\n").map((line) => theme.fg(color, line)));
      } else if (isPartial) {
        lines.push(theme.fg("muted", "Running…"));
      }

      return lines.length > 0
        ? new Text(lines.join("\n"), 0, 0)
        : new Container();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      let disposed = false;
      let refreshRunning = false;
      let gitStatus: GitStatus = {
        staged: 0,
        modified: 0,
        untracked: 0,
      };

      const refreshGitStatus = async () => {
        if (disposed || refreshRunning) return;
        refreshRunning = true;
        try {
          const result = await pi.exec("git", ["status", "--porcelain"], {
            cwd: ctx.cwd,
            timeout: 3_000,
          });
          const next =
            result.code === 0
              ? parseGitStatus(result.stdout)
              : { staged: 0, modified: 0, untracked: 0 };
          if (!disposed && !sameGitStatus(gitStatus, next)) {
            gitStatus = next;
            tui.requestRender();
          }
        } catch {
          // Keep the last known status when git is unavailable or times out.
        } finally {
          refreshRunning = false;
        }
      };

      const hasGitRepository = footerData.getGitBranch() !== null;
      if (hasGitRepository) void refreshGitStatus();
      const refreshTimer = hasGitRepository
        ? setInterval(() => void refreshGitStatus(), GIT_REFRESH_INTERVAL_MS)
        : undefined;
      const unsubscribeBranch = footerData.onBranchChange(() => {
        void refreshGitStatus();
        tui.requestRender();
      });

      return {
        dispose() {
          disposed = true;
          if (refreshTimer) clearInterval(refreshTimer);
          unsubscribeBranch();
        },
        invalidate() {},
        render(width: number): string[] {
          const model = formatModelLabel(
            ctx.model?.name || ctx.model?.id,
            ctx.thinkingLevel,
          );
          const directory = shorten(
            basename(ctx.cwd) || "?",
            DIRECTORY_MAX_LENGTH,
          );
          const branch = footerData.getGitBranch();

          const leftParts = [
            theme.fg("accent", theme.bold(`[${model}]`)),
            theme.fg("text", theme.bold(directory)),
          ];
          if (branch) {
            let git = theme.fg("mdHeading", branch);
            const indicators: string[] = [];
            if (gitStatus.staged > 0) {
              indicators.push(theme.fg("success", `+${gitStatus.staged}`));
            }
            if (gitStatus.modified > 0) {
              indicators.push(theme.fg("warning", `~${gitStatus.modified}`));
            }
            if (gitStatus.untracked > 0) {
              indicators.push(theme.fg("error", `?${gitStatus.untracked}`));
            }
            if (indicators.length > 0) git += ` ${indicators.join(" ")}`;
            leftParts.push(git);
          }

          const usage = ctx.getContextUsage();
          const percentage = Math.max(
            0,
            Math.min(100, Math.round(usage?.percent ?? 0)),
          );
          const color =
            percentage >= 80
              ? "error"
              : percentage >= 60
                ? "warning"
                : percentage >= 50
                  ? "accent"
                  : "success";
          const filled = Math.floor((CONTEXT_BAR_WIDTH * percentage) / 100);
          const bar = theme.fg(
            color,
            "▓".repeat(filled) + "░".repeat(CONTEXT_BAR_WIDTH - filled),
          );
          const rightParts = [`${bar} ${theme.fg(color, `${percentage}%`)}`];

          const compactCount = ctx.sessionManager
            .getBranch()
            .filter((entry) => entry.type === "compaction").length;
          if (compactCount > 0) {
            rightParts.push(theme.fg("warning", `C:${compactCount}`));
          }

          const left = leftParts.join(theme.fg("dim", " | "));
          const right = rightParts.join(theme.fg("dim", " | "));
          const rightWidth = visibleWidth(right);
          if (rightWidth >= width) return [truncateToWidth(right, width)];

          const maxLeftWidth = Math.max(0, width - rightWidth - 3);
          const fittedLeft = truncateToWidth(left, maxLeftWidth, "…");
          const padding = " ".repeat(
            Math.max(1, width - visibleWidth(fittedLeft) - rightWidth),
          );
          return [truncateToWidth(`${fittedLeft}${padding}${right}`, width)];
        },
      };
    });
  });
}
