import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_PLAN_MODE_CONFIG,
  normalizePlanModeConfig,
  renderPlanDocument,
  savePlanDocument,
} from "./plan-file.ts";

async function withTempDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("normalizes valid configuration", () => {
  const result = normalizePlanModeConfig(
    {
      outputDirectory: "docs/plans",
      fileNamePattern: "plan-{date}-{slug}.md",
    },
    "/tmp/project",
  );

  assert.deepEqual(result.config, {
    outputDirectory: "docs/plans",
    fileNamePattern: "plan-{date}-{slug}.md",
  });
  assert.deepEqual(result.warnings, []);
});

test("rejects paths outside the project and filename separators", () => {
  const result = normalizePlanModeConfig(
    {
      outputDirectory: "../outside",
      fileNamePattern: "nested/{slug}.md",
    },
    "/tmp/project",
  );
  const windowsRootRelative = normalizePlanModeConfig(
    { outputDirectory: "\\outside" },
    "/tmp/project",
  );

  assert.deepEqual(result.config, DEFAULT_PLAN_MODE_CONFIG);
  assert.equal(result.warnings.length, 2);
  assert.deepEqual(windowsRootRelative.config, DEFAULT_PLAN_MODE_CONFIG);
  assert.equal(windowsRootRelative.warnings.length, 1);
});

test("renders frontmatter and preserves the full plan text", () => {
  const document = renderPlanDocument({
    cwd: "/tmp/project",
    config: DEFAULT_PLAN_MODE_CONFIG,
    title: "API migration",
    planText: "Plan:\n1. Inspect the current API.\n2. Migrate callers.",
    todoItems: ["Inspect", "Migrate"],
    now: new Date(2026, 7, 16),
  });

  assert.match(document, /title: "API migration"/);
  assert.match(document, /date: 2026-08-16/);
  assert.match(document, /1\. Inspect the current API\./);
});

test("writes a generated path and adds a suffix instead of overwriting", async () => {
  await withTempDirectory(async (cwd) => {
    const options = {
      cwd,
      config: DEFAULT_PLAN_MODE_CONFIG,
      title: "API migration",
      planText: "Plan:\n1. Inspect the API.",
      todoItems: ["Inspect the API"],
      now: new Date(2026, 7, 16),
    };

    const first = await savePlanDocument(options);
    const second = await savePlanDocument(options);

    assert.equal(first, "plans/2026-08-16-api-migration.md");
    assert.equal(second, "plans/2026-08-16-api-migration-2.md");
    assert.match(await readFile(join(cwd, first), "utf8"), /Inspect the API/);
  });
});

test("rejects an explicit traversal path", async () => {
  await withTempDirectory(async (cwd) => {
    await assert.rejects(
      savePlanDocument({
        cwd,
        config: DEFAULT_PLAN_MODE_CONFIG,
        requestedPath: "../outside.md",
        title: "Unsafe",
        planText: "Plan:\n1. Do not write this.",
        todoItems: [],
      }),
      /must stay inside the current project/,
    );
  });
});

test("rejects non-Markdown output files", async () => {
  await withTempDirectory(async (cwd) => {
    const invalidConfig = normalizePlanModeConfig(
      { fileNamePattern: "{date}-{slug}.txt" },
      cwd,
    );
    assert.deepEqual(invalidConfig.config, DEFAULT_PLAN_MODE_CONFIG);
    assert.equal(invalidConfig.warnings.length, 1);

    await assert.rejects(
      savePlanDocument({
        cwd,
        config: DEFAULT_PLAN_MODE_CONFIG,
        requestedPath: "plans/not-markdown.txt",
        title: "Markdown only",
        planText: "Plan:\n1. Save Markdown.",
        todoItems: [],
      }),
      /must use the \.md extension/,
    );
  });
});

test("does not overwrite an explicit path", async () => {
  await withTempDirectory(async (cwd) => {
    await mkdir(join(cwd, "plans"));
    await writeFile(join(cwd, "plans/existing.md"), "keep me");

    await assert.rejects(
      savePlanDocument({
        cwd,
        config: DEFAULT_PLAN_MODE_CONFIG,
        requestedPath: "plans/existing.md",
        title: "Existing",
        planText: "Plan:\n1. Preserve the old file.",
        todoItems: [],
      }),
      /already exists/,
    );
    assert.equal(
      await readFile(join(cwd, "plans/existing.md"), "utf8"),
      "keep me",
    );
  });
});

test("rejects a symlinked output directory outside the project", async () => {
  await withTempDirectory(async (cwd) => {
    const outside = await mkdtemp(join(tmpdir(), "pi-plan-outside-"));
    try {
      await symlink(outside, join(cwd, "plans"));
      await assert.rejects(
        savePlanDocument({
          cwd,
          config: DEFAULT_PLAN_MODE_CONFIG,
          title: "Symlink escape",
          planText: "Plan:\n1. Stay inside the project.",
          todoItems: [],
        }),
        /resolves outside the current project/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
