import { spawn } from "node:child_process";
import { watch as fsWatch } from "node:fs";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

function printHelp() {
  process.stdout.write(`project-docs-keeper

Usage:
  node ./scripts/project-docs-keeper.mjs [options]

Options:
  --env <dev|test|prod>                 Default: PDK_ENV or dev
  --out-dir <path>                      Default: PDK_OUT_DIR or ./project_docs
  --create-missing <true|false>         Default: true (creates missing local docs)
  --change-id <id>                      Optional. Override change identifier (fallback when no git)
  --summary <text>                      Optional. Override summary (fallback when no git)
  --watch                               Watch files and auto update on save
  --watch-root <path>                   Default: current working directory
  --watch-debounce-ms <number>          Default: 1200
  --install-git-hooks                   Install git hooks for auto trigger (post-commit/post-merge/post-checkout)
  --uninstall-git-hooks                 Uninstall git hooks installed by this tool
  --help                                Show help
`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function run(command, args, { cwd, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function safeTrim(value, maxLength = 4000) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function toPosixPath(inputPath) {
  return String(inputPath || "").replace(/\\/g, "/");
}

async function getGitDelta(repoRoot) {
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot });
  if (inside.code !== 0) return null;

  const head = await run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const message = await run("git", ["show", "-s", "--format=%s%n%b", "HEAD"], { cwd: repoRoot });
  const files = await run("git", ["diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"], { cwd: repoRoot });
  const dirty = await run("git", ["diff", "--name-status"], { cwd: repoRoot });

  return {
    commit: safeTrim(head.stdout),
    message: safeTrim(message.stdout),
    changedFiles: safeTrim(files.stdout),
    uncommitted: safeTrim(dirty.stdout),
  };
}

function parseChangedFiles(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split(/\s+/);
      return {
        status: status || "M",
        path: rest.join(" "),
      };
    })
    .filter((item) => item.path);
}

function dedupeStrings(items) {
  return [...new Set(items.filter(Boolean).map((item) => String(item)))];
}

function deriveAffectedModules(paths, cwd) {
  const modules = new Set();
  for (const rawPath of paths) {
    const relative = toPosixPath(path.isAbsolute(rawPath) ? path.relative(cwd, rawPath) : rawPath);
    const parts = relative.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    if (parts[0].startsWith(".")) {
      modules.add(parts.slice(0, Math.min(2, parts.length)).join("/"));
      continue;
    }
    modules.add(parts[0]);
  }
  return [...modules];
}

function summarizeWatchFiles(triggerFiles, cwd) {
  return dedupeStrings(
    triggerFiles.map((filePath) => {
      const relative = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
      return toPosixPath(relative);
    })
  );
}

function normalizeBool(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function nowIsoLocal() {
  const date = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const tzOffset = -date.getTimezoneOffset();
  const sign = tzOffset >= 0 ? "+" : "-";
  const hh = pad(Math.floor(Math.abs(tzOffset) / 60));
  const mm = pad(Math.abs(tzOffset) % 60);
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}-${m}-${d} ${h}:${mi}:${s} GMT${sign}${hh}:${mm}`;
}

function buildLatestLine({ env, changeId, summary }) {
  const parts = [];
  parts.push(`更新时间：${nowIsoLocal()}`);
  parts.push(`环境：${env}`);
  if (changeId) parts.push(`变更ID：${changeId}`);
  if (summary) parts.push(`摘要：${summary}`);
  return parts.join(" ");
}

function buildContext({ delta, summary, cwd, triggerFiles = [] }) {
  const changedFiles = parseChangedFiles(delta?.changedFiles || "").map((item) => `${item.status} ${toPosixPath(item.path)}`);
  const sourceFiles = summarizeWatchFiles(triggerFiles, cwd);
  const allPaths = [
    ...changedFiles.map((item) => item.replace(/^[A-Z?]+\s+/, "")),
    ...sourceFiles,
  ];
  const affectedModules = deriveAffectedModules(allPaths, cwd);

  return {
    summary: safeTrim(summary || delta?.message || ""),
    changedFiles,
    sourceFiles,
    affectedModules,
    hasGit: Boolean(delta),
    uncommitted: safeTrim(delta?.uncommitted || ""),
  };
}

function buildAutoSectionMarkdown() {
  return (
    `## 自动更新区\n` +
    `<!-- PDK_AUTO_SECTION -->\n\n` +
    `### 最新更新\n` +
    `<!-- PDK_LATEST_UPDATE -->\n` +
    `（等待首次更新）\n\n` +
    `### 历史更新\n` +
    `<!-- PDK_HISTORY_START -->\n`
  );
}

