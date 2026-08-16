import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import test from "node:test";
import turnRecap, {
  buildRecap,
  mergeEditorText,
  mergeSmartRecap,
  parseSmartRecap,
  type RunState,
} from "./turn-recap.ts";

function state(overrides: Partial<RunState> = {}): RunState {
  return {
    active: false,
    assistantText: "変更を完了しました。",
    pendingTools: new Map(),
    tools: [],
    ...overrides,
  };
}

test("builds deterministic changed and validation lines with a ready prompt", () => {
  const recap = buildRecap(
    state({
      tools: [
        {
          name: "edit",
          args: { path: "/project/src/index.ts" },
          isError: false,
        },
        {
          name: "bash",
          args: { command: "bun test && bun run typecheck" },
          isError: false,
        },
      ],
    }),
  );

  assert.deepEqual(
    recap.lines.map((line) => line.kind),
    ["summary", "changed", "validation", "next"],
  );
  assert.match(recap.lines[2]?.text ?? "", /test, typecheck/);
  assert.equal(
    recap.nextPrompt,
    "今回の変更差分を確認し、問題があれば修正してください。",
  );
});

test("does not prefill an explicit next step that may require the user", () => {
  const recap = buildRecap(
    state({ assistantText: "完了しました。\n\n次: Piを再起動してください。" }),
  );

  assert.equal(recap.lines.at(-1)?.text, "Piを再起動してください。");
  assert.equal(recap.nextPrompt, undefined);
});

test("parses a fenced smart recap and removes inline Markdown", () => {
  const parsed = parseSmartRecap(`\n\`\`\`json\n{
    "summary": "**実装を完了**しました。",
    "next": "差分を確認する",
    "prompt": "\`git diff\` を確認し、問題があれば修正してください。"
  }\n\`\`\`\n`);

  assert.deepEqual(parsed, {
    summary: "実装を完了しました。",
    next: "差分を確認する",
    prompt: "git diff を確認し、問題があれば修正してください。",
  });
});

test("accepts an omitted prompt and rejects output without a summary", () => {
  assert.deepEqual(parseSmartRecap('{"summary":"done","next":"review"}'), {
    summary: "done",
    next: "review",
    prompt: "",
  });
  assert.equal(parseSmartRecap("not json"), undefined);
  assert.equal(parseSmartRecap('{"next":"review"}'), undefined);
});

test("finds a valid object among prose and accepts common key aliases", () => {
  const parsed = parseSmartRecap(
    'Example: {"format":"ignored"}\nResult:\n```json\n{"recap":"done","next_action":"review","next_prompt":"Review it."}\n```',
  );

  assert.deepEqual(parsed, {
    summary: "done",
    next: "review",
    prompt: "Review it.",
  });
});

test("merges smart prose while preserving deterministic facts", () => {
  const fallback = {
    lines: [
      { kind: "summary" as const, text: "1件のファイルを変更" },
      { kind: "changed" as const, text: "src/index.ts" },
      { kind: "validation" as const, text: "実行: test" },
      { kind: "next" as const, text: "差分を確認" },
    ],
    nextPrompt: "差分を確認してください。",
  };
  const recap = mergeSmartRecap(fallback, {
    summary: "設定画面を追加しました。",
    next: "READMEを更新する",
    prompt: "READMEに設定方法を追記してください。",
  });

  assert.deepEqual(recap.lines, [
    { kind: "summary", text: "設定画面を追加しました。" },
    { kind: "changed", text: "src/index.ts" },
    { kind: "validation", text: "実行: test" },
    { kind: "next", text: "READMEを更新する" },
  ]);
  assert.equal(recap.nextPrompt, "READMEに設定方法を追記してください。");
});

test("an empty smart prompt disables prefill and an empty next keeps fallback", () => {
  const recap = mergeSmartRecap(
    { lines: [{ kind: "next", text: "再起動する" }] },
    { summary: "設定を反映しました。", next: "", prompt: "" },
  );

  assert.deepEqual(recap.lines, [{ kind: "next", text: "再起動する" }]);
  assert.equal(recap.nextPrompt, undefined);
});

test("prefills an empty editor and appends without overwriting a draft", () => {
  assert.equal(
    mergeEditorText("", "次を実行してください。"),
    "次を実行してください。",
  );
  assert.equal(
    mergeEditorText("既存の下書き\n", "次を実行してください。"),
    "既存の下書き\n\n次を実行してください。",
  );
});

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
type FakeComponent = { handleInput?: (data: string) => void };
type Completion = (...args: unknown[]) => Promise<{ content: unknown[] }>;

type HarnessOptions = {
  completion?: Completion;
  confirm?: boolean;
  editorText?: string;
  mode?: "tui" | "print";
};

