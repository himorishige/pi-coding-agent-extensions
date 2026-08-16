import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";

const WIDGET_KEY = "turn-recap";
const MAX_CAPTURED_TEXT_LENGTH = 12_000;
const MAX_LINE_SOURCE_LENGTH = 240;

type ToolRecord = {
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
};

type RecapLine = {
  kind: "summary" | "waiting" | "changed" | "validation" | "next";
  text: string;
};

type RunState = {
  active: boolean;
  assistantText: string;
  pendingTools: Map<string, { name: string; args: Record<string, unknown> }>;
  tools: ToolRecord[];
};

function createRunState(): RunState {
  return {
    active: false,
    assistantText: "",
    pendingTools: new Map(),
    tools: [],
  };
}

function resetRunState(state: RunState): void {
  state.assistantText = "";
  state.pendingTools.clear();
  state.tools = [];
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function limitCapturedText(text: string): string {
  if (text.length <= MAX_CAPTURED_TEXT_LENGTH) return text;
  const half = Math.floor(MAX_CAPTURED_TEXT_LENGTH / 2);
  return `${text.slice(0, half)}\n${text.slice(-half)}`;
}

function extractAssistantText(message: unknown): string {
  const candidate = toRecord(message);
  if (candidate.role !== "assistant") return "";

  const content = candidate.content;
  if (typeof content === "string") return limitCapturedText(content.trim());
  if (!Array.isArray(content)) return "";

  const text = content
    .map((item) => toRecord(item))
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => String(item.text))
    .join("\n")
    .trim();
  return limitCapturedText(text);
}

function cleanMarkdownLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .slice(0, MAX_LINE_SOURCE_LENGTH);
}

function meaningfulLines(text: string): string[] {
  const genericHeadings =
    /^(概要|結果|実装内容|変更内容|検証|まとめ|完了|summary|result|changes?)[:：]?$/i;

  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("```"))
    .map(cleanMarkdownLine)
    .filter((line) => line.length > 0 && !genericHeadings.test(line));
}

function firstMeaningfulLine(text: string): string | undefined {
  return meaningfulLines(text)[0];
}

function isQuestion(text: string | undefined): boolean {
  return Boolean(text && /[?？]$/.test(text));
}

function summarize(
  text: string,
  toolCount: number,
  fileCount: number,
): Pick<RecapLine, "kind" | "text"> {
  const first = firstMeaningfulLine(text);
  if (first && !isQuestion(first)) return { kind: "summary", text: first };
  if (fileCount > 0) {
    return { kind: "summary", text: `${fileCount}件のファイルを変更` };
  }
  if (toolCount > 0) {
    return {
      kind: "summary",
      text: `ツールを${toolCount}回実行して処理を完了`,
    };
  }
  if (first) return { kind: "waiting", text: first };
  return { kind: "summary", text: "処理が完了" };
}

function touchedFiles(tools: ToolRecord[]): string[] {
  const files = new Set<string>();
  for (const tool of tools) {
    if (tool.isError || !["edit", "write"].includes(tool.name)) continue;
    const path = tool.args.path;
    if (typeof path === "string" && path.trim()) files.add(path.trim());
  }
  return [...files];
}

function validationLabels(command: string): string[] {
  const matchers: Array<[RegExp, string]> = [
    [
      /\b(?:pytest|vitest|jest|cargo\s+test|go\s+test|bun\s+test|pnpm\s+test)\b/i,
      "test",
    ],
    [/\b(?:tsc|typecheck)\b/i, "typecheck"],
    [/\b(?:eslint|textlint|lint)\b/i, "lint"],
    [/\bprettier\b/i, "prettier"],
    [/\bruff\b/i, "ruff"],
  ];

  return matchers
    .filter(([pattern]) => pattern.test(command))
    .map(([, label]) => label);
}

function validationSummary(tools: ToolRecord[]): string | undefined {
  const passed = new Set<string>();
  const failed = new Set<string>();

  for (const tool of tools) {
    if (tool.name !== "bash") continue;
    const command = tool.args.command;
    if (typeof command !== "string") continue;

    for (const label of validationLabels(command)) {
      if (tool.isError) {
        passed.delete(label);
        failed.add(label);
      } else {
        failed.delete(label);
        passed.add(label);
      }
    }
  }

  const parts: string[] = [];
  if (passed.size > 0) parts.push(`実行: ${[...passed].join(", ")}`);
  if (failed.size > 0) parts.push(`失敗: ${[...failed].join(", ")}`);
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

function explicitNextStep(text: string): string | undefined {
  const rawLines = text.split("\n");

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]?.trim() ?? "";
    const inline = raw.match(
      /^(?:[-*+]\s*)?(?:→\s*)?(?:次|next)(?:の推奨)?\s*[:：]\s*(.+)$/i,
    );
    if (inline?.[1]) return cleanMarkdownLine(inline[1]);

    const heading = raw
      .replace(/^#{1,6}\s+/, "")
      .replace(/[:：]$/, "")
      .trim();
    if (!/^(?:次|次のステップ|推奨する次の作業|next steps?)$/i.test(heading)) {
      continue;
    }

    for (const following of rawLines.slice(index + 1)) {
      const cleaned = cleanMarkdownLine(following);
      if (cleaned) return cleaned;
    }
  }

  return undefined;
}