function buildHistoryEntryMarkdown({ env, changeId, delta, summary }) {
  const lines = [];
  lines.push(`<!-- PDK_CHANGE_ID:${changeId || "N/A"} -->`);
  lines.push(`- 更新时间：${nowIsoLocal()}`);
  lines.push(`- 环境：${env}`);
  if (changeId) lines.push(`- 变更ID：${changeId}`);
  const mergedSummary = safeTrim(summary || delta?.message || "");
  if (mergedSummary) lines.push(`- 摘要：${mergedSummary}`);
  if (delta?.changedFiles) {
    lines.push("");
    lines.push("变更文件：");
    lines.push("```text");
    lines.push(delta.changedFiles);
    lines.push("```");
  }
  if (delta?.uncommitted) {
    lines.push("");
    lines.push("未提交变更（工作区）：");
    lines.push("```text");
    lines.push(delta.uncommitted);
    lines.push("```");
  }
  return `${lines.join("\n")}\n`;
}

function joinList(items, fallback = "待补充") {
  return items.length > 0 ? items.join("、") : fallback;
}

function buildTalkLatestBlock({ env, changeId, context }) {
  return [
    `- 更新时间：${nowIsoLocal()}`,
    `- 环境：${env}`,
    `- 变更ID：${changeId || "未提供"}`,
    `- 本次主题：${context.summary || "待补充"}`,
    `- 影响模块：${joinList(context.affectedModules)}`,
    `- 可讲解重点：${context.affectedModules.length > 0 ? `围绕 ${joinList(context.affectedModules)} 说明变更动机、实现路径与收益。` : "围绕本次功能目标说明变更动机、实现路径与收益。"}`,
  ].join("\n");
}

function buildTalkHistoryEntry({ env, changeId, context }) {
  const lines = [
    `<!-- PDK_CHANGE_ID:${changeId || "N/A"} -->`,
    `#### 宣讲更新批次：${changeId || "未命名批次"}`,
    ``,
    `- 更新时间：${nowIsoLocal()}`,
    `- 环境：${env}`,
    `- 主题摘要：${context.summary || "待补充"}`,
    `- 影响模块：${joinList(context.affectedModules)}`,
    `- 对外讲法：先讲痛点，再讲方案步骤，最后讲成果与避坑。`,
  ];
  if (context.changedFiles.length > 0) {
    lines.push("", "涉及文件：", "```text", ...context.changedFiles, "```");
  }
  return `${lines.join("\n")}\n`;
}

function buildDevlogLatestBlock({ env, changeId, context }) {
  const lines = [
    `- 更新时间：${nowIsoLocal()}`,
    `- 环境：${env}`,
    `- 变更ID：${changeId || "未提供"}`,
    `- 当前摘要：${context.summary || "待补充"}`,
    `- 影响模块：${joinList(context.affectedModules)}`,
  ];
  if (context.sourceFiles.length > 0) {
    lines.push(`- 触发来源文件：${joinList(context.sourceFiles)}`);
  }
  return lines.join("\n");
}

function buildDevlogHistoryEntry({ env, changeId, context }) {
  const lines = [
    `<!-- PDK_CHANGE_ID:${changeId || "N/A"} -->`,
    `#### 开发记录批次：${changeId || "未命名批次"}`,
    ``,
    `- 更新时间：${nowIsoLocal()}`,
    `- 环境：${env}`,
    `- 背景/触发：${context.summary || "待补充"}`,
    `- 影响模块：${joinList(context.affectedModules)}`,
  ];
  if (context.sourceFiles.length > 0) {
    lines.push(`- 触发来源文件路径：${joinList(context.sourceFiles)}`);
  }
  if (context.changedFiles.length > 0) {
    lines.push("", "变更文件清单：", "```text", ...context.changedFiles, "```");
  }
  lines.push(
    "",
    "待补充分析：",
    "- 现象：待补充",
    "- 根因：待补充",
    "- 解决：待补充",
    "- 验证：待补充",
    "- 复发预防：待补充"
  );
  return `${lines.join("\n")}\n`;
}

function buildDeployLatestBlock({ env, changeId, context }) {
  return [
    `- 更新时间：${nowIsoLocal()}`,
    `- 环境：${env}`,
    `- 变更ID：${changeId || "未提供"}`,
    `- 部署摘要：${context.summary || "待补充"}`,
    `- 涉及模块：${joinList(context.affectedModules)}`,
    `- 发布关注点：${context.affectedModules.length > 0 ? `重点检查 ${joinList(context.affectedModules)} 的配置、启动与验证链路。` : "重点检查构建、配置注入与验证链路。"}`,
  ].join("\n");
}