async function createHarness(options: HarnessOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "turn-recap-test-"));
  const previousDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  await writeFile(
    join(directory, "turn-recap.json"),
    JSON.stringify({
      mode: "smart",
      model: "switchyard/weak-only",
      thinkingLevel: "low",
    }),
  );

  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: () => undefined,
  } as unknown as ExtensionAPI;
  turnRecap(pi);

  let editorText = options.editorText ?? "";
  let completionCalls = 0;
  let customCalls = 0;
  let lastRequestOptions: Record<string, unknown> | undefined;
  const statuses: Array<string | undefined> = [];
  const notifications: string[] = [];
  const model = { provider: "switchyard", id: "weak-only" };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const defaultCompletion: Completion = async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          summary: "実装を完了しました。",
          next: "READMEを更新する",
          prompt: "READMEに使い方を追記してください。",
        }),
      },
    ],
  });
  const ui = {
    setWidget: () => undefined,
    setStatus: (_key: string, value: string | undefined) =>
      statuses.push(value),
    notify: (message: string) => notifications.push(message),
    getEditorText: () => editorText,
    setEditorText: (value: string) => {
      editorText = value;
    },
    confirm: async () => options.confirm ?? true,
    custom: async (
      factory: (
        tui: unknown,
        currentTheme: typeof theme,
        keybindings: unknown,
        done: (value: "dismiss" | "prefill") => void,
      ) => FakeComponent,
    ) => {
      customCalls += 1;
      return new Promise<"dismiss" | "prefill">((resolve) => {
        const component = factory({}, theme, {}, resolve);
        component.handleInput?.("\r");
      });
    },
  };
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: options.mode !== "print",
    model,
    modelRegistry: {
      find: () => model,
      hasConfiguredAuth: () => true,
      complete: async (...args: unknown[]) => {
        completionCalls += 1;
        lastRequestOptions = args[2] as Record<string, unknown>;
        return (options.completion ?? defaultCompletion)(...args);
      },
    },
    ui,
  } as unknown as ExtensionContext;

  await handlers.get("session_start")?.({}, ctx);

  return {
    handlers,
    ctx,
    statuses,
    notifications,
    get completionCalls() {
      return completionCalls;
    },
    get customCalls() {
      return customCalls;
    },
    get lastRequestOptions() {
      return lastRequestOptions;
    },
    get editorText() {
      return editorText;
    },
    overwriteEditorText(value: string) {
      editorText = value;
    },
    async beginTurn() {
      await handlers.get("agent_start")?.({}, ctx);
      await handlers.get("message_end")?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "実装が完了しました。" }],
          },
        },
        ctx,
      );
    },
    settle() {
      return handlers.get("agent_settled")?.({}, ctx);
    },
    async cleanup() {
      if (previousDirectory === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousDirectory;
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("smart mode uses a separate completion and Enter prefills the editor", async () => {
  const harness = await createHarness();
  try {
    await harness.beginTurn();
    await harness.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(harness.completionCalls, 1);
    assert.equal(harness.lastRequestOptions?.reasoningEffort, "low");
    assert.equal(harness.lastRequestOptions?.maxTokens, 1_024);
    assert.equal(harness.lastRequestOptions?.temperature, undefined);
    assert.equal(harness.editorText, "READMEに使い方を追記してください。");
    assert.equal(harness.statuses.at(-1), undefined);
  } finally {
    await harness.cleanup();
  }
});

test("deferred prefill survives editor cleanup after agent_settled", async () => {
  const harness = await createHarness();
  try {
    await harness.beginTurn();
    await harness.settle();
    harness.overwriteEditorText("");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(harness.editorText, "READMEに使い方を追記してください。");
  } finally {
    await harness.cleanup();
  }
});

test("a new input aborts a stale smart recap without opening its modal", async () => {
  const harness = await createHarness({
    completion: async (...args: unknown[]) => {
      const requestOptions = args[2] as { signal: AbortSignal };
      return new Promise((_resolve, reject) => {
        requestOptions.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    },
  });
  try {
    await harness.beginTurn();
    const settling = harness.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.handlers.get("input")?.(
      { text: "次の依頼", streamingBehavior: undefined },
      harness.ctx,
    );
    await settling;

    assert.equal(harness.customCalls, 0);
    assert.equal(harness.editorText, "");
    assert.equal(harness.statuses.at(-1), undefined);
  } finally {
    await harness.cleanup();
  }
});

test("a provider error falls back with its actionable message", async () => {
  const harness = await createHarness({
    completion: async () => ({
      content: [],
      stopReason: "error",
      errorMessage: "Unsupported parameter: temperature",
    }),
  });
  try {
    await harness.beginTurn();
    await harness.settle();

    assert.match(
      harness.notifications.join("\n"),
      /Unsupported parameter: temperature/,
    );
  } finally {
    await harness.cleanup();
  }
});

test("invalid smart output falls back to fast recap", async () => {
  const harness = await createHarness({
    completion: async () => ({ content: [{ type: "text", text: "invalid" }] }),
  });
  try {
    await harness.beginTurn();
    await harness.settle();

    assert.equal(harness.completionCalls, 1);
    assert.equal(harness.customCalls, 1);
    assert.match(harness.notifications.join("\n"), /fastへ戻します/);
  } finally {
    await harness.cleanup();
  }
});

test("smart recap is skipped outside TUI mode", async () => {
  const harness = await createHarness({ mode: "print" });
  try {
    await harness.beginTurn();
    await harness.settle();

    assert.equal(harness.completionCalls, 0);
    assert.equal(harness.customCalls, 0);
  } finally {
    await harness.cleanup();
  }
});

test("declining append preserves an existing editor draft", async () => {
  const harness = await createHarness({
    confirm: false,
    editorText: "既存の下書き",
  });
  try {
    await harness.beginTurn();
    await harness.settle();

    assert.equal(harness.editorText, "既存の下書き");
  } finally {
    await harness.cleanup();
  }
});
