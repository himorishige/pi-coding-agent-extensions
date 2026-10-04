import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sessionRecall, { loadRecallConfig } from "./session-recall.ts";

type Tool = { name: string; execute: (...args: any[]) => Promise<any> };

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "session-recall-test-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const sessions = join(directory, "sessions", "project");
  await mkdir(sessions, { recursive: true });
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  let active = ["read", "session_recall_search", "session_recall_query"];
  let runtimeBound = false;
  const action = <T>(fn: () => T): T => {
    if (!runtimeBound)
      throw new Error("Pi action called before runtime binding");
    return fn();
  };
  const pi = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    on: (event: string, handler: (...args: any[]) => any) =>
      handlers.set(event, handler),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    getActiveTools: () => action(() => active),
    setActiveTools: (names: string[]) => action(() => (active = names)),
  } as unknown as ExtensionAPI;
  // Factory registration must not use Pi actions; Pi 0.84.2 throws here.
  assert.doesNotThrow(() => sessionRecall(pi));
  const start = async () => {
    runtimeBound = true;
    await handlers.get("session_start")!({});
  };
  return {
    directory,
    sessions,
    tools,
    handlers,
    commands,
    start,
    active: () => active,
    close: async () => {
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prior;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function content(value: any): string {
  return value.content[0].text;
}
function session(id: string, entries: unknown[]): string {
  return [
    JSON.stringify({ type: "session", id }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ].join("\n");
}
function message(role: "user" | "assistant", value: string) {
  return {
    type: "message",
    message: { role, content: [{ type: "text", text: value }] },
  };
}

async function search(
  h: Awaited<ReturnType<typeof harness>>,
  query: string,
  ctx?: any,
) {
  return h.tools
    .get("session_recall_search")!
    .execute("id", { query }, undefined, undefined, ctx);
}

test("factory is action-free; session start exposes search only and search returns no prior text", async () => {
  const h = await harness();
  try {
    await writeFile(
      join(h.sessions, "safe.jsonl"),
      session("abc12345", [
        message("user", "Find [brackets] safely"),
        { type: "compaction", summary: "SUMMARY_SECRET [brackets]" },
        { type: "branch_summary", summary: "BRANCH_SECRET [brackets]" },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "THINKING_SECRET" },
              { type: "image", data: "IMAGE_SECRET" },
              { type: "toolCall", arguments: { token: "ARGS_SECRET" } },
              { type: "text", text: "Visible answer" },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            content: [{ type: "text", text: "TOOL_SECRET" }],
          },
        },
      ]),
    );
    await h.start();
    assert.deepEqual(h.active(), ["read", "session_recall_search"]);
    const found = await search(h, "[BRACKETS]");
    const output = content(found);
    assert.match(output, /sr_[A-Za-z0-9_-]{16}/);
    assert.match(output, /Modified: .*\nMatching messages: 1/);
    assert.doesNotMatch(
      output,
      /abc12345|brackets|safe\.jsonl|SECRET|Visible answer/i,
    );
    assert.ok(h.active().includes("session_recall_query"));
    assert.match(content(await search(h, "SUMMARY_SECRET")), /No matching/);
    assert.match(
      content(
        await search(h, "[brackets]", {
          sessionManager: {
            getSessionFile: () => join(h.sessions, "safe.jsonl"),
          },
        }),
      ),
      /No matching/,
    );
  } finally {
    await h.close();
  }
});

test("search orders newest candidates and reads a match near the end of a large ordinary session", async () => {
  const h = await harness();
  try {
    const old = join(h.sessions, "old.jsonl");
    const recent = join(h.sessions, "recent.jsonl");
    await writeFile(
      old,
      session("old12345", [message("user", "COMMON_NEEDLE old")]),
    );
    await writeFile(
      recent,
      session("new12345", [message("user", "COMMON_NEEDLE new")]),
    );
    await utimes(old, new Date(1_000), new Date(1_000));
    await utimes(recent, new Date(2_000), new Date(2_000));
    const largeEntries = Array.from({ length: 12 }, (_, index) =>
      message(
        "assistant",
        `${"x".repeat(30_000)} ${index === 11 ? "late-needle" : ""}`,
      ),
    );
    await writeFile(
      join(h.sessions, "large.jsonl"),
      session("large1234", largeEntries),
    );
    await h.start();
    const ordered = content(await search(h, "COMMON_NEEDLE"));
    const refs = [...ordered.matchAll(/sr_[A-Za-z0-9_-]{16}/g)].map(
      (match) => match[0],
    );
    assert.equal(refs.length, 2);
    // Newest first is observable through non-content modified metadata.
    assert.ok(
      ordered.indexOf("1970-01-01T00:00:02.000Z") <
        ordered.indexOf("1970-01-01T00:00:01.000Z"),
    );
    assert.match(
      content(await search(h, "late-needle")),
      /Matching messages: 1/,
    );
  } finally {
    await h.close();
  }
});