function buildDeployHistoryEntry({ env, changeId, context }) {
  const lines = [
    `<!-- PDK_CHANGE_ID:${changeId || "N/A"} -->`,
    `#### 部署手册更新批次：${changeId || "未命名批次"}`,
    ``,
    `- 更新时间：${nowIsoLocal()}`,
    `- 环境：${env}`,
    `- 变更摘要：${context.summary || "待补充"}`,
    `- 影响模块：${joinList(context.affectedModules)}`,
    `- 需要同步检查：构建产物、环境变量、验证步骤、回滚点`,
  ];
  if (context.changedFiles.length > 0) {
    lines.push("", "关联文件：", "```text", ...context.changedFiles, "```");
  }
  return `${lines.join("\n")}\n`;
}

function replaceLatestBlock(markdown, latestBlock) {
  const marker = "<!-- PDK_LATEST_UPDATE -->";
  const index = markdown.indexOf(marker);
  if (index < 0) return markdown;
  const afterMarkerIndex = index + marker.length;
  const nextNewlineIndex = markdown.indexOf("\n", afterMarkerIndex);
  if (nextNewlineIndex < 0) return markdown;
  const start = nextNewlineIndex + 1;
  const historyHeader = "\n### 历史更新";
  const end = markdown.indexOf(historyHeader, start);
  const normalizedBlock = String(latestBlock).replace(/\s+$/, "");
  if (end < 0) {
    return `${markdown.slice(0, start)}${normalizedBlock}\n`;
  }
  return `${markdown.slice(0, start)}${normalizedBlock}\n${markdown.slice(end)}`;
}