function recommendNext(
  assistantText: string,
  files: string[],
  validation: string | undefined,
  tools: ToolRecord[],
): string {
  const explicit = explicitNextStep(assistantText);
  if (explicit) return explicit;

  if (isQuestion(firstMeaningfulLine(assistantText)) && tools.length === 0) {
    return "質問に回答して作業を続行";
  }

  const lastTool = tools.at(-1);
  if (lastTool?.isError) return "最後に失敗したツールの原因を確認して再実行";
  if (files.length > 0 && !validation) {
    return "変更箇所に対するテストまたはlintを実行";
  }
  if (files.length > 0) return "差分を確認し、問題なければ次の作業へ進む";
  if (validation) return "検証結果を確認し、必要なら修正を続ける";
  return "必要に応じて、上記結果をもとに次の依頼へ進む";
}

function compactPath(path: string): string {
  if (path.length <= 72) return path;
  const segments = path.split("/").filter(Boolean);
  const tail = segments.slice(-3).join("/");
  return `…/${tail}`;
}

function formatFiles(files: string[]): string {
  const visible = files.slice(0, 2).map(compactPath);
  const remaining = files.length - visible.length;
  return `${visible.join(", ")}${remaining > 0 ? ` (+${remaining})` : ""}`;
}

function buildRecap(state: RunState): RecapLine[] {
  const files = touchedFiles(state.tools);
  const validation = validationSummary(state.tools);
  const lines: RecapLine[] = [
    summarize(state.assistantText, state.tools.length, files.length),
  ];

  if (files.length > 0) {
    lines.push({ kind: "changed", text: formatFiles(files) });
  }
  if (validation) {
    lines.push({ kind: "validation", text: validation });
  }

  lines.push({
    kind: "next",
    text: recommendNext(state.assistantText, files, validation, state.tools),
  });
  return lines;
}

export default function turnRecap(pi: ExtensionAPI) {
  let enabled = true;
  let state = createRunState();
  let lastRecap: RecapLine[] = [];

  const clearLegacyWidget = (ctx: ExtensionContext) => {
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  };

  const showRecap = async (ctx: ExtensionContext, lines: RecapLine[]) => {
    if (!enabled || ctx.mode !== "tui" || lines.length === 0) return;

    await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
      const labels = {
        summary: theme.fg("success", "✓ 完了: "),
        waiting: theme.fg("warning", "? 確認: "),
        changed: theme.fg("accent", "Δ 変更: "),
        validation: theme.fg("success", "◉ 検証: "),
        next: theme.fg("warning", "→ 次: "),
      } as const;
      const container = new Container();
      const border = (text: string) => theme.fg("borderAccent", text);

      container.addChild(new DynamicBorder(border));
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Turn recap")), 1, 0),
      );
      for (const line of lines) {
        container.addChild(new Text(`${labels[line.kind]}${line.text}`, 1, 0));
      }
      container.addChild(
        new Text(theme.fg("dim", "Enter / Esc で閉じる"), 1, 0),
      );
      container.addChild(new DynamicBorder(border));

      return {
        invalidate: () => container.invalidate(),
        render: (width: number) => container.render(width),
        handleInput(data: string) {
          if (
            matchesKey(data, "enter") ||
            matchesKey(data, "escape") ||
            matchesKey(data, "ctrl+c")
          ) {
            done();
          }
        },
      };
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    state = createRunState();
    lastRecap = [];
    clearLegacyWidget(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!state.active) {
      resetRunState(state);
      clearLegacyWidget(ctx);
    }
    state.active = true;
  });

  pi.on("tool_execution_start", async (event) => {
    if (!state.active) return;
    state.pendingTools.set(event.toolCallId, {
      name: event.toolName,
      args: toRecord(event.args),
    });
  });

  pi.on("tool_execution_end", async (event) => {
    if (!state.active) return;
    const pending = state.pendingTools.get(event.toolCallId);
    state.pendingTools.delete(event.toolCallId);
    state.tools.push({
      name: pending?.name ?? event.toolName,
      args: pending?.args ?? {},
      isError: event.isError === true,
    });
  });

  pi.on("message_end", async (event) => {
    if (!state.active) return;
    const text = extractAssistantText(event.message);
    if (text) state.assistantText = text;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!state.active) return;
    state.active = false;
    state.pendingTools.clear();
    lastRecap = buildRecap(state);
    await showRecap(ctx, lastRecap);
  });

  pi.registerCommand("recap", {
    description: "Turn the settled-turn recap widget on or off",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value === "on") enabled = true;
      else if (value === "off") enabled = false;
      else if (value === "") enabled = !enabled;
      else {
        if (ctx.hasUI) ctx.ui.notify("Usage: /recap [on|off]", "warning");
        return;
      }

      if (enabled) await showRecap(ctx, lastRecap);
      else clearLegacyWidget(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(`Turn recap: ${enabled ? "on" : "off"}`, "info");
      }
    },
  });
}
