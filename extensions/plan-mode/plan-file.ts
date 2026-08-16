import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export interface PlanModeConfig {
  outputDirectory: string;
  fileNamePattern: string;
}

export interface LoadedPlanModeConfig {
  config: PlanModeConfig;
  warnings: string[];
}

export interface SavePlanOptions {
  cwd: string;
  config: PlanModeConfig;
  requestedPath?: string;
  title: string;
  planText?: string;
  todoItems: string[];
  now?: Date;
}

export const DEFAULT_PLAN_MODE_CONFIG: PlanModeConfig = {
  outputDirectory: "plans",
  fileNamePattern: "{date}-{slug}.md",
};

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function looksAbsolute(path: string): boolean {
  return (
    isAbsolute(path) || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)
  );
}

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function safeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim() || "Implementation Plan";
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return slug || "plan";
}

function ensureMarkdownExtension(path: string): string {
  const extension = extname(path);
  if (!extension) return `${path}.md`;
  if (extension.toLowerCase() !== ".md") {
    throw new Error("Plan output file must use the .md extension");
  }
  return path;
}

function validateRelativePath(
  cwd: string,
  path: string,
  label: string,
): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed.includes("\0")) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (looksAbsolute(trimmed)) {
    throw new Error(`${label} must stay inside the current project`);
  }

  const target = resolve(cwd, trimmed);
  if (!isWithin(resolve(cwd), target)) {
    throw new Error(`${label} must stay inside the current project`);
  }
  return target;
}

export function normalizePlanModeConfig(
  raw: unknown,
  cwd: string,
): LoadedPlanModeConfig {
  const config = { ...DEFAULT_PLAN_MODE_CONFIG };
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      config,
      warnings: [
        "plan-mode.json must contain a JSON object; defaults are used",
      ],
    };
  }

  const input = raw as Record<string, unknown>;

  if ("outputDirectory" in input) {
    if (typeof input.outputDirectory !== "string") {
      warnings.push("outputDirectory must be a string; default is used");
    } else {
      try {
        validateRelativePath(cwd, input.outputDirectory, "outputDirectory");
        config.outputDirectory = input.outputDirectory.trim();
      } catch (error) {
        warnings.push(
          `${error instanceof Error ? error.message : String(error)}; default is used`,
        );
      }
    }
  }

  if ("fileNamePattern" in input) {
    if (
      typeof input.fileNamePattern !== "string" ||
      !input.fileNamePattern.trim()
    ) {
      warnings.push(
        "fileNamePattern must be a non-empty string; default is used",
      );
    } else if (
      input.fileNamePattern.includes("/") ||
      input.fileNamePattern.includes("\\") ||
      input.fileNamePattern.includes("\0")
    ) {
      warnings.push(
        "fileNamePattern must be a filename without path separators; default is used",
      );
    } else if (
      extname(input.fileNamePattern) &&
      extname(input.fileNamePattern).toLowerCase() !== ".md"
    ) {
      warnings.push(
        "fileNamePattern must use the .md extension; default is used",
      );
    } else {
      config.fileNamePattern = input.fileNamePattern.trim();
    }
  }

  return { config, warnings };
}

export async function loadPlanModeConfig(
  cwd: string,
  configDirectoryName: string,
  projectTrusted: boolean,
): Promise<LoadedPlanModeConfig> {
  if (!projectTrusted) {
    return { config: { ...DEFAULT_PLAN_MODE_CONFIG }, warnings: [] };
  }

  const configPath = join(cwd, configDirectoryName, "plan-mode.json");
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    return normalizePlanModeConfig(raw, cwd);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { config: { ...DEFAULT_PLAN_MODE_CONFIG }, warnings: [] };
    }
    return {
      config: { ...DEFAULT_PLAN_MODE_CONFIG },
      warnings: [
        `Could not load ${configPath}: ${error instanceof Error ? error.message : String(error)}; defaults are used`,
      ],
    };
  }
}

function buildGeneratedFileName(
  config: PlanModeConfig,
  title: string,
  now: Date,
): string {
  const fileName = config.fileNamePattern
    .replaceAll("{date}", formatLocalDate(now))
    .replaceAll("{slug}", slugify(title));

  if (
    !fileName ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\0")
  ) {
    throw new Error("fileNamePattern produced an invalid filename");
  }
  return ensureMarkdownExtension(fileName);
}

export function renderPlanDocument(options: SavePlanOptions): string {
  const now = options.now ?? new Date();
  const date = formatLocalDate(now);
  const title = safeTitle(options.title);
  const planBody = options.planText?.trim();
  const fallbackSteps = options.todoItems.length
    ? options.todoItems
        .map((item, index) => `- [ ] ${index + 1}. ${item}`)
        .join("\n")
    : "- [ ] Define the implementation steps.";

  return `---
title: ${JSON.stringify(title)}
date: ${date}
status: draft
generated_by: pi-plan-mode
---

# Plan: ${title}

${planBody || `## Steps\n\n${fallbackSteps}`}
`;
}

async function nearestExistingRealPath(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function prepareSafeParent(cwd: string, target: string): Promise<void> {
  const root = resolve(cwd);
  if (!isWithin(root, target)) {
    throw new Error("Plan output path must stay inside the current project");
  }

  const rootReal = await realpath(root);
  const parent = dirname(target);
  const existingParentReal = await nearestExistingRealPath(parent);
  if (!isWithin(rootReal, existingParentReal)) {
    throw new Error("Plan output path resolves outside the current project");
  }

  await mkdir(parent, { recursive: true });
  const parentReal = await realpath(parent);
  if (!isWithin(rootReal, parentReal)) {
    throw new Error("Plan output path resolves outside the current project");
  }
}

function addNumericSuffix(path: string, suffix: number): string {
  const extension = extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  return `${stem}-${suffix}${extension}`;
}

export async function savePlanDocument(
  options: SavePlanOptions,
): Promise<string> {
  const now = options.now ?? new Date();
  const explicitPath = options.requestedPath?.trim();
  const target = explicitPath
    ? validateRelativePath(
        options.cwd,
        ensureMarkdownExtension(explicitPath),
        "Plan output path",
      )
    : validateRelativePath(
        options.cwd,
        join(
          options.config.outputDirectory,
          buildGeneratedFileName(options.config, options.title, now),
        ),
        "Plan output path",
      );

  await prepareSafeParent(options.cwd, target);
  const content = renderPlanDocument({ ...options, now });

  if (explicitPath) {
    try {
      await writeFile(target, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new Error(
          `Plan file already exists: ${relative(options.cwd, target)}`,
        );
      }
      throw error;
    }
    return relative(options.cwd, target);
  }

  for (let suffix = 1; suffix <= 100; suffix++) {
    const candidate = suffix === 1 ? target : addNumericSuffix(target, suffix);
    try {
      await writeFile(candidate, content, { encoding: "utf8", flag: "wx" });
      return relative(options.cwd, candidate);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }

  throw new Error(
    "Could not choose an unused plan filename after 100 attempts",
  );
}