function insertHistoryEntry(markdown, entry) {
  const marker = "<!-- PDK_HISTORY_START -->";
  const index = markdown.indexOf(marker);
  if (index < 0) return markdown;
  const insertAt = markdown.indexOf("\n", index + marker.length);
  const pos = insertAt >= 0 ? insertAt + 1 : markdown.length;
  return `${markdown.slice(0, pos)}\n${entry}\n${markdown.slice(pos)}`;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function baseTalkTemplate() {
  return (
    `# 项目宣讲稿\n\n` +
    `适用：论坛稿 / 公众号稿 / 新手快速上手。\n\n` +
    buildAutoSectionMarkdown() +
    `\n## 1. 痛点与背景\n\n` +
    `## 2. 目标与范围\n\n` +
    `## 3. 方案概览（核心流程）\n\n` +
    `## 4. 从 0 到 1 复现步骤（dev / test / prod）\n\n` +
    `## 5. 成果与价值\n\n` +
    `## 6. 踩坑与避坑\n\n` +
    `## 7. 下一步\n`
  );
}

function baseDevlogTemplate() {
  return (
    `# 项目开发过程记录\n\n` +
    `定位：问题—根因—解决—验证—预防，帮助后续快速避坑。\n\n` +
    buildAutoSectionMarkdown() +
    `\n## 问题库\n`
  );
}

function baseDeployTemplate() {
  return (
    `# 项目部署操作手册\n\n` +
    `目标：任何具备权限的同学照着做能把最终包部署到生产，并能回滚。\n\n` +
    buildAutoSectionMarkdown() +
    `\n## 1. 前置条件\n\n` +
    `## 2. 构建产物\n\n` +
    `## 3. 配置注入（dev/test/prod）\n\n` +
    `## 4. 发布步骤\n\n` +
    `## 5. 验证与观测\n\n` +
    `## 6. 回滚\n\n` +
    `## 7. 常见故障与处理\n`
  );
}

async function ensureDocFile(filePath, type) {
  const exists = await fileExists(filePath);
  if (exists) return;
  let content = "";
  if (type === "talk") content = baseTalkTemplate();
  if (type === "devlog") content = baseDevlogTemplate();
  if (type === "deploy") content = baseDeployTemplate();
  await fs.writeFile(filePath, content, "utf8");
}

async function updateLocalDoc({ filePath, docType, env, changeId, delta, summary, cwd, triggerFiles = [] }) {
  const context = buildContext({ delta, summary, cwd, triggerFiles });
  const raw = await fs.readFile(filePath, "utf8");

  const ensured = raw.includes("<!-- PDK_AUTO_SECTION -->")
    ? raw
    : `${raw.trimEnd()}\n\n${buildAutoSectionMarkdown()}\n`;

  let latestBlock = buildLatestLine({ env, changeId, summary: context.summary });
  let entry = buildHistoryEntryMarkdown({ env, changeId, delta, summary: context.summary });

  if (docType === "talk") {
    latestBlock = buildTalkLatestBlock({ env, changeId, context });
    entry = buildTalkHistoryEntry({ env, changeId, context });
  }
  if (docType === "devlog") {
    latestBlock = buildDevlogLatestBlock({ env, changeId, context });
    entry = buildDevlogHistoryEntry({ env, changeId, context });
  }
  if (docType === "deploy") {
    latestBlock = buildDeployLatestBlock({ env, changeId, context });
    entry = buildDeployHistoryEntry({ env, changeId, context });
  }

  let next = replaceLatestBlock(ensured, latestBlock);

  if (changeId && next.includes(`<!-- PDK_CHANGE_ID:${changeId} -->`)) {
    if (next !== raw) {
      await fs.writeFile(filePath, next, "utf8");
    }
    return { updatedLatest: true, appendedHistory: false };
  }

  next = insertHistoryEntry(next, entry);
  await fs.writeFile(filePath, next, "utf8");
  return { updatedLatest: true, appendedHistory: true };
}

function getRepoRoot(cwd) {
  const gitDir = path.join(cwd, ".git");
  return { repoRoot: cwd, gitHooksDir: path.join(gitDir, "hooks") };
}

function buildHookScript() {
  return `#!/bin/sh
# PDK_GIT_HOOK
set -e
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ]; then
  exit 0
fi
node "$ROOT/.trae/skills/project-docs-keeper/scripts/project-docs-keeper.mjs" >/dev/null 2>&1 || true
`;
}

async function installGitHooks({ cwd }) {
  const { gitHooksDir } = getRepoRoot(cwd);
  await ensureDir(gitHooksDir);

  const hookNames = ["post-commit", "post-merge", "post-checkout"];
  const script = buildHookScript();

  for (const hookName of hookNames) {
    const hookPath = path.join(gitHooksDir, hookName);
    const existing = await readTextIfExists(hookPath);
    if (existing && !existing.includes("PDK_GIT_HOOK")) {
      throw new Error(`git hook exists and is not managed by PDK: ${hookPath}`);
    }
    await fs.writeFile(hookPath, script, "utf8");
    try {
      await fs.chmod(hookPath, 0o755);
    } catch {}
  }

  return hookNames.map((name) => path.join(gitHooksDir, name));
}

async function uninstallGitHooks({ cwd }) {
  const { gitHooksDir } = getRepoRoot(cwd);
  const hookNames = ["post-commit", "post-merge", "post-checkout"];
  const removed = [];

  for (const hookName of hookNames) {
    const hookPath = path.join(gitHooksDir, hookName);
    const existing = await readTextIfExists(hookPath);
    if (!existing) continue;
    if (!existing.includes("PDK_GIT_HOOK")) continue;
    await fs.unlink(hookPath);
    removed.push(hookPath);
  }

  return removed;
}

async function updateDocsOnce({ env, createMissing, cwd, outDir, changeIdOverride, summaryOverride, triggerFiles = [] }) {
  const delta = await getGitDelta(cwd);
  const changeId = safeTrim(changeIdOverride || delta?.commit || "");
  const summary = safeTrim(summaryOverride || delta?.message || "");
  const context = buildContext({ delta, summary, cwd, triggerFiles });

  await ensureDir(outDir);

  const talkPath = path.join(outDir, "项目宣讲稿.md");
  const devlogPath = path.join(outDir, "项目开发过程记录.md");
  const deployPath = path.join(outDir, "项目部署操作手册.md");

  if (createMissing) {
    await ensureDocFile(talkPath, "talk");
    await ensureDocFile(devlogPath, "devlog");
    await ensureDocFile(deployPath, "deploy");
  }

  const results = {
    项目宣讲稿: await updateLocalDoc({ filePath: talkPath, docType: "talk", env, changeId, delta, summary, cwd, triggerFiles }),
    项目开发过程记录: await updateLocalDoc({ filePath: devlogPath, docType: "devlog", env, changeId, delta, summary, cwd, triggerFiles }),
    项目部署操作手册: await updateLocalDoc({ filePath: deployPath, docType: "deploy", env, changeId, delta, summary, cwd, triggerFiles }),
  };

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        action: "update-docs",
        env,
        hasGit: Boolean(delta),
        changeId: changeId || null,
        summary: summary || null,
        sourceFiles: context.sourceFiles,
        affectedModules: context.affectedModules,
        outDir,
        docs: { talk: talkPath, devlog: devlogPath, deploy: deployPath },
        results,
        platform: os.platform(),
      },
      null,
      2
    ) + "\n"
  );
}