test("candidate cap is applied after newest-first discovery", async () => {
  const h = await harness();
  try {
    const oldTime = new Date(1_000);
    for (let index = 0; index < 301; index++) {
      const file = join(
        h.sessions,
        `old-${String(index).padStart(3, "0")}.jsonl`,
      );
      await writeFile(
        file,
        session(`old${String(index).padStart(5, "0")}`, [
          message("user", "irrelevant"),
        ]),
      );
      await utimes(file, oldTime, oldTime);
    }
    const newest = join(h.sessions, "zzz-newest.jsonl");
    await writeFile(
      newest,
      session("newest999", [message("user", "CAP_NEEDLE")]),
    );
    await utimes(newest, new Date(9_000), new Date(9_000));
    await h.start();
    assert.match(
      content(await search(h, "CAP_NEEDLE")),
      /Matching messages: 1/,
    );
  } finally {
    await h.close();
  }
});

test("query projects the late matching text, excludes summaries/tool data, confirms each time, and returns top-level usage", async () => {
  const h = await harness();
  try {
    const late = "LATE_MATCH_VISIBLE";
    await writeFile(
      join(h.sessions, "safe.jsonl"),
      session("def67890", [
        message("user", "early safe context"),
        { type: "compaction", summary: "SUMMARY_SECRET" },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", arguments: { key: "ARGS_SECRET" } },
              { type: "text", text: `${"padding ".repeat(2500)}${late}` },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            content: [{ type: "text", text: "TOOL_SECRET" }],
          },
        },
      ]),
    );
    await h.start();
    const ref = content(await search(h, late)).match(
      /sr_[A-Za-z0-9_-]{16}/,
    )![0];
    let calls = 0;
    let confirms = 0;
    let transmitted = "";
    const ctx = {
      mode: "tui",
      hasUI: true,
      model: { provider: "test", id: "model" },
      scopedModels: [],
      ui: {
        confirm: async (_title: string, _message: string, options: any) => {
          confirms++;
          assert.ok(options.signal === undefined);
          return true;
        },
      },
      modelRegistry: {
        hasConfiguredAuth: () => true,
        complete: async (_model: unknown, request: any) => {
          calls++;
          transmitted = request.messages[0].content[0].text;
          return {
            stopReason: "stop",
            content: [{ type: "text", text: "Answer" }],
            usage: { input: 1 },
          };
        },
      },
    } as any;
    const query = h.tools.get("session_recall_query")!;
    const answer = await query.execute(
      "id",
      { sessionRef: ref, question: "What happened?" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(content(answer), "Answer");
    assert.deepEqual(answer.usage, { input: 1 });
    assert.equal(answer.details, undefined);
    assert.match(transmitted, /LATE_MATCH_VISIBLE/);
    assert.doesNotMatch(transmitted, /SUMMARY_SECRET|ARGS_SECRET|TOOL_SECRET/);
    await query.execute(
      "id",
      { sessionRef: ref, question: "Again?" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(calls, 2);
    assert.equal(confirms, 2);
    await assert.rejects(
      query.execute(
        "id",
        { sessionRef: ref, question: "No TUI" },
        undefined,
        undefined,
        { ...ctx, mode: "print" },
      ),
      /interactive TUI/,
    );
  } finally {
    await h.close();
  }
});

test("aborted confirmation fails closed and never calls the model", async () => {
  const h = await harness();
  try {
    await writeFile(
      join(h.sessions, "safe.jsonl"),
      session("cancel123", [message("user", "cancel me")]),
    );
    await h.start();
    const ref = content(await search(h, "cancel")).match(
      /sr_[A-Za-z0-9_-]{16}/,
    )![0];
    const controller = new AbortController();
    let calls = 0;
    const query = h.tools.get("session_recall_query")!;
    await assert.rejects(
      query.execute(
        "id",
        { sessionRef: ref, question: "question" },
        controller.signal,
        undefined,
        {
          mode: "tui",
          hasUI: true,
          model: { provider: "test", id: "model" },
          scopedModels: [],
          ui: {
            confirm: async (_a: string, _b: string, opts: any) => {
              assert.equal(opts.signal, controller.signal);
              controller.abort();
              return true;
            },
          },
          modelRegistry: {
            hasConfiguredAuth: () => true,
            complete: async () => {
              calls++;
              return {};
            },
          },
        } as any,
      ),
      /confirmation was cancelled/,
    );
    assert.equal(calls, 0);
  } finally {
    await h.close();
  }
});

test("symlink/replacement fail closed, config parses slash model IDs, and scoped config is rejected", async () => {
  const h = await harness();
  try {
    const outside = join(h.directory, "outside.jsonl");
    await writeFile(outside, session("outside99", [message("user", "escape")]));
    await symlink(outside, join(h.sessions, "escape.jsonl"));
    await writeFile(
      join(h.sessions, "malformed.jsonl"),
      `${JSON.stringify({ type: "session", id: "broken123" })}\n{not-json MALFORMED_NEEDLE`,
    );
    await writeFile(
      join(h.sessions, "safe.jsonl"),
      session("scope1234", [message("user", "scope needle")]),
    );
    await h.start();
    assert.match(content(await search(h, "escape")), /No matching/);
    assert.match(content(await search(h, "MALFORMED_NEEDLE")), /No matching/);
    const ref = content(await search(h, "scope needle")).match(
      /sr_[A-Za-z0-9_-]{16}/,
    )![0];
    // Replace after the saved reference: dev/inode comparison rejects it on query.
    await unlink(join(h.sessions, "safe.jsonl"));
    await writeFile(
      join(h.sessions, "safe.jsonl"),
      session("scope1234", [message("user", "replaced")]),
    );
    const query = h.tools.get("session_recall_query")!;
    await assert.rejects(
      query.execute(
        "id",
        { sessionRef: ref, question: "q" },
        undefined,
        undefined,
        {
          mode: "tui",
          hasUI: true,
          scopedModels: [],
          ui: {},
          modelRegistry: {},
        } as any,
      ),
      /no longer safe/,
    );
    await writeFile(
      join(h.directory, "session-recall.json"),
      '{"model":"provider/model/with/slash"}',
    );
    assert.deepEqual(await loadRecallConfig(), {
      model: "provider/model/with/slash",
    });
    let pickerOptions: string[] = [];
    await h.commands.get("session-recall").handler([], {
      mode: "tui",
      hasUI: true,
      scopedModels: [{ model: { provider: "scoped", id: "allowed" } }],
      ui: {
        select: async (_title: string, options: string[]) => {
          pickerOptions = options;
          return undefined;
        },
        notify: () => undefined,
      },
      modelRegistry: {
        getAvailable: () => [{ provider: "unscoped", id: "hidden" }],
        hasConfiguredAuth: () => true,
      },
    });
    assert.deepEqual(pickerOptions, ["current model", "scoped/allowed"]);
    const fresh = content(await search(h, "replaced")).match(
      /sr_[A-Za-z0-9_-]{16}/,
    )![0];
    await assert.rejects(
      query.execute(
        "id",
        { sessionRef: fresh, question: "q" },
        undefined,
        undefined,
        {
          mode: "tui",
          hasUI: true,
          scopedModels: [{ model: { provider: "other", id: "only" } }],
          ui: { confirm: async () => true },
          model: { provider: "other", id: "only" },
          modelRegistry: {
            find: () => ({ provider: "provider", id: "model/with/slash" }),
            hasConfiguredAuth: () => true,
          },
        } as any,
      ),
      /outside the session model scope/,
    );
  } finally {
    await h.close();
  }
});
