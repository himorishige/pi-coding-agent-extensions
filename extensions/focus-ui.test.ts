import assert from "node:assert/strict";
import test from "node:test";
import { formatExtensionStatusLabels, formatModelLabel } from "./focus-ui.ts";

test("shows the effective thinking level next to the model", () => {
  assert.equal(formatModelLabel("GPT-5.6 Luna", "high"), "GPT-5.6 Luna:high");
  assert.equal(
    formatModelLabel("DeepSeek V4 Flash", "off"),
    "DeepSeek V4 Flash:off",
  );
});

test("falls back safely and truncates only the model name", () => {
  assert.equal(formatModelLabel(undefined, undefined), "?:off");
  const truncated = formatModelLabel(
    "a-model-name-that-is-longer-than-the-footer-limit",
    "low",
  ).replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(truncated, "a-model-name-that-is-lo…:low");
});

test("keeps extension status labels for custom footer mode indicators", () => {
  const labels = formatExtensionStatusLabels(
    new Map([
      ["plan-mode", "⏸ plan"],
      ["empty", "  "],
      ["execution", "📋 1/3"],
    ]),
  );

  assert.deepEqual(labels, ["⏸ plan", "📋 1/3"]);
});