function normalizePathForCompare(inputPath) {
  return path.resolve(inputPath).replace(/\//g, "\\").toLowerCase();
}

function shouldIgnoreWatchEvent(fullPath, { outDir, cwd }) {
  const target = normalizePathForCompare(fullPath);
  const ignoredRoots = [
    outDir,
    path.join(cwd, ".git"),
    path.join(cwd, "node_modules"),
  ].map(normalizePathForCompare);

  if (ignoredRoots.some((root) => target === root || target.startsWith(`${root}\\`))) {
    return true;
  }

  const base = path.basename(target);
  if (base.endsWith(".tmp") || base.endsWith(".swp") || base.endsWith("~")) {
    return true;
  }

  return false;
}

async function runWatchMode({ env, createMissing, cwd, outDir, watchRoot, watchDebounceMs }) {
  await updateDocsOnce({ env, createMissing, cwd, outDir });

  if (os.platform() !== "win32" && os.platform() !== "darwin") {
    throw new Error("watch mode currently expects fs.watch recursive support on Windows or macOS");
  }

  let debounceTimer = null;
  let running = false;
  let rerunRequested = false;
  let lastEventPath = null;
  const pendingTriggerFiles = new Set();

  const scheduleRun = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (running) {
        rerunRequested = true;
        return;
      }

      running = true;
      const triggerFiles = [...pendingTriggerFiles];
      pendingTriggerFiles.clear();
      try {
        await updateDocsOnce({ env, createMissing, cwd, outDir, triggerFiles });
      } catch (error) {
        process.stderr.write(`[PDK_WATCH_ERROR] ${safeTrim(error?.message || String(error))}\n`);
      } finally {
        running = false;
        if (rerunRequested) {
          rerunRequested = false;
          scheduleRun();
        }
      }
    }, watchDebounceMs);
  };

  const watcher = fsWatch(
    watchRoot,
    { recursive: true, persistent: true },
    (eventType, filename) => {
      const relative = filename ? String(filename) : "";
      const fullPath = relative ? path.resolve(watchRoot, relative) : watchRoot;
      if (shouldIgnoreWatchEvent(fullPath, { outDir, cwd })) return;
      lastEventPath = fullPath;
      pendingTriggerFiles.add(fullPath);
      process.stdout.write(`[PDK_WATCH_EVENT] ${eventType} ${relative || "(unknown)"}\n`);
      scheduleRun();
    }
  );

  watcher.on("error", (error) => {
    process.stderr.write(`[PDK_WATCH_ERROR] ${safeTrim(error?.message || String(error))}\n`);
  });

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        action: "watch-started",
        env,
        outDir,
        watchRoot,
        watchDebounceMs,
      },
      null,
      2
    ) + "\n"
  );

  const shutdown = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          action: "watch-stopped",
          lastEventPath,
        },
        null,
        2
      ) + "\n"
    );
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const env = (options.env || process.env.PDK_ENV || "dev").toLowerCase();
  const createMissing = normalizeBool(options.createMissing ?? process.env.PDK_CREATE_MISSING, true);
  const cwd = process.cwd();
  const outDir = path.resolve(cwd, options.outDir || process.env.PDK_OUT_DIR || "project_docs");
  const watchRoot = path.resolve(cwd, options.watchRoot || ".");
  const watchDebounceMs = Number.parseInt(options.watchDebounceMs || "1200", 10);

  if (options.installGitHooks) {
    const installed = await installGitHooks({ cwd });
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          action: "install-git-hooks",
          installed,
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (options.uninstallGitHooks) {
    const removed = await uninstallGitHooks({ cwd });
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          action: "uninstall-git-hooks",
          removed,
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (options.watch) {
    await runWatchMode({ env, createMissing, cwd, outDir, watchRoot, watchDebounceMs });
    return;
  }

  await updateDocsOnce({
    env,
    createMissing,
    cwd,
    outDir,
    changeIdOverride: options.changeId,
    summaryOverride: options.summary,
  });
}

main().catch((error) => {
  process.stderr.write(
    JSON.stringify(
      {
        ok: false,
        error: {
          message: safeTrim(error?.message || String(error)),
        },
      },
      null,
      2
    ) + "\n"
  );
  process.exitCode = 1;
});
