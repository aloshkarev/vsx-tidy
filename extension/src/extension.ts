import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import * as zlib from "zlib";
import * as vscode from "vscode";
import * as nls from "vscode-nls";
import { spawn, execFile } from "child_process";
import { JsonRpcConnection } from "./protocol";

interface RpcRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface RpcTextEdit {
  range: RpcRange;
  newText: string;
}

interface RpcFix {
  title: string;
  edits: RpcTextEdit[];
}

interface RpcDiagnostic {
  range: RpcRange;
  severity: "info" | "warning" | "error";
  code?: string;
  message: string;
  fixes?: RpcFix[];
}

interface PublishDiagnosticsParams {
  runId: string | number;
  fileUri: string;
  diagnostics: RpcDiagnostic[];
}

interface AnalyzeFileResult {
  runId: string | number;
  fileUri: string;
  diagnostics: RpcDiagnostic[];
}

interface ProjectBatch {
  runId: string;
  workspaceKey: string;
  workspaceFolder: vscode.WorkspaceFolder;
  mode: "quick" | "full";
  files: string[];
  total: number;
  done: number;
  priority: number;
  incremental: boolean;
  batchSize: number;
  startedAt?: number;
}

interface ProjectRunState {
  workspaceKey: string;
  workspaceFolder: vscode.WorkspaceFolder;
  groups: ProjectGroup[];
  activeRunId: string | null;
  totalFiles: number;
  doneFiles: number;
  batchSize: number;
  adaptive: boolean;
  adaptiveMinBatch: number;
  adaptiveBackoff: number;
  mode: "quick" | "full";
  incremental: boolean;
}

interface ProjectGroup {
  priority: number;
  files: string[];
  cursor: number;
}

interface Settings {
  clangTidyPath: string;
  compileCommandsPath: string;
  extraArgs: string[];
  maxWorkers: number;
  quickChecks: string;
  maxDiagnosticsPerFile: number;
  maxFixesPerFile: number;
  daemonCacheOnDisk: boolean;
  daemonCacheDir: string;
  perFileTimeoutMs: number;
  publishDiagnosticsThrottleMs: number;
}

type Category =
  | "performance"
  | "readability"
  | "bugprone"
  | "modernize"
  | "security"
  | "portability"
  | "cppcoreguidelines"
  | "clang-diagnostic"
  | "misc"
  | "other";

interface CategoryRule {
  pattern: string;
  category: string;
  kind?: "prefix" | "regex";
}

interface CategoryStyle {
  background?: string;
  border?: string;
  overviewRuler?: string;
}

interface Finding {
  uri: vscode.Uri;
  range: vscode.Range;
  message: string;
  code?: string;
  severity: vscode.DiagnosticSeverity;
  category: Category;
}

interface SimpleEdit {
  range: vscode.Range;
  newText: string;
}

let connection: JsonRpcConnection | null = null;
let diagnostics: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let runCounter = 1;
let clangTidyDetected = false;
const activeRuns = new Set<string>();
let daemonStarting = false;
let daemonRestartAttempts = 0;
let daemonLastStart = 0;
let daemonHealthTimer: NodeJS.Timeout | null = null;
let daemonRestartTimer: NodeJS.Timeout | null = null;

const projectRuns = new Map<string, ProjectRunState>();
const projectRunById = new Map<string, ProjectBatch>();
let projectActiveWorkspaceKey: string | null = null;
const runIdToDocVersion = new Map<string, { uri: string; version: number; usesUnsaved: boolean }>();
const dirtySuppressedFiles = new Set<string>();
const onTypeTimers = new Map<string, NodeJS.Timeout>();

const fixStore = new Map<string, Map<string, RpcFix[]>>();
const categoryStore = new Map<string, Map<Category, vscode.Range[]>>();
const categoryLineStore = new Map<string, Map<Category, vscode.Range[]>>();
const findingStore = new Map<string, Finding[]>();
const fixCountStore = new Map<string, number>();
let categoryRules: Array<{
  pattern: string;
  category: Category;
  kind: "prefix" | "regex";
  regex?: RegExp;
}> = [];
const categoryHighlightDecorationTypes = new Map<Category, vscode.TextEditorDecorationType>();
const categoryIconDecorationTypes = new Map<Category, vscode.TextEditorDecorationType>();
let extensionContext: vscode.ExtensionContext | null = null;
let runtimeCompileCommandsPath: string | null = null;
let selectedCompileCommandsByWorkspace = new Map<string, string>();
let runtimePluginArgs: string[] = [];
let findingsProvider: FindingsProvider | null = null;
let sortedFindingsCache: Finding[] = [];
let totalDiagnosticsCount = 0;
let totalFixesCount = 0;
let failSafeActive = false;
let pendingRefreshTimer: NodeJS.Timeout | null = null;
const pendingRefreshUris = new Set<string>();
const pendingFindingsRefresh = new Set<string>();
const findingsPageState = new Map<string, number>();
let findingsFilter: FindingsFilter | null = null;
let summaryStatusBar: vscode.StatusBarItem | null = null;
const lastDiagnosticsStore = new Map<string, RpcDiagnostic[]>();
const persistedIndices = new Map<string, PersistedIndex>();
const pendingPersist = new Map<string, PersistedFilePayload>();
let persistTimer: NodeJS.Timeout | null = null;
let filteredIndex: PersistedIndex | null = null;
let cachedClangTidyVersion: string | null = null;
let cachedClangTidyPath: string | null = null;
let persistWatchers: vscode.FileSystemWatcher[] = [];
let persistWatcherTimer: NodeJS.Timeout | null = null;
const pendingPersistWatcherFolders = new Set<string>();
const baselineByWorkspace = new Map<string, BaselineData>();

interface FindingsFilter {
  categories?: Set<Category>;
  severities?: Set<vscode.DiagnosticSeverity>;
  checkPattern?: string;
}

interface BaselineData {
  version: number;
  createdAt: number;
  clangTidyVersion: string;
  compileCommandsPath: string;
  compileCommandsMtimeMs: number;
  clangTidyConfigPath: string | null;
  clangTidyConfigMtimeMs: number | null;
  files: Record<string, string[]>;
}

const PERSIST_INDEX_VERSION = 2;

interface PersistedIndex {
  version: number;
  createdAt: number;
  updatedAt: number;
  clangTidyVersion: string;
  compileCommandsPath: string;
  compileCommandsMtimeMs: number;
  clangTidyConfigPath: string | null;
  clangTidyConfigMtimeMs: number | null;
  files: Record<string, PersistedFileEntry>;
}

interface PersistedFileEntry {
  resultFile: string;
  diagnosticsCount: number;
  fixesCount: number;
  categories: Record<string, number>;
  severities: Record<string, number>;
  checks: Record<string, number>;
  updatedAt: number;
}

interface PersistedFilePayload {
  uri: string;
  diagnostics: RpcDiagnostic[];
  fixesCount: number;
  categories: Record<string, number>;
  severities: Record<string, number>;
  checks: Record<string, number>;
  workspaceFolder: vscode.WorkspaceFolder;
}

interface LoadPersistedIndexOptions {
  skipClearOpenFiles?: boolean;
  preserveUri?: string;
}
const warnedNotInCompilation = new Set<string>();
const warnedNoCompileCommands = new Set<string>();
const compileCommandsCache = {
  indices: new Map<string, CompileCommandsIndex>(),
  loading: new Map<string, Promise<CompileCommandsIndex | null>>(),
};

interface CompileCommandsIndex {
  path: string;
  mtimeMs: number;
  files: Set<string>;
  filesList: string[];
}

const localize = nls.loadMessageBundle();
const supportedLanguageIds = new Set(["c", "cpp"]);
const supportedExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".c++",
  ".cppm",
  ".ixx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".inl",
  ".tpp",
]);

const categoryOrder: Category[] = [
  "performance",
  "readability",
  "bugprone",
  "modernize",
  "security",
  "portability",
  "cppcoreguidelines",
  "clang-diagnostic",
  "misc",
  "other",
];

const categoryLabels: Record<Category, string> = {
  performance: "perf",
  readability: "read",
  bugprone: "bug",
  modernize: "mod",
  security: "sec",
  portability: "port",
  cppcoreguidelines: "core",
  "clang-diagnostic": "diag",
  misc: "misc",
  other: "other",
};

const defaultCategoryRules: CategoryRule[] = [
  { pattern: "performance-", category: "performance" },
  { pattern: "readability-", category: "readability" },
  { pattern: "bugprone-", category: "bugprone" },
  { pattern: "modernize-", category: "modernize" },
  { pattern: "security-", category: "security" },
  { pattern: "cert-", category: "security" },
  { pattern: "portability-", category: "portability" },
  { pattern: "cppcoreguidelines-", category: "cppcoreguidelines" },
  { pattern: "hicpp-", category: "cppcoreguidelines" },
  { pattern: "clang-diagnostic-", category: "clang-diagnostic" },
  { pattern: "clang-analyzer-", category: "clang-diagnostic" },
  { pattern: "misc-", category: "misc" },
  { pattern: "google-", category: "readability" },
  { pattern: "llvm-", category: "readability" },
];

const defaultCategoryStyles: Record<Category, CategoryStyle> = {
  performance: {
    background: "rgba(255, 152, 0, 0.18)",
    border: "rgba(255, 152, 0, 0.6)",
    overviewRuler: "rgba(255, 152, 0, 0.9)",
  },
  readability: {
    background: "rgba(66, 165, 245, 0.18)",
    border: "rgba(66, 165, 245, 0.6)",
    overviewRuler: "rgba(66, 165, 245, 0.9)",
  },
  bugprone: {
    background: "rgba(244, 67, 54, 0.18)",
    border: "rgba(244, 67, 54, 0.6)",
    overviewRuler: "rgba(244, 67, 54, 0.9)",
  },
  modernize: {
    background: "rgba(0, 188, 212, 0.18)",
    border: "rgba(0, 188, 212, 0.6)",
    overviewRuler: "rgba(0, 188, 212, 0.9)",
  },
  security: {
    background: "rgba(233, 30, 99, 0.18)",
    border: "rgba(233, 30, 99, 0.6)",
    overviewRuler: "rgba(233, 30, 99, 0.9)",
  },
  portability: {
    background: "rgba(121, 85, 72, 0.18)",
    border: "rgba(121, 85, 72, 0.6)",
    overviewRuler: "rgba(121, 85, 72, 0.9)",
  },
  cppcoreguidelines: {
    background: "rgba(76, 175, 80, 0.18)",
    border: "rgba(76, 175, 80, 0.6)",
    overviewRuler: "rgba(76, 175, 80, 0.9)",
  },
  "clang-diagnostic": {
    background: "rgba(158, 158, 158, 0.18)",
    border: "rgba(158, 158, 158, 0.6)",
    overviewRuler: "rgba(158, 158, 158, 0.9)",
  },
  misc: {
    background: "rgba(255, 214, 0, 0.18)",
    border: "rgba(255, 214, 0, 0.6)",
    overviewRuler: "rgba(255, 214, 0, 0.9)",
  },
  other: {
    background: "rgba(120, 144, 156, 0.18)",
    border: "rgba(120, 144, 156, 0.6)",
    overviewRuler: "rgba(120, 144, 156, 0.9)",
  },
};

function hashString(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function diagnosticKey(d: RpcDiagnostic): string {
  return `${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character}|${d.code ?? ""}|${d.message}`;
}

function getSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  const configuredCompile = cfg.get<string>("compileCommandsPath", "").trim();
  const effectiveCompile = configuredCompile || runtimeCompileCommandsPath || "";
  const extraArgs = mergeExtraArgs(cfg.get<string[]>("extraArgs", []), runtimePluginArgs);
  return {
    clangTidyPath: cfg.get<string>("clangTidyPath", "clang-tidy"),
    compileCommandsPath: effectiveCompile,
    extraArgs,
    maxWorkers: cfg.get<number>("maxWorkers", 4),
    quickChecks: cfg.get<string>("quickChecks", "clang-diagnostic-*"),
    maxDiagnosticsPerFile: cfg.get<number>("maxDiagnosticsPerFile", 1000),
    maxFixesPerFile: cfg.get<number>("maxFixesPerFile", 300),
    daemonCacheOnDisk: cfg.get<boolean>("daemonCacheOnDisk", true),
    daemonCacheDir: cfg.get<string>("daemonCacheDir", ""),
    perFileTimeoutMs: cfg.get<number>("perFileTimeoutMs", 0),
    publishDiagnosticsThrottleMs: cfg.get<number>("publishDiagnosticsThrottleMs", 0),
  };
}

function getModes(): { onSave: "quick" | "full"; manual: "quick" | "full" } {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  const onSave = cfg.get<"quick" | "full">("onSaveMode", "quick");
  const manual = cfg.get<"quick" | "full">("manualMode", "full");
  return { onSave, manual };
}

function getDaemonPath(context: vscode.ExtensionContext): string | null {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  const configured = cfg.get<string>("daemonPath", "").trim();
  const candidates = [] as string[];
  if (configured) candidates.push(configured);
  const platform = process.platform;
  const arch = process.arch;
  const platformTag = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform;
  const archTag = arch === "arm64" ? "arm64" : "x64";
  const binDir = path.join(context.extensionPath, "bin");
  candidates.push(path.join(binDir, `clang-tidy-daemon-${platformTag}-${archTag}`));
  candidates.push(path.join(binDir, "clang-tidy-daemon"));
  candidates.push(path.join(context.extensionPath, "..", "daemon", "target", "debug", "clang-tidy-daemon"));

  for (const p of candidates) {
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

async function getDaemonPathAsync(context: vscode.ExtensionContext): Promise<string | null> {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  const configured = cfg.get<string>("daemonPath", "").trim();
  if (configured && fs.existsSync(configured) && fs.statSync(configured).isFile()) {
    return configured;
  }
  const platform = process.platform;
  const arch = process.arch;
  const platformTag = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform;
  const archTag = arch === "arm64" ? "arm64" : "x64";
  const binDir = path.join(context.extensionPath, "bin");
  const candidates = [
    path.join(binDir, `clang-tidy-daemon-${platformTag}-${archTag}`),
    path.join(binDir, "clang-tidy-daemon"),
    path.join(context.extensionPath, "..", "daemon", "target", "debug", "clang-tidy-daemon"),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  const which = await resolveWhich("clang-tidy-daemon");
  if (which && (await pathExists(which))) return which;
  return null;
}

function rpcRangeToVs(range: RpcRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character)
  );
}

function toVsDiagnostic(fileUri: string, d: RpcDiagnostic): vscode.Diagnostic {
  const range = rpcRangeToVs(d.range);
  const diag = new vscode.Diagnostic(range, d.message, severityToVs(d.severity));
  diag.source = "clang-tidy";
  if (d.code) diag.code = d.code;
  const category = resolveCategory(d.code);
  const related: vscode.DiagnosticRelatedInformation[] = [];
  try {
    const uri = vscode.Uri.parse(fileUri);
    related.push(
      new vscode.DiagnosticRelatedInformation(
        new vscode.Location(uri, range),
        `Category: ${category}`
      )
    );
    if (d.code) {
      related.push(
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(uri, range),
          `Check: ${d.code}`
        )
      );
    }
  } catch {
    // ignore
  }
  if (related.length > 0) {
    diag.relatedInformation = related;
  }
  return diag;
}

function severityToVs(sev: RpcDiagnostic["severity"]): vscode.DiagnosticSeverity {
  switch (sev) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

function severityKeyFromVs(sev: vscode.DiagnosticSeverity): string {
  switch (sev) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "warning";
  }
}

function clearDaemonTimers(): void {
  if (daemonHealthTimer) {
    clearInterval(daemonHealthTimer);
    daemonHealthTimer = null;
  }
  if (daemonRestartTimer) {
    clearTimeout(daemonRestartTimer);
    daemonRestartTimer = null;
  }
}

function scheduleDaemonRestart(context: vscode.ExtensionContext): void {
  if (!getDaemonAutoRestart()) return;
  if (daemonRestartAttempts >= getDaemonRestartMaxAttempts()) {
    output.appendLine(
      localize(
        "msg.daemonRestartGiveUp",
        "Clang-Tidy daemon restart limit reached. Manual restart required."
      )
    );
    return;
  }
  const delay = getDaemonRestartDelayMs();
  daemonRestartAttempts += 1;
  output.appendLine(
    localize(
      "msg.daemonRestartScheduled",
      "Clang-Tidy daemon restart scheduled in {0} ms (attempt {1}).",
      String(delay),
      String(daemonRestartAttempts)
    )
  );
  daemonRestartTimer = setTimeout(() => {
    daemonRestartTimer = null;
    void startDaemon(context);
  }, delay);
}

function startDaemonHealthChecks(context: vscode.ExtensionContext): void {
  const interval = getDaemonHealthCheckIntervalMs();
  if (interval <= 0) return;
  if (daemonHealthTimer) return;
  daemonHealthTimer = setInterval(() => {
    if (!connection) return;
    connection
      .sendRequest("ping", { ts: Date.now() })
      .catch(() => {
        output.appendLine(
          localize("msg.daemonHealthFail", "Clang-Tidy daemon health check failed.")
        );
        connection?.dispose();
        connection = null;
        scheduleDaemonRestart(context);
      });
  }, interval);
}

async function startDaemon(context: vscode.ExtensionContext): Promise<void> {
  if (connection) return;
  if (daemonStarting) return;
  daemonStarting = true;
  const daemonPath = await getDaemonPathAsync(context);
  if (!daemonPath) {
    const remoteName = getRemoteName();
    const remote = remoteName ? ` (remote: ${remoteName})` : "";
    const platformInfo = `${process.platform}/${process.arch}${remote}`;
    if (getFallbackToCli()) {
      vscode.window.showWarningMessage(
        localize(
          "msg.daemonFallback",
          "Clang-Tidy daemon not found. Falling back to CLI mode (slower, no fix-its). ({0})",
          platformInfo
        )
      );
    } else {
      vscode.window.showErrorMessage(
        localize(
          "msg.daemonNotFound",
          "Clang-Tidy daemon not found. Set clangTidy.daemonPath or place a platform binary in extension/bin. ({0})",
          platformInfo
        )
      );
    }
    daemonStarting = false;
    return;
  }

  output.appendLine(
    localize("msg.daemonStarting", "Starting clang-tidy daemon: {0}", daemonPath)
  );
  daemonLastStart = Date.now();
  const proc = spawn(daemonPath, ["--stdio"], { stdio: "pipe" });
  connection = new JsonRpcConnection(proc);
  proc.on("error", (err) => {
    output.appendLine(
      localize("msg.daemonError", "Clang-Tidy daemon error: {0}", err.message)
    );
  });
  proc.on("exit", (code, signal) => {
    output.appendLine(
      localize(
        "msg.daemonExit",
        "Clang-Tidy daemon exited (code={0}, signal={1}).",
        String(code ?? ""),
        String(signal ?? "")
      )
    );
    clearDaemonTimers();
    connection = null;
    resetRuntimeForDaemonRestart();
    if (Date.now() - daemonLastStart < 2000) {
      daemonRestartAttempts = getDaemonRestartMaxAttempts();
    }
    scheduleDaemonRestart(context);
  });
  connection.onNotification((method, params) => {
    if (method === "publishDiagnostics") {
      handlePublishDiagnostics(params as PublishDiagnosticsParams);
    } else if (method === "progress") {
      const p = params as { runId: string | number; kind: string; message?: string; percent?: number };
      if (p.message) output.appendLine(`[progress] ${p.message}`);
      handleProgress(p);
    } else if (method === "log") {
      const l = params as { level: string; message: string };
      output.appendLine(`[${l.level}] ${l.message}`);
    }
  });

  const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "";
  try {
    await connection.sendRequest("initialize", {
      rootUri,
      client: { name: "clang-tidy-vscode", version: "0.1.0" },
      capabilities: { supportsProgress: true },
      settings: getSettings(),
    });
    daemonRestartAttempts = 0;
    output.appendLine(localize("msg.daemonReady", "Clang-Tidy daemon ready."));
    startDaemonHealthChecks(context);
  } catch (err) {
    output.appendLine(
      localize(
        "msg.daemonInitFailed",
        "Failed to initialize clang-tidy daemon: {0}",
        (err as Error).message
      )
    );
    vscode.window.showErrorMessage(
      localize("msg.daemonInitFailedShort", "Failed to initialize clang-tidy daemon. See Output for details.")
    );
    connection?.dispose();
    connection = null;
    scheduleDaemonRestart(context);
  } finally {
    daemonStarting = false;
  }
}

function normalizeCategory(raw: string | undefined): Category {
  if (!raw) return "other";
  return categoryOrder.includes(raw as Category) ? (raw as Category) : "other";
}

function compileCategoryRules(rules: CategoryRule[]): void {
  categoryRules = [];
  for (const rule of rules) {
    if (!rule || typeof rule.pattern !== "string" || rule.pattern.trim().length === 0) continue;
    const category = normalizeCategory(rule.category);
    const kind = rule.kind === "regex" ? "regex" : "prefix";
    if (kind === "regex") {
      try {
        const regex = new RegExp(rule.pattern);
        categoryRules.push({ pattern: rule.pattern, category, kind, regex });
      } catch {
        // Skip invalid regex rules.
      }
      continue;
    }
    categoryRules.push({ pattern: rule.pattern, category, kind });
  }
}

function resolveCategory(code?: string): Category {
  const value = code ?? "";
  for (const rule of categoryRules) {
    if (rule.kind === "regex") {
      if (rule.regex?.test(value)) return rule.category;
      continue;
    }
    if (value.startsWith(rule.pattern)) return rule.category;
  }
  return "other";
}

function readCategoryStyles(): Record<Category, CategoryStyle> {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  const raw = cfg.get<Record<string, unknown>>("categoryColors", defaultCategoryStyles as unknown as Record<string, unknown>);
  const merged: Record<Category, CategoryStyle> = { ...defaultCategoryStyles };
  for (const category of categoryOrder) {
    const value = raw?.[category];
    if (!value) continue;
    if (typeof value === "string") {
      merged[category] = {
        background: value,
        border: value,
        overviewRuler: value,
      };
      continue;
    }
    if (typeof value === "object") {
      const v = value as CategoryStyle;
      merged[category] = {
        background: v.background ?? merged[category].background,
        border: v.border ?? merged[category].border,
        overviewRuler: v.overviewRuler ?? merged[category].overviewRuler,
      };
    }
  }
  return merged;
}

function shouldShowCategoryLabels(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("showCategoryLabels", true);
}

function getUiDebounceMs(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("updateDebounceMs", 150);
}

function getDiagnosticsCapPerFile(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("maxDiagnosticsPerFile", 1000);
}

function getFixesCapPerFile(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("maxFixesPerFile", 300);
}

function getMaxTotalDiagnostics(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("maxTotalDiagnostics", 50000);
}

function getFailSafeThreshold(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("failSafeTotalDiagnostics", 75000);
}

function getFailSafeAutoCancel(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("failSafeAutoCancel", true);
}

function getFailSafeDisableDecorations(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("failSafeDisableDecorations", true);
}

function getFindingsPageSize(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("findingsPageSize", 200);
}

function getBaselineEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("baselineEnabled", false);
}

function getProjectBatchSize(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("projectBatchSize", 250);
}

function getProjectIncremental(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("projectIncremental", true);
}

function getProjectPrioritizeActive(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("projectPrioritizeActive", true);
}

function getProjectPrioritizeOpen(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("projectPrioritizeOpen", true);
}

function getProjectDiffOnly(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("projectDiffOnly", false);
}

function getProjectDiffIncludeUntracked(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("projectDiffIncludeUntracked", true);
}

function getProjectAdaptiveBatching(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("projectAdaptiveBatching", true);
}

function getProjectAdaptiveMinBatchSize(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("projectAdaptiveMinBatchSize", 25);
}

function getProjectAdaptiveBackoffFactor(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("projectAdaptiveBackoffFactor", 0.5);
}

function getOnTypeEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("onType", false);
}

function getOnTypeMode(): "quick" | "full" {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<"quick" | "full">("onTypeMode", "quick");
}

function getOnTypeDebounceMs(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("onTypeDebounceMs", 400);
}

function getDaemonAutoRestart(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("daemonAutoRestart", true);
}

function getDaemonRestartMaxAttempts(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("daemonRestartMaxAttempts", 3);
}

function getDaemonRestartDelayMs(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("daemonRestartDelayMs", 1500);
}

function getDaemonHealthCheckIntervalMs(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("daemonHealthCheckIntervalMs", 20000);
}

function getRemoteName(): string | undefined {
  const env = vscode.env as { remoteName?: string };
  return env.remoteName;
}

function getFallbackToCli(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("fallbackToCli", true);
}

function getAutoLoadPersistedOnStartup(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("autoLoadPersistedOnStartup", true);
}

function resetRuntimeForDaemonRestart(): void {
  activeRuns.clear();
  projectRuns.clear();
  projectRunById.clear();
  projectActiveWorkspaceKey = null;
  runIdToDocVersion.clear();
  updateStatusBar();
}

async function diagnoseEnvironment(context: vscode.ExtensionContext): Promise<void> {
  const lines: string[] = [];
  const remote = getRemoteName() ?? "local";
  lines.push(`# Clang-Tidy Environment`);
  lines.push(``);
  lines.push(`Remote: ${remote}`);
  lines.push(`Platform: ${process.platform}`);
  lines.push(`Arch: ${process.arch}`);

  const daemonPath = await getDaemonPathAsync(context);
  lines.push(`Daemon: ${daemonPath ?? "not found"}`);

  const cfg = vscode.workspace.getConfiguration("clangTidy");
  const configuredClang = cfg.get<string>("clangTidyPath", "clang-tidy").trim();
  const clangPath = await findClangTidyPath(configuredClang);
  lines.push(`clang-tidy: ${clangPath ?? "not found"}`);
  if (clangPath) {
    const versionLine = await getClangTidyVersion(clangPath);
    if (versionLine) lines.push(`clang-tidy version: ${versionLine}`);
  }

  const configuredCompile = cfg.get<string>("compileCommandsPath", "").trim();
  lines.push(`compile_commands configured: ${configuredCompile || "(empty)"}`);

  const folders = vscode.workspace.workspaceFolders ?? [];
  lines.push(`workspace folders: ${folders.length}`);
  for (const folder of folders) {
    lines.push(``);
    lines.push(`- ${folder.name}: ${folder.uri.fsPath}`);
    const candidates = await findCompileCommandsCandidates(folder);
    lines.push(`  compile_commands candidates: ${candidates.length}`);
    if (candidates.length > 0) {
      lines.push(`  sample: ${candidates[0].path}`);
    }
  }

  output.appendLine(lines.join("\n"));
  output.show(true);
}

function getUseUnsavedBuffer(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("useUnsavedBuffer", true);
}

function getUnsavedBufferMaxBytes(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("unsavedBufferMaxBytes", 1000000);
}

function getPersistResultsEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("persistResults", true);
}

function getPersistDebounceMs(): number {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<number>("persistDebounceMs", 500);
}

function parseColorToRgb(color: string): { r: number; g: number; b: number } | null {
  const hex = color.trim();
  if (/^#([0-9a-fA-F]{6})$/.test(hex)) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return { r, g, b };
  }
  const rgbMatch = color.match(/rgba?\s*\(\s*(\d+)[, ]+(\d+)[, ]+(\d+)/i);
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    if ([r, g, b].every((v) => Number.isFinite(v))) {
      return { r, g, b };
    }
  }
  return null;
}

function pickTextColor(color: string): string {
  const rgb = parseColorToRgb(color);
  if (!rgb) return "#ffffff";
  const brightness = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
  return brightness > 150 ? "#000000" : "#ffffff";
}

function makeGutterIcon(category: Category, style: CategoryStyle): vscode.Uri {
  const base = style.overviewRuler ?? style.border ?? style.background ?? "#808080";
  const rgb = parseColorToRgb(base);
  const fill = rgb ? `rgb(${rgb.r},${rgb.g},${rgb.b})` : base;
  const textColor = pickTextColor(fill);
  const label = categoryLabels[category].toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">
  <rect x="1" y="1" width="12" height="12" rx="3" ry="3" fill="${fill}" stroke="${fill}" stroke-width="1"/>
  <text x="7" y="9" text-anchor="middle" font-family="Arial, sans-serif" font-size="7" fill="${textColor}">${label}</text>
</svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

function rebuildCategoryDecorations(styles: Record<Category, CategoryStyle>): void {
  const showLabels = shouldShowCategoryLabels();
  const disableDecorations = failSafeActive && getFailSafeDisableDecorations();
  for (const [, deco] of categoryHighlightDecorationTypes) {
    deco.dispose();
  }
  for (const [, deco] of categoryIconDecorationTypes) {
    deco.dispose();
  }
  categoryHighlightDecorationTypes.clear();
  categoryIconDecorationTypes.clear();

  if (disableDecorations) {
    return;
  }

  for (const category of categoryOrder) {
    const style = styles[category];
    const highlightOptions: vscode.DecorationRenderOptions = {
      backgroundColor: style.background,
      overviewRulerColor: style.overviewRuler,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    };
    if (style.border) {
      highlightOptions.border = `1px solid ${style.border}`;
    }

    const iconOptions: vscode.DecorationRenderOptions = {
      gutterIconPath: makeGutterIcon(category, style),
      gutterIconSize: "contain",
    };
    if (showLabels) {
      const label = categoryLabels[category];
      iconOptions.before = {
        contentText: label,
        color: style.border ?? style.overviewRuler ?? undefined,
        backgroundColor: style.background,
        margin: "0 6px 0 0",
      };
    }

    categoryHighlightDecorationTypes.set(category, vscode.window.createTextEditorDecorationType(highlightOptions));
    categoryIconDecorationTypes.set(category, vscode.window.createTextEditorDecorationType(iconOptions));
  }
}

function applyCategoryDecorationsForEditor(editor: vscode.TextEditor): void {
  if (failSafeActive && getFailSafeDisableDecorations()) return;
  const uri = editor.document.uri.toString();
  const perCategory = categoryStore.get(uri) ?? new Map<Category, vscode.Range[]>();
  const perLine = categoryLineStore.get(uri) ?? new Map<Category, vscode.Range[]>();
  for (const category of categoryOrder) {
    const ranges = perCategory.get(category) ?? [];
    const highlight = categoryHighlightDecorationTypes.get(category);
    if (highlight) editor.setDecorations(highlight, ranges);
    const iconRanges = perLine.get(category) ?? [];
    const icon = categoryIconDecorationTypes.get(category);
    if (icon) editor.setDecorations(icon, iconRanges);
  }
}

function applyCategoryDecorationsForUri(fileUri: string): void {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === fileUri) {
      applyCategoryDecorationsForEditor(editor);
    }
  }
}

function refreshCategoryDecorations(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    applyCategoryDecorationsForEditor(editor);
  }
}

function scheduleUiRefresh(fileUri: string): void {
  pendingRefreshUris.add(fileUri);
  pendingFindingsRefresh.add(fileUri);
  if (pendingRefreshTimer) return;
  const delay = getUiDebounceMs();
  pendingRefreshTimer = setTimeout(() => {
    pendingRefreshTimer = null;
    if (pendingFindingsRefresh.size > 0) {
      rebuildFindingsCache();
      findingsProvider?.refresh();
      updateSummaryStatusBar();
      pendingFindingsRefresh.clear();
    }
    for (const uri of pendingRefreshUris) {
      applyCategoryDecorationsForUri(uri);
    }
    pendingRefreshUris.clear();
  }, delay);
}

function enterFailSafe(reason: string): void {
  if (failSafeActive) return;
  failSafeActive = true;
  output.appendLine(localize("msg.failSafe", "Clang-Tidy: fail-safe activated ({0})", reason));
  if (getFailSafeAutoCancel()) {
    void stopAnalysis();
  }
  rebuildCategoryDecorations(readCategoryStyles());
  refreshCategoryDecorations();
}

function getSummaryStatusEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  return cfg.get<boolean>("showSummaryStatus", true);
}

function updateSummaryStatusBar(): void {
  if (!summaryStatusBar) return;
  if (!getSummaryStatusEnabled()) {
    summaryStatusBar.hide();
    return;
  }

  const counts = new Map<Category, number>();
  for (const category of categoryOrder) counts.set(category, 0);
  const entries = getIndexEntries();
  for (const { entry } of entries) {
    for (const category of categoryOrder) {
      const count = entry.categories?.[category] ?? 0;
      if (count > 0) {
        counts.set(category, (counts.get(category) ?? 0) + count);
      }
    }
  }

  const parts: string[] = [];
  for (const category of categoryOrder) {
    const count = counts.get(category) ?? 0;
    if (count > 0) {
      parts.push(`${categoryLabels[category]} ${count}`);
    }
  }

  if (parts.length === 0) {
    summaryStatusBar.text = localize("status.summaryEmpty", "Clang-Tidy: no findings");
    summaryStatusBar.tooltip = localize("status.summaryEmpty", "Clang-Tidy: no findings");
    summaryStatusBar.show();
    return;
  }

  const summary = parts.slice(0, 6).join(" · ");
  summaryStatusBar.text = `Clang-Tidy: ${summary}`;
  summaryStatusBar.tooltip = parts.join(" · ");
  summaryStatusBar.show();
}

function matchesFilter(finding: Finding, filter: FindingsFilter): boolean {
  if (filter.categories && filter.categories.size > 0 && !filter.categories.has(finding.category)) {
    return false;
  }
  if (filter.severities && filter.severities.size > 0 && !filter.severities.has(finding.severity)) {
    return false;
  }
  if (filter.checkPattern && finding.code) {
    if (!finding.code.includes(filter.checkPattern)) {
      return false;
    }
  } else if (filter.checkPattern && !finding.code) {
    return false;
  }
  return true;
}

function getIndexEntries(): Array<{ uri: string; entry: PersistedFileEntry }> {
  if (filteredIndex) {
    return Object.entries(filteredIndex.files).map(([uri, entry]) => ({ uri, entry }));
  }
  if (!getPersistResultsEnabled()) {
    const items: Array<{ uri: string; entry: PersistedFileEntry }> = [];
    for (const [uri, findings] of findingStore.entries()) {
      const categories: Record<string, number> = {};
      const severities: Record<string, number> = {};
      for (const finding of findings) {
        categories[finding.category] = (categories[finding.category] ?? 0) + 1;
        const sev =
          finding.severity === vscode.DiagnosticSeverity.Error
            ? "error"
            : finding.severity === vscode.DiagnosticSeverity.Warning
            ? "warning"
            : "info";
        severities[sev] = (severities[sev] ?? 0) + 1;
      }
      items.push({
        uri,
        entry: {
          resultFile: "",
          diagnosticsCount: findings.length,
          fixesCount: fixCountStore.get(uri) ?? 0,
          categories,
          severities,
          checks: {},
          updatedAt: Date.now(),
        },
      });
    }
    return items;
  }
  return getAllPersistedEntries();
}

function getAllPersistedEntries(): Array<{ uri: string; entry: PersistedFileEntry }> {
  const items: Array<{ uri: string; entry: PersistedFileEntry }> = [];
  for (const index of persistedIndices.values()) {
    for (const [uri, entry] of Object.entries(index.files)) {
      items.push({ uri, entry });
    }
  }
  return items;
}

async function promptFindingsFilter(): Promise<FindingsFilter | null> {
  const categoryItems = categoryOrder.map((category) => ({
    label: category,
    picked: findingsFilter?.categories?.has(category) ?? false,
  }));
  const pickedCategories = await vscode.window.showQuickPick(categoryItems, {
    canPickMany: true,
    placeHolder: localize("msg.filterCategories", "Filter by categories (optional)"),
  });
  if (!pickedCategories) return null;

  const severityItems = [
    { label: "error", value: vscode.DiagnosticSeverity.Error },
    { label: "warning", value: vscode.DiagnosticSeverity.Warning },
    { label: "info", value: vscode.DiagnosticSeverity.Information },
    { label: "hint", value: vscode.DiagnosticSeverity.Hint },
  ].map((item) => ({
    label: item.label,
    value: item.value,
    picked: findingsFilter?.severities?.has(item.value) ?? false,
  }));

  const pickedSeverities = await vscode.window.showQuickPick(severityItems, {
    canPickMany: true,
    placeHolder: localize("msg.filterSeverities", "Filter by severities (optional)"),
  });
  if (!pickedSeverities) return null;

  const checkPattern = await vscode.window.showInputBox({
    prompt: localize("msg.filterChecks", "Filter by check name substring (optional)"),
    value: findingsFilter?.checkPattern ?? "",
  });
  if (checkPattern === undefined) return null;

  const filter: FindingsFilter = {};
  if (pickedCategories.length > 0) {
    filter.categories = new Set(pickedCategories.map((c) => c.label as Category));
  }
  if (pickedSeverities.length > 0) {
    filter.severities = new Set(pickedSeverities.map((s) => s.value));
  }
  if (checkPattern.trim().length > 0) {
    filter.checkPattern = checkPattern.trim();
  }

  return filter;
}

async function applyFindingsFilter(filter: FindingsFilter | null): Promise<void> {
  findingsFilter = filter;
  await rebuildFilteredIndexState(filter);
  findingsProvider?.refresh();
  updateSummaryStatusBar();
}

function pickDiagnosticAtCursor(): { doc: vscode.TextDocument; diagnostic: vscode.Diagnostic } | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const doc = editor.document;
  const diags = diagnostics.get(doc.uri);
  if (!diags || diags.length === 0) return null;
  const pos = editor.selection.active;
  let best: vscode.Diagnostic | null = null;
  for (const d of diags) {
    if (!d.range.contains(pos)) continue;
    if (!best) {
      best = d;
      continue;
    }
    const bestLen = (best.range.end.line - best.range.start.line) * 100000 + (best.range.end.character - best.range.start.character);
    const curLen = (d.range.end.line - d.range.start.line) * 100000 + (d.range.end.character - d.range.start.character);
    if (curLen < bestLen) best = d;
  }
  return best ? { doc, diagnostic: best } : null;
}

function reloadCategoryConfig(): void {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  const rules = cfg.get<CategoryRule[]>("categoryRules", defaultCategoryRules);
  compileCategoryRules(Array.isArray(rules) ? rules : defaultCategoryRules);
  const styles = readCategoryStyles();
  rebuildCategoryDecorations(styles);
  refreshCategoryDecorations();
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function collectLoadedPluginPaths(args: string[]): Set<string> {
  const paths = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-load" || arg === "--load") {
      const next = args[i + 1];
      if (next) paths.add(next);
      continue;
    }
    if (arg.startsWith("--load=")) {
      paths.add(arg.slice("--load=".length));
      continue;
    }
    if (arg.startsWith("-load=")) {
      paths.add(arg.slice("-load=".length));
    }
  }
  return paths;
}

function mergeExtraArgs(base: string[], pluginArgs: string[]): string[] {
  const result = [...base];
  const loaded = collectLoadedPluginPaths(base);
  for (const arg of pluginArgs) {
    if (arg.startsWith("--load=")) {
      const pathValue = arg.slice("--load=".length);
      if (loaded.has(pathValue)) continue;
    }
    if (!result.includes(arg)) result.push(arg);
  }
  return result;
}

function isDynamicLibraryFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ext === ".so" || ext === ".dylib" || ext === ".dll";
}

function matchesPluginHint(name: string, hints: string[]): boolean {
  const lower = name.toLowerCase();
  return hints.some((hint) => lower.includes(hint.toLowerCase()));
}

async function findLibraryFilesRecursive(
  root: string,
  depth: number,
  excludes: Set<string>,
  hints: string[]
): Promise<string[]> {
  if (depth < 0) return [];
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  const matches: string[] = [];

  for (const entry of entries) {
    if (entry.isFile() && isDynamicLibraryFile(entry.name)) {
      if (hints.length === 0 || matchesPluginHint(entry.name, hints)) {
        matches.push(path.join(root, entry.name));
      }
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (shouldSkipDir(entry.name, excludes)) continue;
    const found = await findLibraryFilesRecursive(path.join(root, entry.name), depth - 1, excludes, hints);
    matches.push(...found);
  }

  return matches;
}

async function resolvePluginPathsFromInput(
  input: string,
  folder?: vscode.WorkspaceFolder,
  depth = 4,
  excludes = new Set<string>(),
  hints: string[] = []
): Promise<string[]> {
  const candidates: string[] = [];
  const resolved = path.isAbsolute(input)
    ? input
    : folder
    ? path.join(folder.uri.fsPath, input)
    : path.resolve(input);

  const stat = await fs.promises.stat(resolved).catch(() => null);
  if (!stat) return candidates;
  if (stat.isFile()) {
    candidates.push(resolved);
    return candidates;
  }
  if (stat.isDirectory()) {
    return await findLibraryFilesRecursive(resolved, depth, excludes, hints);
  }
  return candidates;
}

async function detectPluginArgs(): Promise<string[]> {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  const autoDetect = cfg.get<boolean>("autoDetectPlugins", true);
  const manualPaths = cfg.get<string[]>("pluginPaths", []);
  const hints = cfg.get<string[]>("pluginNameHints", ["tidy", "clang"]);
  const depth = cfg.get<number>("pluginSearchDepth", 4);
  const excludes = new Set(cfg.get<string[]>("searchExcludeDirs", []));

  const pluginPaths = new Set<string>();
  const folders = vscode.workspace.workspaceFolders ?? [];

  for (const entry of manualPaths) {
    if (!entry) continue;
    if (folders.length > 0 && !path.isAbsolute(entry)) {
      for (const folder of folders) {
        const resolved = await resolvePluginPathsFromInput(entry, folder, depth, excludes, hints);
        resolved.forEach((p) => pluginPaths.add(p));
      }
      continue;
    }
    const resolved = await resolvePluginPathsFromInput(entry, undefined, depth, excludes, hints);
    resolved.forEach((p) => pluginPaths.add(p));
  }

  if (autoDetect) {
    for (const folder of folders) {
      const found = await findLibraryFilesRecursive(folder.uri.fsPath, depth, excludes, hints);
      found.forEach((p) => pluginPaths.add(p));
    }

    const compileCandidates = await findCompileCommandsAcrossWorkspace();
    const buildDirs = new Set<string>();
    for (const candidate of compileCandidates) {
      const parent = path.dirname(candidate.path);
      buildDirs.add(parent);
    }
    for (const dir of buildDirs) {
      const found = await findLibraryFilesRecursive(dir, depth, excludes, hints);
      found.forEach((p) => pluginPaths.add(p));
    }
  }

  const sorted = Array.from(pluginPaths).sort();
  return sorted.map((p) => `--load=${p}`);
}

async function updateRuntimePluginArgs(args: string[]): Promise<void> {
  if (arraysEqual(runtimePluginArgs, args)) return;
  runtimePluginArgs = args;
  if (output) {
    if (args.length === 0) {
      output.appendLine(localize("msg.pluginsNone", "Clang-Tidy: no plugins detected."));
    } else {
      output.appendLine(
        localize(
          "msg.pluginsLoaded",
          "Clang-Tidy: loaded plugins: {0}",
          args.map((arg) => arg.replace(/^--load=/, "")).join(", ")
        )
      );
    }
  }
  if (connection) {
    connection.sendNotification("configChanged", { settings: getSettings() });
  }
}

async function refreshPluginArgs(): Promise<void> {
  const args = await detectPluginArgs();
  await updateRuntimePluginArgs(args);
}

function rebuildFindingsCache(): void {
  const items: Finding[] = [];
  for (const entries of findingStore.values()) {
    items.push(...entries);
  }
  items.sort((a, b) => {
    const aKey = a.uri.toString();
    const bKey = b.uri.toString();
    if (aKey !== bKey) return aKey.localeCompare(bKey);
    if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
    return a.range.start.character - b.range.start.character;
  });
  sortedFindingsCache = items;
}

async function openFinding(finding: Finding): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(finding.uri);
  const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
  editor.selection = new vscode.Selection(finding.range.start, finding.range.start);
  editor.revealRange(finding.range, vscode.TextEditorRevealType.InCenter);
}

function comparePositionToFinding(
  uri: vscode.Uri,
  position: vscode.Position,
  finding: Finding
): number {
  const uriKey = uri.toString();
  const findingKey = finding.uri.toString();
  if (uriKey !== findingKey) return uriKey.localeCompare(findingKey);
  if (position.line !== finding.range.start.line) return position.line - finding.range.start.line;
  return position.character - finding.range.start.character;
}

async function navigateFinding(direction: "next" | "prev"): Promise<void> {
  if (sortedFindingsCache.length === 0) return;

  const editor = vscode.window.activeTextEditor;
  let targetIndex = -1;

  if (editor) {
    const uri = editor.document.uri;
    const position = editor.selection.active;
    if (direction === "next") {
      targetIndex = sortedFindingsCache.findIndex((finding) => comparePositionToFinding(uri, position, finding) < 0);
      if (targetIndex === -1) targetIndex = 0;
    } else {
      for (let i = sortedFindingsCache.length - 1; i >= 0; i -= 1) {
        if (comparePositionToFinding(uri, position, sortedFindingsCache[i]) > 0) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex === -1) targetIndex = sortedFindingsCache.length - 1;
    }
  } else {
    targetIndex = direction === "next" ? 0 : sortedFindingsCache.length - 1;
  }

  const target = sortedFindingsCache[targetIndex];
  await openFinding(target);
}

function getWorkspaceKey(folder: vscode.WorkspaceFolder): string {
  return folder.uri.fsPath;
}

function getWorkspaceForUri(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  if (!uri) return undefined;
  return vscode.workspace.getWorkspaceFolder(uri);
}

function getWorkspaceForUriOrFirst(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return getWorkspaceForUri(uri) ?? vscode.workspace.workspaceFolders?.[0];
}

function loadSelectedCompileCommandsFromState(): void {
  const stored =
    extensionContext?.workspaceState.get<Record<string, string>>("clangTidy.selectedCompileCommands") ?? {};
  selectedCompileCommandsByWorkspace = new Map(Object.entries(stored));
}

async function saveSelectedCompileCommandsToState(): Promise<void> {
  if (!extensionContext) return;
  const obj: Record<string, string> = {};
  for (const [key, value] of selectedCompileCommandsByWorkspace) {
    obj[key] = value;
  }
  await extensionContext.workspaceState.update("clangTidy.selectedCompileCommands", obj);
}

function clearCompileCommandsCaches(): void {
  compileCommandsCache.indices.clear();
  compileCommandsCache.loading.clear();
}

async function updateRuntimeCompileCommandsPath(path: string | null): Promise<void> {
  if (runtimeCompileCommandsPath === path) return;
  runtimeCompileCommandsPath = path;
  clearCompileCommandsCaches();
  warnedNotInCompilation.clear();
  warnedNoCompileCommands.clear();
  if (connection) {
    connection.sendNotification("configChanged", { settings: getSettings() });
  }
  void refreshPluginArgs();
  void loadPersistedIndices();
}

async function setSelectedCompileCommandsPath(
  folder: vscode.WorkspaceFolder | undefined,
  compilePath: string | null
): Promise<void> {
  if (!folder || !compilePath) return;
  selectedCompileCommandsByWorkspace.set(getWorkspaceKey(folder), compilePath);
  await saveSelectedCompileCommandsToState();
  await updateRuntimeCompileCommandsPath(compilePath);
}

async function resolveConfiguredCompileCommandsPath(): Promise<string | null> {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  const configured = cfg.get<string>("compileCommandsPath", "").trim();
  if (!configured) return null;

  const resolved = path.resolve(configured);
  const stat = await fs.promises.stat(resolved).catch(() => null);
  if (stat?.isDirectory()) {
    const candidate = path.join(resolved, "compile_commands.json");
    const exists = await fs.promises.stat(candidate).catch(() => null);
    return exists?.isFile() ? candidate : null;
  }
  return stat?.isFile() ? resolved : null;
}

async function findCompileCommandsCandidates(
  folder: vscode.WorkspaceFolder
): Promise<Array<{ path: string; workspaceFolder: vscode.WorkspaceFolder }>> {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  const excludes = cfg.get<string[]>("searchExcludeDirs", []);
  const depth = cfg.get<number>("searchDepth", 6);
  const found = await findFilesRecursive(folder.uri.fsPath, "compile_commands.json", depth, new Set(excludes));
  return found.map((p) => ({ path: p, workspaceFolder: folder }));
}

async function findCompileCommandsAcrossWorkspace(): Promise<Array<{ path: string; workspaceFolder: vscode.WorkspaceFolder }>> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const results: Array<{ path: string; workspaceFolder: vscode.WorkspaceFolder }> = [];
  for (const folder of folders) {
    const items = await findCompileCommandsCandidates(folder);
    results.push(...items);
  }
  return results;
}

function buildQuickPickItems(
  candidates: Array<{ path: string; workspaceFolder: vscode.WorkspaceFolder }>
): Array<vscode.QuickPickItem & { path: string; workspaceFolder: vscode.WorkspaceFolder }> {
  return candidates.map((candidate) => {
    const relative = vscode.workspace.asRelativePath(candidate.path, false);
    const label = `${candidate.workspaceFolder.name}: ${relative}`;
    return {
      label,
      description: candidate.path,
      path: candidate.path,
      workspaceFolder: candidate.workspaceFolder,
    };
  });
}

async function pickCompileCommandsPath(
  candidates: Array<{ path: string; workspaceFolder: vscode.WorkspaceFolder }>,
  placeholder: string
): Promise<{ path: string; workspaceFolder: vscode.WorkspaceFolder } | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const items = buildQuickPickItems(candidates);
  const pick = await vscode.window.showQuickPick(items, { placeHolder: placeholder });
  if (!pick) return null;
  return { path: pick.path, workspaceFolder: pick.workspaceFolder };
}

async function getCompileCommandsIndexForPath(pathValue: string): Promise<CompileCommandsIndex | null> {
  const existing = compileCommandsCache.indices.get(pathValue);
  if (existing) {
    const stat = await fs.promises.stat(pathValue).catch(() => null);
    if (stat && existing.mtimeMs === stat.mtimeMs) return existing;
  }

  const pending = compileCommandsCache.loading.get(pathValue);
  if (pending) return pending;

  const promise = (async () => {
    const stat = await fs.promises.stat(pathValue).catch(() => null);
    if (!stat) return null;

    const text = await fs.promises.readFile(pathValue, "utf8").catch(() => "");
    if (!text) return null;

    let entries: Array<{ file?: string; directory?: string }> = [];
    try {
      entries = JSON.parse(text);
    } catch {
      return null;
    }

    const files = new Set<string>();
    const filesList: string[] = [];
  for (const entry of entries) {
    if (!entry.file || !entry.directory) continue;
    const full = path.isAbsolute(entry.file) ? entry.file : path.join(entry.directory, entry.file);
    const canon = await realpathSafe(full);
    files.add(canon);
    filesList.push(canon);
  }

  const index: CompileCommandsIndex = {
    path: pathValue,
    mtimeMs: stat.mtimeMs,
    files,
    filesList,
  };
    compileCommandsCache.indices.set(pathValue, index);
    return index;
  })().finally(() => {
    compileCommandsCache.loading.delete(pathValue);
  });

  compileCommandsCache.loading.set(pathValue, promise);
  return promise;
}

async function resolveCompileCommandsPathForUri(
  uri?: vscode.Uri
): Promise<string | null> {
  const configured = await resolveConfiguredCompileCommandsPath();
  if (configured) {
    await updateRuntimeCompileCommandsPath(null);
    return configured;
  }

  const folder = getWorkspaceForUri(uri);
  if (folder) {
    const selected = selectedCompileCommandsByWorkspace.get(getWorkspaceKey(folder));
    if (selected && (await fs.promises.stat(selected).catch(() => null))?.isFile()) {
      await updateRuntimeCompileCommandsPath(selected);
      return selected;
    }
  }

  const candidates = folder ? await findCompileCommandsCandidates(folder) : await findCompileCommandsAcrossWorkspace();
  if (candidates.length === 0) return null;

  if (uri && candidates.length > 1) {
    const filePath = await realpathSafe(uri.fsPath);
    const matches: Array<{ path: string; workspaceFolder: vscode.WorkspaceFolder }> = [];
    for (const candidate of candidates) {
      const index = await getCompileCommandsIndexForPath(candidate.path);
      if (index && index.files.has(filePath)) {
        matches.push(candidate);
      }
    }
    if (matches.length === 1) {
      await setSelectedCompileCommandsPath(matches[0].workspaceFolder, matches[0].path);
      return matches[0].path;
    }
    if (matches.length > 1) {
      const picked = await pickCompileCommandsPath(
        matches,
        localize("msg.pickCompileCommands", "Select compile_commands.json for this file")
      );
      if (picked) {
        await setSelectedCompileCommandsPath(picked.workspaceFolder, picked.path);
        return picked.path;
      }
      return null;
    }
  }

  const picked = await pickCompileCommandsPath(
    candidates,
    localize("msg.pickCompileCommandsProject", "Select compile_commands.json for project analysis")
  );
  if (picked) {
    await setSelectedCompileCommandsPath(picked.workspaceFolder, picked.path);
    return picked.path;
  }
  return null;
}

async function resolveCompileCommandsPathForFolder(
  folder: vscode.WorkspaceFolder
): Promise<string | null> {
  const configured = await resolveConfiguredCompileCommandsPath();
  if (configured) {
    await updateRuntimeCompileCommandsPath(null);
    return configured;
  }

  const selected = selectedCompileCommandsByWorkspace.get(getWorkspaceKey(folder));
  if (selected && (await fs.promises.stat(selected).catch(() => null))?.isFile()) {
    await updateRuntimeCompileCommandsPath(selected);
    return selected;
  }

  const candidates = await findCompileCommandsCandidates(folder);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    await setSelectedCompileCommandsPath(candidates[0].workspaceFolder, candidates[0].path);
    return candidates[0].path;
  }
  const picked = await pickCompileCommandsPath(
    candidates,
    localize("msg.pickCompileCommandsProject", "Select compile_commands.json for project analysis")
  );
  if (picked) {
    await setSelectedCompileCommandsPath(picked.workspaceFolder, picked.path);
    return picked.path;
  }
  return null;
}

function diagnosticCodeToString(
  code: vscode.Diagnostic["code"]
): string | undefined {
  if (!code) return undefined;
  if (typeof code === "string" || typeof code === "number") return String(code);
  const value = (code as { value?: unknown }).value;
  if (value !== undefined) return String(value);
  return undefined;
}

function collectAllFixEdits(
  document: vscode.TextDocument,
  perFile: Map<string, RpcFix[]>
): SimpleEdit[] {
  const edits: RpcTextEdit[] = [];
  for (const fixes of perFile.values()) {
    for (const fix of fixes) {
      edits.push(...fix.edits);
    }
  }

  if (edits.length === 0) return [];

  const asVsEdits: SimpleEdit[] = edits.map((e) => ({
    range: rpcRangeToVs(e.range),
    newText: e.newText,
  }));

  asVsEdits.sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
    return a.range.start.character - b.range.start.character;
  });

  const filtered: SimpleEdit[] = [];
  let last: vscode.Range | null = null;

  for (const edit of asVsEdits) {
    if (last && last.intersection(edit.range)) {
      output.appendLine(
        localize(
          "msg.fixOverlapSkipped",
          "Clang-Tidy: skipped overlapping fix at {0}:{1}",
          String(edit.range.start.line + 1),
          String(edit.range.start.character + 1)
        )
      );
      continue;
    }
    filtered.push(edit);
    last = edit.range;
  }

  return filtered;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderCategoryLegendHtml(styles: Record<Category, CategoryStyle>): string {
  const title = localize("msg.categoriesTitle", "Clang-Tidy Categories");
  const rows = categoryOrder
    .map((category) => {
      const style = styles[category];
      const background = style.background ?? "transparent";
      const border = style.border ?? "transparent";
      const ruler = style.overviewRuler ?? "transparent";
      return `
        <div class="row">
          <div class="swatches">
            <span class="swatch" style="background:${escapeHtml(background)}; border-color:${escapeHtml(border)};"></span>
            <span class="ruler" style="background:${escapeHtml(ruler)};"></span>
          </div>
          <div class="label">${escapeHtml(category)}</div>
          <div class="meta">
            <code>${escapeHtml(background)}</code>
            <code>${escapeHtml(border)}</code>
            <code>${escapeHtml(ruler)}</code>
          </div>
        </div>
      `;
    })
    .join("");

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${escapeHtml(title)}</title>
      <style>
        :root {
          color-scheme: light dark;
        }
        body {
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;
          padding: 16px;
        }
        h1 {
          font-size: 18px;
          margin: 0 0 12px 0;
        }
        .legend {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .row {
          display: grid;
          grid-template-columns: 84px 160px 1fr;
          align-items: center;
          gap: 12px;
          padding: 8px 10px;
          border-radius: 8px;
          background: rgba(127, 127, 127, 0.08);
        }
        .swatches {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .swatch {
          width: 36px;
          height: 18px;
          border-radius: 4px;
          border: 1px solid transparent;
        }
        .ruler {
          width: 6px;
          height: 18px;
          border-radius: 3px;
        }
        .label {
          font-weight: 600;
          text-transform: none;
        }
        .meta {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          opacity: 0.8;
        }
        .meta code {
          padding: 2px 6px;
          border-radius: 6px;
          background: rgba(127, 127, 127, 0.15);
          font-size: 11px;
        }
      </style>
    </head>
    <body>
      <h1>${escapeHtml(title)}</h1>
      <div class="legend">${rows}</div>
    </body>
  </html>`;
}

function parseCheckList(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const checks: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "Enabled checks:") continue;
    if (trimmed.startsWith("clang-tidy version")) continue;
    checks.push(trimmed);
  }
  return checks;
}

function extractChecksFromConfig(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^\s*Checks:\s*(.*)$/);
    if (!match) continue;
    const rest = match[1].trim();
    if (rest && rest !== ">" && rest !== "|") {
      return rest.replace(/^['"]|['"]$/g, "");
    }
    const buffer: string[] = [];
    const baseIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
    for (let j = i + 1; j < lines.length; j += 1) {
      const nextLine = lines[j];
      if (!nextLine.trim()) continue;
      const indent = nextLine.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent <= baseIndent) break;
      buffer.push(nextLine.trim());
    }
    if (buffer.length > 0) {
      return buffer.join(" ").replace(/^['"]|['"]$/g, "");
    }
    return null;
  }
  return null;
}

function parseDisabledTokens(checks: string): string[] {
  return checks
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.startsWith("-") && t !== "-*")
    .map((t) => t.slice(1));
}

function getIndexPath(folder: vscode.WorkspaceFolder): string {
  return path.join(folder.uri.fsPath, ".vscode", "clang-tidy-index.json");
}

function getResultsDir(folder: vscode.WorkspaceFolder): string {
  return path.join(folder.uri.fsPath, ".vscode", "clang-tidy-results");
}

function getBaselinePath(folder: vscode.WorkspaceFolder): string {
  return path.join(folder.uri.fsPath, ".vscode", "clang-tidy-baseline.json");
}

function hashUri(uri: string): string {
  return crypto.createHash("sha1").update(uri).digest("hex");
}

async function gzipJson(obj: unknown): Promise<Buffer> {
  const text = JSON.stringify(obj);
  return await new Promise((resolve, reject) => {
    zlib.gzip(text, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

async function gunzipJson(buffer: Buffer): Promise<unknown> {
  const data = await new Promise<Buffer>((resolve, reject) => {
    zlib.gunzip(buffer, (err, out) => {
      if (err) reject(err);
      else resolve(out);
    });
  });
  return JSON.parse(data.toString("utf8"));
}

async function ensurePersistDirs(folder: vscode.WorkspaceFolder): Promise<void> {
  const base = path.join(folder.uri.fsPath, ".vscode");
  await fs.promises.mkdir(base, { recursive: true });
  await fs.promises.mkdir(getResultsDir(folder), { recursive: true });
}

function getBaselineForUri(uri: string): BaselineData | null {
  const folder = getWorkspaceForUri(vscode.Uri.parse(uri));
  if (!folder) return null;
  return baselineByWorkspace.get(folder.uri.fsPath) ?? null;
}

function baselineKeyForDiagnostic(d: RpcDiagnostic): string {
  return hashString(diagnosticKey(d));
}

function applyBaselineFilter(uri: string, diagnostics: RpcDiagnostic[]): RpcDiagnostic[] {
  if (!getBaselineEnabled()) return diagnostics;
  const baseline = getBaselineForUri(uri);
  if (!baseline) return diagnostics;
  const keys = baseline.files[uri];
  if (!keys || keys.length === 0) return diagnostics;
  const baselineSet = new Set(keys);
  return diagnostics.filter((d) => !baselineSet.has(baselineKeyForDiagnostic(d)));
}

async function loadBaselineForFolder(folder: vscode.WorkspaceFolder): Promise<void> {
  const baselinePath = getBaselinePath(folder);
  const raw = await fs.promises.readFile(baselinePath, "utf8").catch(() => "");
  if (!raw) {
    baselineByWorkspace.delete(folder.uri.fsPath);
    return;
  }
  let data: BaselineData | null = null;
  try {
    data = JSON.parse(raw) as BaselineData;
  } catch {
    data = null;
  }
  if (!data || data.version !== 1) {
    baselineByWorkspace.delete(folder.uri.fsPath);
    return;
  }
  const sig = await getPersistSignature(folder);
  const matches =
    data.clangTidyVersion === sig.clangTidyVersion &&
    data.compileCommandsPath === sig.compileCommandsPath &&
    data.compileCommandsMtimeMs === sig.compileCommandsMtimeMs &&
    data.clangTidyConfigPath === sig.clangTidyConfigPath &&
    data.clangTidyConfigMtimeMs === sig.clangTidyConfigMtimeMs;
  if (!matches) {
    baselineByWorkspace.delete(folder.uri.fsPath);
    output.appendLine(
      localize("msg.baselineInvalid", "Clang-Tidy: baseline invalidated (config changed).")
    );
    return;
  }
  baselineByWorkspace.set(folder.uri.fsPath, data);
}

async function loadBaselines(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    await loadBaselineForFolder(folder);
  }
}

async function saveBaselineForFolder(folder: vscode.WorkspaceFolder, data: BaselineData): Promise<void> {
  const baselinePath = getBaselinePath(folder);
  const baseDir = path.dirname(baselinePath);
  await fs.promises.mkdir(baseDir, { recursive: true });
  await fs.promises.writeFile(baselinePath, JSON.stringify(data, null, 2));
  baselineByWorkspace.set(folder.uri.fsPath, data);
}

async function clearBaselineForFolder(folder: vscode.WorkspaceFolder): Promise<void> {
  const baselinePath = getBaselinePath(folder);
  await fs.promises.rm(baselinePath, { force: true }).catch(() => undefined);
  baselineByWorkspace.delete(folder.uri.fsPath);
}

function getPersistedEntriesForFolder(folder: vscode.WorkspaceFolder): Array<{ uri: string; entry: PersistedFileEntry }> {
  const index = persistedIndices.get(folder.uri.fsPath);
  if (!index) return [];
  return Object.entries(index.files).map(([uri, entry]) => ({ uri, entry }));
}

function updateOpenFileDiagnosticsForBaseline(): void {
  for (const doc of vscode.workspace.textDocuments) {
    if (!isSupportedDocument(doc)) continue;
    if (doc.isDirty && getUseUnsavedBuffer()) continue;
    const uri = doc.uri.toString();
    const full = lastDiagnosticsStore.get(uri);
    if (!full) continue;
    const filtered = applyBaselineFilter(uri, full);
    applyDiagnosticsToOpenFile(uri, filtered);
  }
}
function recomputeTotals(): void {
  let diagnosticsTotal = 0;
  let fixesTotal = 0;
  for (const [uri, findings] of findingStore.entries()) {
    diagnosticsTotal += findings.length;
    fixesTotal += fixCountStore.get(uri) ?? 0;
  }
  totalDiagnosticsCount = diagnosticsTotal;
  totalFixesCount = fixesTotal;
}

function clearInMemoryForWorkspace(folder: vscode.WorkspaceFolder): void {
  const workspaceKey = folder.uri.fsPath;
  const urisToClear: string[] = [];
  for (const uri of findingStore.keys()) {
    const ws = getWorkspaceForUri(vscode.Uri.parse(uri));
    if (ws && ws.uri.fsPath === workspaceKey) {
      urisToClear.push(uri);
    }
  }

  for (const uri of urisToClear) {
    diagnostics.delete(vscode.Uri.parse(uri));
    categoryStore.delete(uri);
    categoryLineStore.delete(uri);
    findingStore.delete(uri);
    fixStore.delete(uri);
    fixCountStore.delete(uri);
    findingsPageState.delete(uri);
    applyCategoryDecorationsForUri(uri);
  }

  recomputeTotals();
  rebuildFindingsCache();
  findingsProvider?.refresh();
}

function resetFailSafe(): void {
  if (!failSafeActive) return;
  failSafeActive = false;
  rebuildCategoryDecorations(readCategoryStyles());
  refreshCategoryDecorations();
}

async function resetPersistedStorage(
  folder: vscode.WorkspaceFolder,
  sig: Awaited<ReturnType<typeof getPersistSignature>>,
  options: LoadPersistedIndexOptions = {}
): Promise<PersistedIndex> {
  const now = Date.now();
  const resultsDir = getResultsDir(folder);
  await fs.promises.rm(resultsDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.mkdir(resultsDir, { recursive: true });

  const index: PersistedIndex = {
    version: PERSIST_INDEX_VERSION,
    createdAt: now,
    updatedAt: now,
    clangTidyVersion: sig.clangTidyVersion,
    compileCommandsPath: sig.compileCommandsPath,
    compileCommandsMtimeMs: sig.compileCommandsMtimeMs,
    clangTidyConfigPath: sig.clangTidyConfigPath,
    clangTidyConfigMtimeMs: sig.clangTidyConfigMtimeMs,
    files: {},
  };
  await fs.promises.writeFile(getIndexPath(folder), JSON.stringify(index, null, 2));
  persistedIndices.set(folder.uri.fsPath, index);

  for (const [uri, payload] of pendingPersist.entries()) {
    if (payload.workspaceFolder.uri.fsPath !== folder.uri.fsPath) continue;
    if (options.preserveUri && options.preserveUri === uri) continue;
    pendingPersist.delete(uri);
  }

  if (!options.skipClearOpenFiles) {
    clearInMemoryForWorkspace(folder);
  }
  resetFailSafe();
  filteredIndex = null;
  updateSummaryStatusBar();
  return index;
}

async function getClangTidyVersionString(): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  const configured = cfg.get<string>("clangTidyPath", "clang-tidy").trim();
  const autoPath = await findClangTidyPath(configured);
  if (!autoPath) return "unknown";
  if (cachedClangTidyVersion && cachedClangTidyPath === autoPath) {
    return cachedClangTidyVersion;
  }
  const versionLine = await getClangTidyVersion(autoPath);
  const version = versionLine ?? "unknown";
  cachedClangTidyVersion = version;
  cachedClangTidyPath = autoPath;
  return version;
}

async function getPersistSignature(folder: vscode.WorkspaceFolder): Promise<{
  clangTidyVersion: string;
  compileCommandsPath: string;
  compileCommandsMtimeMs: number;
  clangTidyConfigPath: string | null;
  clangTidyConfigMtimeMs: number | null;
}> {
  const compilePath = (await resolvePersistedCompileCommandsPath(folder)) || "";
  const compileStat = compilePath ? await fs.promises.stat(compilePath).catch(() => null) : null;
  const configPath = await findClangTidyConfigPathNonInteractive(folder, compilePath || undefined);
  const configStat = configPath ? await fs.promises.stat(configPath).catch(() => null) : null;
  const clangTidyVersion = await getClangTidyVersionString();
  return {
    clangTidyVersion,
    compileCommandsPath: compilePath ?? "",
    compileCommandsMtimeMs: compileStat?.mtimeMs ?? 0,
    clangTidyConfigPath: configPath,
    clangTidyConfigMtimeMs: configStat?.mtimeMs ?? null,
  };
}

async function resolvePersistedCompileCommandsPath(
  folder: vscode.WorkspaceFolder
): Promise<string | null> {
  const configured = await resolveConfiguredCompileCommandsPath();
  if (configured) return configured;

  const selected = selectedCompileCommandsByWorkspace.get(getWorkspaceKey(folder));
  if (selected && (await fs.promises.stat(selected).catch(() => null))?.isFile()) {
    return selected;
  }

  const candidates = await findCompileCommandsCandidates(folder);
  if (candidates.length === 1) return candidates[0].path;

  const raw = await fs.promises.readFile(getIndexPath(folder), "utf8").catch(() => "");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistedIndex;
      const fromIndex = parsed.compileCommandsPath;
      if (fromIndex && (await fs.promises.stat(fromIndex).catch(() => null))?.isFile()) {
        return fromIndex;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function signatureMatches(index: PersistedIndex, sig: Awaited<ReturnType<typeof getPersistSignature>>): boolean {
  return (
    index.clangTidyVersion === sig.clangTidyVersion &&
    index.compileCommandsPath === sig.compileCommandsPath &&
    index.compileCommandsMtimeMs === sig.compileCommandsMtimeMs &&
    index.clangTidyConfigPath === sig.clangTidyConfigPath &&
    index.clangTidyConfigMtimeMs === sig.clangTidyConfigMtimeMs
  );
}

async function loadPersistedIndex(
  folder: vscode.WorkspaceFolder,
  options: LoadPersistedIndexOptions = {}
): Promise<PersistedIndex> {
  const key = folder.uri.fsPath;
  await ensurePersistDirs(folder);
  const indexPath = getIndexPath(folder);
  const sig = await getPersistSignature(folder);
  const existing = persistedIndices.get(key);
  if (existing && existing.version === PERSIST_INDEX_VERSION && signatureMatches(existing, sig)) {
    return existing;
  }

  let index: PersistedIndex | null = null;
  const raw = await fs.promises.readFile(indexPath, "utf8").catch(() => "");
  if (raw) {
    try {
      index = JSON.parse(raw) as PersistedIndex;
    } catch {
      index = null;
    }
  }

  if (!index || index.version !== PERSIST_INDEX_VERSION || !signatureMatches(index, sig)) {
    return await resetPersistedStorage(folder, sig, options);
  }

  persistedIndices.set(key, index);
  return index;
}

function scheduleIndexWrite(folder: vscode.WorkspaceFolder): void {
  if (persistTimer) return;
  const delay = getPersistDebounceMs();
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    for (const [uri, payload] of pendingPersist) {
      await persistFilePayload(payload);
      pendingPersist.delete(uri);
    }
  }, delay);
}

async function persistFilePayload(payload: PersistedFilePayload): Promise<void> {
  const { workspaceFolder, uri, diagnostics, fixesCount, categories, severities } = payload;
  if (!getPersistResultsEnabled()) return;
  const index = await loadPersistedIndex(workspaceFolder, { skipClearOpenFiles: true, preserveUri: uri });
  const resultsDir = getResultsDir(workspaceFolder);
  const hash = hashUri(uri);
  const resultFile = `${hash}.json.gz`;
  const fullPath = path.join(resultsDir, resultFile);
  const data = await gzipJson({ version: 1, uri, diagnostics });
  await fs.promises.writeFile(fullPath, data);

  index.files[uri] = {
    resultFile,
    diagnosticsCount: diagnostics.length,
    fixesCount,
    categories,
    severities,
    checks: payload.checks,
    updatedAt: Date.now(),
  };
  index.updatedAt = Date.now();
  await fs.promises.writeFile(getIndexPath(workspaceFolder), JSON.stringify(index, null, 2));
}

async function queuePersistResults(
  uri: string,
  diagnostics: RpcDiagnostic[],
  fixesCount: number
): Promise<void> {
  if (!getPersistResultsEnabled()) return;
  const folder = getWorkspaceForUriOrFirst(vscode.Uri.parse(uri));
  if (!folder) return;
  const { categories, severities, checks } = computeCounts(diagnostics);
  const payload: PersistedFilePayload = {
    uri,
    diagnostics,
    fixesCount,
    categories,
    severities,
    checks,
    workspaceFolder: folder,
  };
  pendingPersist.set(uri, payload);

  const index = await loadPersistedIndex(folder, { skipClearOpenFiles: true, preserveUri: uri });
  index.files[uri] = {
    resultFile: `${hashUri(uri)}.json.gz`,
    diagnosticsCount: diagnostics.length,
    fixesCount,
    categories,
    severities,
    checks,
    updatedAt: Date.now(),
  };
  index.updatedAt = Date.now();
  persistedIndices.set(folder.uri.fsPath, index);

  scheduleIndexWrite(folder);
}

async function loadPersistedDiagnostics(uri: string): Promise<RpcDiagnostic[] | null> {
  const folder = getWorkspaceForUriOrFirst(vscode.Uri.parse(uri));
  if (!folder) return null;
  const index = await loadPersistedIndex(folder);
  const entry = index.files[uri];
  if (!entry) return null;
  const fullPath = path.join(getResultsDir(folder), entry.resultFile);
  const buffer = await fs.promises.readFile(fullPath).catch(() => null);
  if (!buffer) return null;
  const parsed = (await gunzipJson(buffer)) as { diagnostics?: RpcDiagnostic[] } | null;
  return parsed?.diagnostics ?? null;
}

function isDocumentOpen(uri: string): boolean {
  return vscode.workspace.textDocuments.some((doc) => doc.uri.toString() === uri);
}

async function loadPersistedForDocument(doc: vscode.TextDocument): Promise<boolean> {
  if (!getPersistResultsEnabled()) return false;
  if (!isSupportedDocument(doc)) return false;
  const key = doc.uri.toString();
  if (findingStore.has(key)) return false;
  const diagnosticsList = await loadPersistedDiagnostics(key);
  if (!diagnosticsList) return false;
  const maxPerFile = getDiagnosticsCapPerFile();
  const trimmed =
    maxPerFile > 0 && diagnosticsList.length > maxPerFile ? diagnosticsList.slice(0, maxPerFile) : diagnosticsList;
  lastDiagnosticsStore.set(key, trimmed);
  const display = applyBaselineFilter(key, trimmed);
  applyDiagnosticsToOpenFile(key, display);
  return true;
}

async function loadPersistedForOpenDocuments(): Promise<boolean> {
  let changed = false;
  for (const doc of vscode.workspace.textDocuments) {
    if (await loadPersistedForDocument(doc)) {
      changed = true;
    }
  }
  return changed;
}

async function loadPersistedIndices(): Promise<void> {
  if (!getPersistResultsEnabled()) return;
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    await loadPersistedIndex(folder);
  }
}

async function restorePersistedResults(options?: { showInfo?: boolean }): Promise<void> {
  if (!getPersistResultsEnabled()) {
    if (options?.showInfo) {
      vscode.window.showWarningMessage(
        localize("msg.persistDisabled", "Clang-Tidy: persisted results are disabled.")
      );
    }
    return;
  }

  await loadPersistedIndices();
  await loadBaselines();
  if (findingsFilter || getBaselineEnabled()) {
    await rebuildFilteredIndexState(findingsFilter);
  } else {
    filteredIndex = null;
  }
  updateOpenFileDiagnosticsForBaseline();
  updateSummaryStatusBar();
  findingsProvider?.refresh();
  if (await loadPersistedForOpenDocuments()) {
    rebuildFindingsCache();
    findingsProvider?.refresh();
    updateSummaryStatusBar();
    refreshCategoryDecorations();
  }

  if (options?.showInfo) {
    vscode.window.showInformationMessage(
      localize("msg.persistRestored", "Clang-Tidy: restored persisted results.")
    );
  }
}

function schedulePersistRefresh(folder: vscode.WorkspaceFolder): void {
  pendingPersistWatcherFolders.add(folder.uri.fsPath);
  if (persistWatcherTimer) return;
  persistWatcherTimer = setTimeout(async () => {
    persistWatcherTimer = null;
    for (const key of pendingPersistWatcherFolders) {
      const target = (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.fsPath === key);
      if (!target) continue;
      await loadPersistedIndex(target);
    }
    pendingPersistWatcherFolders.clear();
    if (findingsFilter) {
      await rebuildFilteredIndexState(findingsFilter);
    }
    updateSummaryStatusBar();
    findingsProvider?.refresh();
  }, 300);
}

function registerPersistWatchers(context: vscode.ExtensionContext): void {
  for (const watcher of persistWatchers) {
    watcher.dispose();
  }
  persistWatchers = [];
  if (!getPersistResultsEnabled()) return;
  const patterns = ["**/.clang-tidy", "**/compile_commands.json"];
  for (const pattern of patterns) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const handler = (uri: vscode.Uri) => {
      const folder = getWorkspaceForUri(uri);
      if (!folder) return;
      schedulePersistRefresh(folder);
    };
    watcher.onDidChange(handler);
    watcher.onDidCreate(handler);
    watcher.onDidDelete(handler);
    persistWatchers.push(watcher);
    context.subscriptions.push(watcher);
  }
}

async function rebuildFilteredIndexState(filter: FindingsFilter | null): Promise<void> {
  const baselineActive = getBaselineEnabled();
  if (!filter && !baselineActive) {
    filteredIndex = null;
    return;
  }

  const baseIndex = persistedIndices.values().next().value as PersistedIndex | undefined;
  if (!baseIndex) {
    filteredIndex = null;
    return;
  }

  output.appendLine(localize("msg.filterRebuild", "Clang-Tidy: rebuilding filtered index..."));
  const now = Date.now();
  const filtered: PersistedIndex = {
    version: baseIndex.version,
    createdAt: baseIndex.createdAt,
    updatedAt: now,
    clangTidyVersion: baseIndex.clangTidyVersion,
    compileCommandsPath: baseIndex.compileCommandsPath,
    compileCommandsMtimeMs: baseIndex.compileCommandsMtimeMs,
    clangTidyConfigPath: baseIndex.clangTidyConfigPath,
    clangTidyConfigMtimeMs: baseIndex.clangTidyConfigMtimeMs,
    files: {},
  };

  for (const { uri, entry } of getAllPersistedEntries()) {
    const openFindings = findingStore.get(uri);

    if (!openFindings && filter) {
      if (filter.categories && filter.categories.size > 0) {
        let matches = false;
        for (const category of filter.categories) {
          if ((entry.categories?.[category] ?? 0) > 0) {
            matches = true;
            break;
          }
        }
        if (!matches) continue;
      }

      if (filter.severities && filter.severities.size > 0) {
        let matches = false;
        for (const sev of filter.severities) {
          const key = severityKeyFromVs(sev);
          if ((entry.severities?.[key] ?? 0) > 0) {
            matches = true;
            break;
          }
        }
        if (!matches) continue;
      }

      if (filter.checkPattern && filter.checkPattern.trim().length > 0) {
        const pattern = filter.checkPattern.trim();
        const checks = entry.checks ?? {};
        const matched = Object.keys(checks).some((check) => check.includes(pattern));
        if (!matched) continue;
      }
    }

    let diagnosticsList: RpcDiagnostic[] | null = null;
    if (openFindings) {
      diagnosticsList = openFindings.map((f) => ({
        range: {
          start: { line: f.range.start.line, character: f.range.start.character },
          end: { line: f.range.end.line, character: f.range.end.character },
        },
        severity: f.severity === vscode.DiagnosticSeverity.Error
          ? "error"
          : f.severity === vscode.DiagnosticSeverity.Warning
          ? "warning"
          : "info",
        code: f.code,
        message: f.message,
      }));
    } else {
      diagnosticsList = await loadPersistedDiagnostics(uri);
    }
    if (!diagnosticsList) continue;

    const baselineDiags = baselineActive ? applyBaselineFilter(uri, diagnosticsList) : diagnosticsList;
    const filteredDiags = baselineDiags.filter((d) => {
      const finding: Finding = {
        uri: vscode.Uri.parse(uri),
        range: rpcRangeToVs(d.range),
        message: d.message,
        code: d.code,
        severity: severityToVs(d.severity),
        category: resolveCategory(d.code),
      };
      return filter ? matchesFilter(finding, filter) : true;
    });

    if (filteredDiags.length === 0) continue;

    const counts = computeCounts(filteredDiags);
    filtered.files[uri] = {
      resultFile: `${hashUri(uri)}.json.gz`,
      diagnosticsCount: filteredDiags.length,
      fixesCount: countFixesWithCap(filteredDiags),
      categories: counts.categories,
      severities: counts.severities,
      checks: counts.checks,
      updatedAt: now,
    };
  }

  filteredIndex = filtered;
  output.appendLine(localize("msg.filterRebuildDone", "Clang-Tidy: filtered index ready."));
}

function computeCounts(diagnostics: RpcDiagnostic[]): {
  categories: Record<string, number>;
  severities: Record<string, number>;
  checks: Record<string, number>;
} {
  const categories: Record<string, number> = {};
  const severities: Record<string, number> = {};
  const checks: Record<string, number> = {};
  for (const d of diagnostics) {
    const category = resolveCategory(d.code);
    categories[category] = (categories[category] ?? 0) + 1;
    severities[d.severity] = (severities[d.severity] ?? 0) + 1;
    if (d.code) {
      checks[d.code] = (checks[d.code] ?? 0) + 1;
    }
  }
  return { categories, severities, checks };
}

function countFixesWithCap(diagnostics: RpcDiagnostic[]): number {
  const maxFixes = getFixesCapPerFile();
  let fixesCount = 0;
  for (const d of diagnostics) {
    if (!d.fixes || d.fixes.length === 0) continue;
    if (maxFixes > 0 && fixesCount >= maxFixes) break;
    const remaining = maxFixes > 0 ? Math.max(0, maxFixes - fixesCount) : d.fixes.length;
    fixesCount += maxFixes > 0 ? Math.min(d.fixes.length, remaining) : d.fixes.length;
  }
  return fixesCount;
}

function collectFixEditsFromDiagnostics(
  diagnosticsList: RpcDiagnostic[]
): Array<{ range: vscode.Range; newText: string; title: string }> {
  const edits: Array<{ range: vscode.Range; newText: string; title: string }> = [];
  for (const d of diagnosticsList) {
    if (!d.fixes) continue;
    for (const fix of d.fixes) {
      for (const e of fix.edits) {
        edits.push({ range: rpcRangeToVs(e.range), newText: e.newText, title: fix.title });
      }
    }
  }
  return edits;
}

function selectNonOverlappingEdits(
  edits: Array<{ range: vscode.Range; newText: string; title: string }>
): { applied: Array<{ range: vscode.Range; newText: string; title: string }>; conflicts: number } {
  const sorted = edits.slice().sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
    return a.range.start.character - b.range.start.character;
  });
  const applied: Array<{ range: vscode.Range; newText: string; title: string }> = [];
  let conflicts = 0;
  let prevEnd: vscode.Position | null = null;
  for (const e of sorted) {
    if (prevEnd && (e.range.start.isBefore(prevEnd) || e.range.start.isEqual(prevEnd))) {
      conflicts += 1;
      continue;
    }
    applied.push(e);
    prevEnd = e.range.end;
  }
  return { applied, conflicts };
}

function parseClangTidyDiagnostics(
  outputText: string,
  targetFile: string,
  baseDir: string
): RpcDiagnostic[] {
  const diagnostics: RpcDiagnostic[] = [];
  if (!outputText) return diagnostics;
  const target = path.normalize(targetFile);
  const lines = outputText.split(/\r?\n/);
  const regex = /^(.*?):(\d+):(\d+):\s+(warning|error|note|remark|fatal error):\s+(.*?)(?:\s+\[(.+?)\])?$/;
  for (const line of lines) {
    const match = line.match(regex);
    if (!match) continue;
    let filePath = match[1];
    const lineNum = parseInt(match[2], 10) - 1;
    const colNum = parseInt(match[3], 10) - 1;
    const sevRaw = match[4];
    const message = match[5].trim();
    const code = match[6]?.trim();

    if (!path.isAbsolute(filePath)) {
      filePath = path.resolve(baseDir, filePath);
    }
    const normalized = path.normalize(filePath);
    if (normalized !== target) continue;

    const severity: RpcDiagnostic["severity"] =
      sevRaw === "error" || sevRaw === "fatal error" ? "error" : sevRaw === "warning" ? "warning" : "info";

    diagnostics.push({
      range: {
        start: { line: lineNum, character: colNum },
        end: { line: lineNum, character: Math.max(colNum + 1, colNum) },
      },
      severity,
      code,
      message,
    });
  }
  return diagnostics;
}

async function runClangTidyCli(
  filePath: string,
  compilePath: string,
  mode: "quick" | "full"
): Promise<RpcDiagnostic[]> {
  const cfg = vscode.workspace.getConfiguration("clangTidy");
  const configured = cfg.get<string>("clangTidyPath", "clang-tidy").trim();
  const clangPath = await findClangTidyPath(configured);
  if (!clangPath) {
    output.appendLine(localize("msg.cliClangTidyMissing", "clang-tidy not found for CLI fallback."));
    return [];
  }

  const compileDir = path.dirname(compilePath);
  const settings = getSettings();
  const args = [filePath, "-p", compileDir];
  if (mode === "quick" && settings.quickChecks) {
    args.push(`-checks=${settings.quickChecks}`);
  }
  if (settings.extraArgs.length > 0) {
    args.push(...settings.extraArgs);
  }
  args.push("-quiet");

  const timeout = settings.perFileTimeoutMs > 0 ? settings.perFileTimeoutMs : 0;
  const result = await execFileAsyncWithCwd(clangPath, args, compileDir, timeout);
  if (!result) return [];

  const outputText = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const realTarget = await realpathSafe(filePath);
  return parseClangTidyDiagnostics(outputText, realTarget, compileDir);
}

function clearOpenFileDiagnostics(fileUri: string): void {
  applyDiagnosticsToOpenFile(fileUri, []);
  dirtySuppressedFiles.add(fileUri);
}

function shouldApplyDiagnosticsToOpenDoc(
  doc: vscode.TextDocument,
  runId: string | number
): boolean {
  if (!doc.isDirty) return true;
  const expected = runIdToDocVersion.get(String(runId));
  if (!expected || expected.uri !== doc.uri.toString()) {
    return false;
  }
  return doc.version === expected.version;
}

function applyDiagnosticsToOpenFile(fileUri: string, diagnosticsList: RpcDiagnostic[]): number {
  const uri = vscode.Uri.parse(fileUri);
  const vsDiags = diagnosticsList.map((d) => toVsDiagnostic(fileUri, d));
  diagnostics.set(uri, vsDiags);

  let perFile = fixStore.get(fileUri);
  if (!perFile) {
    perFile = new Map();
    fixStore.set(fileUri, perFile);
  }
  perFile.clear();

  const maxFixes = getFixesCapPerFile();
  let fixesCount = 0;
  for (const d of diagnosticsList) {
    if (d.fixes && d.fixes.length > 0) {
      if (maxFixes > 0 && fixesCount >= maxFixes) {
        continue;
      }
      const remaining = maxFixes > 0 ? Math.max(0, maxFixes - fixesCount) : d.fixes.length;
      const slice = maxFixes > 0 ? d.fixes.slice(0, remaining) : d.fixes;
      fixesCount += slice.length;
      perFile.set(diagnosticKey(d), slice);
    }
  }

  const perCategory = new Map<Category, vscode.Range[]>();
  const perCategoryLine = new Map<Category, Map<number, vscode.Range>>();
  const perFileFindings: Finding[] = [];
  for (const d of diagnosticsList) {
    const category = resolveCategory(d.code);
    const ranges = perCategory.get(category) ?? [];
    const range = rpcRangeToVs(d.range);
    ranges.push(range);
    perCategory.set(category, ranges);
    const lineMap = perCategoryLine.get(category) ?? new Map<number, vscode.Range>();
    if (!lineMap.has(range.start.line)) {
      lineMap.set(
        range.start.line,
        new vscode.Range(new vscode.Position(range.start.line, 0), new vscode.Position(range.start.line, 0))
      );
    }
    perCategoryLine.set(category, lineMap);
    perFileFindings.push({
      uri,
      range,
      message: d.message,
      code: d.code,
      severity: severityToVs(d.severity),
      category,
    });
  }

  categoryStore.set(fileUri, perCategory);
  const perCategoryLinesFlat = new Map<Category, vscode.Range[]>();
  for (const [category, lineMap] of perCategoryLine) {
    perCategoryLinesFlat.set(category, Array.from(lineMap.values()));
  }
  categoryLineStore.set(fileUri, perCategoryLinesFlat);

  const prevFindings = findingStore.get(fileUri) ?? [];
  const prevFixCount = fixCountStore.get(fileUri) ?? 0;
  totalDiagnosticsCount -= prevFindings.length;
  totalFixesCount -= prevFixCount;
  findingStore.set(fileUri, perFileFindings);
  fixCountStore.set(fileUri, fixesCount);
  totalDiagnosticsCount += perFileFindings.length;
  totalFixesCount += fixesCount;

  findingsPageState.set(fileUri, 1);

  if (totalDiagnosticsCount > getFailSafeThreshold()) {
    enterFailSafe(`diagnostics>${getFailSafeThreshold()}`);
  } else if (totalDiagnosticsCount > getMaxTotalDiagnostics()) {
    output.appendLine(
      localize(
        "msg.totalDiagnosticsCap",
        "Clang-Tidy: total diagnostics cap exceeded ({0}). Consider narrowing checks.",
        String(totalDiagnosticsCount)
      )
    );
  }

  scheduleUiRefresh(fileUri);
  return fixesCount;
}

async function findClangTidyConfigPath(): Promise<string | null> {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const workspaceFolder = getWorkspaceForUri(activeUri);
  const stopDir = workspaceFolder?.uri.fsPath;
  const startDir = activeUri ? path.dirname(activeUri.fsPath) : stopDir;
  const candidates: string[] = [];

  if (startDir) {
    let current = startDir;
    while (true) {
      const candidate = path.join(current, ".clang-tidy");
      candidates.push(candidate);
      if (stopDir && current === stopDir) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  const compilePath = await resolveCompileCommandsPathForUri(activeUri);
  if (compilePath) {
    candidates.push(path.join(path.dirname(compilePath), ".clang-tidy"));
  }

  for (const candidate of candidates) {
    const stat = await fs.promises.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }

  return null;
}

async function findClangTidyConfigPathNonInteractive(
  folder: vscode.WorkspaceFolder,
  compileCommandsPath?: string
): Promise<string | null> {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const stopDir = folder.uri.fsPath;
  const startDir = activeUri ? path.dirname(activeUri.fsPath) : stopDir;
  const candidates: string[] = [];

  if (startDir) {
    let current = startDir;
    while (true) {
      const candidate = path.join(current, ".clang-tidy");
      candidates.push(candidate);
      if (current === stopDir) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  if (compileCommandsPath) {
    candidates.push(path.join(path.dirname(compileCommandsPath), ".clang-tidy"));
  }

  candidates.push(path.join(stopDir, ".clang-tidy"));

  for (const candidate of candidates) {
    const stat = await fs.promises.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }

  return null;
}

function renderChecksHtml(
  title: string,
  configPath: string,
  checks: string,
  active: string[],
  disabled: string[]
): string {
  const activeItems = active.map((c) => `<li><code>${escapeHtml(c)}</code></li>`).join("");
  const disabledItems = disabled.length
    ? disabled.map((c) => `<li><code>${escapeHtml(c)}</code></li>`).join("")
    : `<li>${escapeHtml(localize("msg.noDisabledChecks", "No explicit disabled checks"))}</li>`;

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${escapeHtml(title)}</title>
      <style>
        :root { color-scheme: light dark; }
        body { margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        h1 { font-size: 18px; margin: 0 0 12px 0; }
        .meta { margin-bottom: 16px; font-size: 12px; opacity: 0.8; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        ul { margin: 8px 0 0 0; padding-left: 18px; }
        code { background: rgba(127,127,127,0.15); padding: 2px 6px; border-radius: 6px; }
      </style>
    </head>
    <body>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta"><div>${escapeHtml(configPath)}</div><div><code>${escapeHtml(checks)}</code></div></div>
      <div class="grid">
        <div>
          <strong>${escapeHtml(localize("msg.activeChecks", "Active checks"))}</strong>
          <ul>${activeItems}</ul>
        </div>
        <div>
          <strong>${escapeHtml(localize("msg.disabledChecks", "Disabled by config"))}</strong>
          <ul>${disabledItems}</ul>
        </div>
      </div>
    </body>
  </html>`;
}

function handlePublishDiagnostics(params: PublishDiagnosticsParams) {
  const maxPerFile = getDiagnosticsCapPerFile();
  const trimmedDiagnostics =
    maxPerFile > 0 && params.diagnostics.length > maxPerFile
      ? params.diagnostics.slice(0, maxPerFile)
      : params.diagnostics;

  if (trimmedDiagnostics.length !== params.diagnostics.length) {
    output.appendLine(
      localize(
        "msg.diagnosticsTrimmed",
        "Clang-Tidy: trimmed diagnostics for {0} ({1} -> {2})",
        params.fileUri,
        String(params.diagnostics.length),
        String(trimmedDiagnostics.length)
      )
    );
  }

  const open = isDocumentOpen(params.fileUri);
  let canApply = true;
  let doc: vscode.TextDocument | undefined;
  if (open) {
    doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === params.fileUri);
    if (doc && !shouldApplyDiagnosticsToOpenDoc(doc, params.runId)) {
      canApply = false;
    }
  } else {
    runIdToDocVersion.delete(String(params.runId));
  }
  lastDiagnosticsStore.set(params.fileUri, trimmedDiagnostics);

  let fixesCount = 0;
  const maxFixes = getFixesCapPerFile();
  const displayDiagnostics = applyBaselineFilter(params.fileUri, trimmedDiagnostics);
  const runEntry = runIdToDocVersion.get(String(params.runId));
  const usesUnsaved = runEntry?.usesUnsaved ?? false;
  if (open && doc && !canApply) {
    if (!dirtySuppressedFiles.has(params.fileUri)) {
      clearOpenFileDiagnostics(params.fileUri);
    }
    runIdToDocVersion.delete(String(params.runId));
    fixesCount = countFixesWithCap(trimmedDiagnostics);
  } else if (open && doc) {
    if (doc.isDirty) {
      dirtySuppressedFiles.delete(params.fileUri);
    }
    runIdToDocVersion.delete(String(params.runId));
    fixesCount = applyDiagnosticsToOpenFile(params.fileUri, displayDiagnostics);
  } else {
    fixesCount = countFixesWithCap(trimmedDiagnostics);
  }
  if (maxFixes > 0 && fixesCount >= maxFixes) {
    output.appendLine(
      localize(
        "msg.fixesTrimmed",
        "Clang-Tidy: trimmed fixes for {0} (max {1})",
        params.fileUri,
        String(maxFixes)
      )
    );
  }

  if (!usesUnsaved) {
    void queuePersistResults(params.fileUri, trimmedDiagnostics, fixesCount);
  }
  if (!open || (doc && !canApply)) {
    findingsProvider?.refresh();
    updateSummaryStatusBar();
  }
  if (!canApply && doc && doc.isDirty) {
    return;
  }
  if (usesUnsaved) {
    return;
  }
  if (filteredIndex) {
    const counts = computeCounts(displayDiagnostics);
    if (displayDiagnostics.length === 0) {
      delete filteredIndex.files[params.fileUri];
    } else {
      filteredIndex.files[params.fileUri] = {
        resultFile: `${hashUri(params.fileUri)}.json.gz`,
        diagnosticsCount: displayDiagnostics.length,
        fixesCount: countFixesWithCap(displayDiagnostics),
        categories: counts.categories,
        severities: counts.severities,
        checks: counts.checks,
        updatedAt: Date.now(),
      };
    }
    filteredIndex.updatedAt = Date.now();
    findingsProvider?.refresh();
    updateSummaryStatusBar();
  } else if (findingsFilter || getBaselineEnabled()) {
    void rebuildFilteredIndexState(findingsFilter).then(() => {
      findingsProvider?.refresh();
      updateSummaryStatusBar();
    });
  }
}

async function runAnalyzeFile(uri: vscode.Uri) {
  await runAnalyzeFileWithMode(uri, getModes().manual);
}

async function runAnalyzeFileWithMode(uri: vscode.Uri, mode: "quick" | "full") {
  if (!connection) {
    if (!getFallbackToCli()) return;
    await runAnalyzeFileWithCli(uri, mode);
    return;
  }
  const allowed = await ensureFileInCompilation(uri);
  if (!allowed) return;
  const runId = `run-${Date.now()}-${runCounter++}`;
  setRunActive(runId);
  try {
    let fileContent: string | undefined;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) {
      runIdToDocVersion.set(runId, { uri: uri.toString(), version: doc.version, usesUnsaved: false });
    }
    if (doc && doc.isDirty && getUseUnsavedBuffer()) {
      const text = doc.getText();
      const maxBytes = getUnsavedBufferMaxBytes();
      if (maxBytes <= 0 || Buffer.byteLength(text, "utf8") <= maxBytes) {
        fileContent = text;
        const entry = runIdToDocVersion.get(runId);
        if (entry) entry.usesUnsaved = true;
      } else {
        output.appendLine(
          localize(
            "msg.unsavedTooLarge",
            "Clang-Tidy: unsaved buffer too large for {0} (>{1} bytes).",
            uri.fsPath,
            String(maxBytes)
          )
        );
      }
    }

    const result = (await connection.sendRequest("analyzeFile", {
      runId,
      fileUri: uri.toString(),
      mode,
      fileContent,
    })) as AnalyzeFileResult;
    handlePublishDiagnostics({ runId, fileUri: result.fileUri, diagnostics: result.diagnostics });
  } finally {
    setRunInactive(runId);
  }
}

async function runAnalyzeFileWithCli(uri: vscode.Uri, mode: "quick" | "full") {
  const compilePath = await resolveCompileCommandsPathForUri(uri);
  if (!compilePath) {
    output.appendLine(
      localize(
        "msg.cliCompileMissing",
        "Clang-Tidy CLI fallback requires compile_commands.json."
      )
    );
    return;
  }

  const runId = `run-${Date.now()}-${runCounter++}`;
  setRunActive(runId);
  try {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc && doc.isDirty && getUseUnsavedBuffer()) {
      output.appendLine(
        localize(
          "msg.cliUnsavedSkipped",
          "Clang-Tidy CLI fallback uses saved files only. Save to refresh diagnostics."
        )
      );
    }
    const realPath = await realpathSafe(uri.fsPath);
    const diagnosticsList = await runClangTidyCli(realPath, compilePath, mode);
    handlePublishDiagnostics({ runId, fileUri: uri.toString(), diagnostics: diagnosticsList });
  } finally {
    setRunInactive(runId);
  }
}

function shouldReduceProjectBatching(): boolean {
  if (failSafeActive) return true;
  const maxTotal = getMaxTotalDiagnostics();
  if (maxTotal > 0 && totalDiagnosticsCount >= maxTotal) return true;
  const failSafe = getFailSafeThreshold();
  if (failSafe > 0 && totalDiagnosticsCount >= Math.floor(failSafe * 0.8)) return true;
  return false;
}

function createProjectRunState(
  folder: vscode.WorkspaceFolder,
  mode: "quick" | "full",
  incremental: boolean,
  batchSize: number
): ProjectRunState {
  const adaptiveEnabled = getProjectAdaptiveBatching() && batchSize > 0;
  return {
    workspaceKey: getWorkspaceKey(folder),
    workspaceFolder: folder,
    groups: [],
    activeRunId: null,
    totalFiles: 0,
    doneFiles: 0,
    batchSize: batchSize > 0 ? batchSize : Number.MAX_SAFE_INTEGER,
    adaptive: adaptiveEnabled,
    adaptiveMinBatch: getProjectAdaptiveMinBatchSize(),
    adaptiveBackoff: getProjectAdaptiveBackoffFactor(),
    mode,
    incremental,
  };
}

function cancelLowPriorityProjectRuns(workspaceKey: string): void {
  for (const [runId, batch] of projectRunById.entries()) {
    if (batch.workspaceKey !== workspaceKey) continue;
    if (batch.priority <= 0) continue;
    connection?.sendRequest("cancel", { runId }).catch(() => undefined);
    projectRunById.delete(runId);
    const state = projectRuns.get(workspaceKey);
    if (state && state.activeRunId === runId) {
      state.activeRunId = null;
      projectActiveWorkspaceKey = null;
    }
    setRunInactive(runId);
  }
}

function buildProjectGroups(
  ordered: { priority: number; files: string[] }[]
): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  for (const entry of ordered) {
    if (entry.files.length === 0) continue;
    groups.push({ priority: entry.priority, files: entry.files, cursor: 0 });
  }
  return groups;
}

async function buildProjectPlan(
  folder: vscode.WorkspaceFolder,
  activeUri: vscode.Uri | undefined,
  diffOnlyOverride?: boolean
): Promise<{ groups: ProjectGroup[]; total: number } | null> {
  const index = await getCompileCommandsIndexForFolder(folder);
  if (!index) return null;

  const diffOnly = diffOnlyOverride ?? getProjectDiffOnly();
  const includeUntracked = getProjectDiffIncludeUntracked();

  let eligibleFiles = index.filesList.slice();
  if (diffOnly) {
    const diff = await getGitChangedFiles(folder, includeUntracked);
    if (!diff) {
      output.appendLine(
        localize(
          "msg.gitDiffUnavailable",
          "Clang-Tidy: git diff-only mode unavailable (not a git repo or git not found). Falling back to full project."
        )
      );
    } else {
      eligibleFiles = eligibleFiles.filter((f) => diff.has(f));
      if (eligibleFiles.length === 0) {
        output.appendLine(
          localize(
            "msg.gitDiffEmpty",
            "Clang-Tidy: no changed files to analyze (diff-only)."
          )
        );
        return null;
      }
    }
  }

  const eligibleSet = new Set(eligibleFiles);
  const prioritizeActive = getProjectPrioritizeActive();
  const prioritizeOpen = getProjectPrioritizeOpen();
  const prioritized: string[] = [];
  const seen = new Set<string>();

  if (prioritizeActive && activeUri && getWorkspaceForUri(activeUri)?.uri.fsPath === folder.uri.fsPath) {
    const activePath = await realpathSafe(activeUri.fsPath);
    if (eligibleSet.has(activePath) && index.files.has(activePath)) {
      prioritized.push(activePath);
      seen.add(activePath);
    }
  }

  const openFiles: string[] = [];
  if (prioritizeOpen) {
    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document;
      if (!isSupportedDocument(doc)) continue;
      const docFolder = getWorkspaceForUri(doc.uri);
      if (!docFolder || docFolder.uri.fsPath !== folder.uri.fsPath) continue;
      const filePath = await realpathSafe(doc.uri.fsPath);
      if (!seen.has(filePath) && eligibleSet.has(filePath) && index.files.has(filePath)) {
        openFiles.push(filePath);
        seen.add(filePath);
      }
    }
  }

  const remaining: string[] = [];
  for (const filePath of eligibleFiles) {
    if (!seen.has(filePath)) remaining.push(filePath);
  }

  const groups = buildProjectGroups([
    { priority: 0, files: prioritized },
    { priority: 1, files: openFiles },
    { priority: 2, files: remaining },
  ]);

  const totalFiles = groups.reduce((sum, g) => sum + g.files.length, 0);
  if (totalFiles === 0) {
    output.appendLine(
      localize("msg.projectNoFiles", "Clang-Tidy: no eligible files to analyze in project.")
    );
    return null;
  }

  return { groups, total: totalFiles };
}

function getNextProjectBatch(state: ProjectRunState): ProjectBatch | null {
  if (state.groups.length === 0) return null;
  if (state.adaptive && shouldReduceProjectBatching()) {
    const nextSize = Math.max(
      state.adaptiveMinBatch,
      Math.floor(state.batchSize * state.adaptiveBackoff)
    );
    if (nextSize < state.batchSize) {
      state.batchSize = nextSize;
      output.appendLine(
        localize(
          "msg.projectAdaptiveBatch",
          "Clang-Tidy: adaptive batching reduced to {0} files per batch.",
          String(state.batchSize)
        )
      );
    }
  }

  const group = state.groups.find((g) => g.cursor < g.files.length);
  if (!group) return null;
  const remaining = group.files.length - group.cursor;
  const size = Math.min(state.batchSize, remaining);
  const slice = group.files.slice(group.cursor, group.cursor + size);
  group.cursor += slice.length;

  const runId = `project-${Date.now()}-${runCounter++}`;
  return {
    runId,
    workspaceKey: state.workspaceKey,
    workspaceFolder: state.workspaceFolder,
    mode: state.mode,
    files: slice,
    total: slice.length,
    done: 0,
    priority: group.priority,
    incremental: state.incremental,
    batchSize: size,
  };
}

async function startNextProjectBatchIfIdle(): Promise<void> {
  if (!connection) return;
  if (projectActiveWorkspaceKey) return;
  const states = Array.from(projectRuns.values());
  for (const state of states) {
    const hasRemaining = state.groups.some((g) => g.cursor < g.files.length);
    if (!hasRemaining && !state.activeRunId) {
      projectRuns.delete(state.workspaceKey);
    }
  }
  const activeStates = Array.from(projectRuns.values());
  if (activeStates.length === 0) return;

  const alreadyActive = activeStates.find((s) => s.activeRunId);
  if (alreadyActive) {
    projectActiveWorkspaceKey = alreadyActive.workspaceKey;
    return;
  }

  const nextState = activeStates.find((s) => s.groups.some((g) => g.cursor < g.files.length));
  if (!nextState) return;

  const batch = getNextProjectBatch(nextState);
  if (!batch) return;

  const compilePath = await resolveCompileCommandsPathForFolder(nextState.workspaceFolder);
  if (!compilePath) {
    output.appendLine(
      localize(
        "msg.compileCommandsMissingProject",
        "Clang-Tidy: compile_commands.json not found. Project analysis cannot run."
      )
    );
    return;
  }

  nextState.activeRunId = batch.runId;
  projectRunById.set(batch.runId, batch);
  projectActiveWorkspaceKey = nextState.workspaceKey;
  batch.startedAt = Date.now();

  await connection.sendRequest("analyzeProject", {
    runId: batch.runId,
    mode: batch.mode,
    incremental: batch.incremental,
    batchSize: batch.batchSize,
    files: batch.files.map((p) => vscode.Uri.file(p).toString()),
  });
}

async function enqueueProjectRunForFolder(
  folder: vscode.WorkspaceFolder,
  mode: "quick" | "full",
  activeUri: vscode.Uri | undefined,
  diffOnlyOverride?: boolean
): Promise<void> {
  if (!connection) return;
  const ok = await ensureCompileCommandsAvailableForFolder(folder);
  if (!ok) return;
  const plan = await buildProjectPlan(folder, activeUri, diffOnlyOverride);
  if (!plan || plan.total === 0) return;

  const incremental = getProjectIncremental();
  const batchSize = getProjectBatchSize();

  cancelLowPriorityProjectRuns(getWorkspaceKey(folder));
  const state = createProjectRunState(folder, mode, incremental, batchSize);
  state.groups = plan.groups;
  state.totalFiles = plan.total;
  projectRuns.set(state.workspaceKey, state);
}

async function runAnalyzeProject() {
  if (!connection) return;
  const runId = `run-${Date.now()}-${runCounter++}`;
  const { manual } = getModes();
  await runAnalyzeProjectWithMode(manual, runId);
}

async function runAnalyzeProjectWithMode(
  mode: "quick" | "full",
  runId?: string,
  options: { diffOnly?: boolean } = {}
) {
  if (!connection) {
    if (!getFallbackToCli()) return;
    await runAnalyzeProjectWithCli(mode, options.diffOnly);
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri ? getWorkspaceForUri(activeUri) : undefined;
  const orderedFolders = activeFolder
    ? [activeFolder, ...folders.filter((f) => f.uri.fsPath !== activeFolder.uri.fsPath)]
    : folders;

  for (const folder of orderedFolders) {
    await enqueueProjectRunForFolder(folder, mode, activeUri, options.diffOnly);
  }

  await startNextProjectBatchIfIdle();
}

async function runAnalyzeProjectWithCli(mode: "quick" | "full", diffOnlyOverride?: boolean) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  let totalFiles = 0;
  const plans: Array<{
    folder: vscode.WorkspaceFolder;
    compilePath: string;
    groups: ProjectGroup[];
  }> = [];

  for (const folder of folders) {
    const ok = await ensureCompileCommandsAvailableForFolder(folder);
    if (!ok) continue;
    const compilePath = await resolveCompileCommandsPathForFolder(folder);
    if (!compilePath) continue;
    const plan = await buildProjectPlan(folder, activeUri, diffOnlyOverride);
    if (!plan || plan.total === 0) continue;
    totalFiles += plan.total;
    plans.push({ folder, compilePath, groups: plan.groups });
  }

  if (totalFiles === 0) return;
  const runId = `run-${Date.now()}-${runCounter++}`;
  setRunActive(runId);

  let done = 0;
  for (const plan of plans) {
    for (const group of plan.groups) {
      for (const file of group.files) {
        const diagnosticsList = await runClangTidyCli(file, plan.compilePath, mode);
        handlePublishDiagnostics({
          runId,
          fileUri: vscode.Uri.file(file).toString(),
          diagnostics: diagnosticsList,
        });
        done += 1;
        const percent = Math.floor((done / totalFiles) * 100);
        updateStatusBar(`Analyzed ${done}/${totalFiles} files (CLI)`, percent);
      }
    }
  }

  setRunInactive(runId);
}

async function stopAnalysis() {
  if (!connection) return;
  await connection.sendRequest("cancel", { runId: "*" });
  projectRuns.clear();
  projectRunById.clear();
  projectActiveWorkspaceKey = null;
}

class FixCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const uri = document.uri.toString();
    const perFile = fixStore.get(uri);
    if (!perFile) return [];

    const actions: vscode.CodeAction[] = [];
    for (const diag of context.diagnostics) {
      if (diag.source !== "clang-tidy") continue;
      const key = `${diag.range.start.line}:${diag.range.start.character}-${diag.range.end.line}:${diag.range.end.character}|${diag.code ?? ""}|${diag.message}`;
      const fixes = perFile.get(key);
      if (!fixes) continue;

      for (const fix of fixes) {
        const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diag];
        const edit = new vscode.WorkspaceEdit();
        for (const e of fix.edits) {
          edit.replace(document.uri, rpcRangeToVs(e.range), e.newText);
        }
        action.edit = edit;
        actions.push(action);
      }
    }

    const fixAllKind = vscode.CodeActionKind.SourceFixAll.append("clangTidy");
    const wantsFixAll =
      !context.only ||
      context.only.contains(vscode.CodeActionKind.Source) ||
      context.only.contains(vscode.CodeActionKind.SourceFixAll) ||
      context.only.contains(fixAllKind);

    if (wantsFixAll) {
      const allEdits = collectAllFixEdits(document, perFile);
      if (allEdits.length > 0) {
        const fixAll = new vscode.CodeAction("Clang-Tidy: Apply all fixes (file)", fixAllKind);
        const edit = new vscode.WorkspaceEdit();
        for (const e of allEdits) {
          edit.replace(document.uri, e.range, e.newText);
        }
        fixAll.edit = edit;
        actions.push(fixAll);
      }
    }

    for (const diag of context.diagnostics) {
      if (diag.source !== "clang-tidy") continue;
      const code = diagnosticCodeToString(diag.code);
      const checkSuffix = code ? `(${code})` : "";
      const line = document.lineAt(diag.range.start.line);
      if (!line.text.includes("NOLINT")) {
        const noLint = new vscode.CodeAction("Clang-Tidy: Suppress with NOLINT", vscode.CodeActionKind.QuickFix);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, line.range.end, ` // NOLINT${checkSuffix}`);
        noLint.edit = edit;
        noLint.diagnostics = [diag];
        actions.push(noLint);
      }

      if (diag.range.start.line > 0) {
        const prevLine = document.lineAt(diag.range.start.line - 1);
        if (!prevLine.text.includes("NOLINTNEXTLINE")) {
          const indent = line.text.match(/^\\s*/)?.[0] ?? "";
          const noLintNext = new vscode.CodeAction(
            "Clang-Tidy: Suppress with NOLINTNEXTLINE",
            vscode.CodeActionKind.QuickFix
          );
          const edit = new vscode.WorkspaceEdit();
          edit.insert(
            document.uri,
            line.range.start,
            `${indent}// NOLINTNEXTLINE${checkSuffix}\\n`
          );
          noLintNext.edit = edit;
          noLintNext.diagnostics = [diag];
          actions.push(noLintNext);
        }
      }
    }
    return actions;
  }
}

class CategoryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly category: Category,
    public readonly count: number
  ) {
    super(`${category} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
  }
}

class FileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly count: number
  ) {
    const label = `${path.basename(uri.fsPath)} (${count})`;
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = vscode.workspace.asRelativePath(uri, false);
    this.resourceUri = uri;
    this.contextValue = "clangTidyFile";
  }
}

class FindingTreeItem extends vscode.TreeItem {
  constructor(public readonly finding: Finding) {
    const code = finding.code ? `${finding.code}: ` : "";
    const message = `${code}${finding.message}`;
    super(message, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: "clangTidy.openFinding",
      title: "Open Finding",
      arguments: [finding],
    };
    this.description = `${finding.uri.fsPath}:${finding.range.start.line + 1}`;
    this.contextValue = "clangTidyFinding";
  }
}

class MoreFindingsTreeItem extends vscode.TreeItem {
  constructor(public readonly uri: vscode.Uri, public readonly remaining: number) {
    super(`Show more findings (${remaining})`, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: "clangTidy.showMoreFindings",
      title: "Show More Findings",
      arguments: [uri],
    };
    this.contextValue = "clangTidyMoreFindings";
  }
}

type FindingsNode = CategoryTreeItem | FileTreeItem | FindingTreeItem | MoreFindingsTreeItem;

class FindingsProvider implements vscode.TreeDataProvider<FindingsNode> {
  private readonly emitter = new vscode.EventEmitter<FindingsNode | null | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh() {
    this.emitter.fire();
  }

  getTreeItem(element: FindingsNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FindingsNode): Promise<FindingsNode[]> {
    if (!element) {
      const nodes: FindingsNode[] = [];
      for (const category of categoryOrder) {
        const count = this.countByCategory(category);
        if (count > 0) nodes.push(new CategoryTreeItem(category, count));
      }
      return nodes;
    }

    if (element instanceof CategoryTreeItem) {
      const byFile = this.groupByFile(element.category);
      return Array.from(byFile.entries()).map(([uri, count]) => new FileTreeItem(uri, count));
    }

    if (element instanceof FileTreeItem) {
      const items = await this.getFindingsForFile(element.uri);
      const pageSize = getFindingsPageSize();
      const page = findingsPageState.get(element.uri.toString()) ?? 1;
      const limit = pageSize > 0 ? pageSize * page : items.length;
      const pageItems = items.slice(0, limit);
      const nodes: FindingsNode[] = pageItems.map((finding) => new FindingTreeItem(finding));
      if (pageSize > 0 && items.length > limit) {
        nodes.push(new MoreFindingsTreeItem(element.uri, items.length - limit));
      }
      return nodes;
    }

    return [];
  }

  private countByCategory(category: Category): number {
    let count = 0;
    for (const { entry } of getIndexEntries()) {
      count += entry.categories?.[category] ?? 0;
    }
    return count;
  }

  private groupByFile(category: Category): Map<vscode.Uri, number> {
    const map = new Map<vscode.Uri, number>();
    for (const { uri, entry } of getIndexEntries()) {
      const count = entry.categories?.[category] ?? 0;
      if (count <= 0) continue;
      map.set(vscode.Uri.parse(uri), count);
    }
    return map;
  }

  private async getFindingsForFile(uri: vscode.Uri): Promise<Finding[]> {
    const key = uri.toString();
    const openFindings = findingStore.get(key);
    let findings: Finding[];
    if (openFindings) {
      findings = openFindings;
    } else {
      const diagnostics = await loadPersistedDiagnostics(key);
      if (!diagnostics) return [];
      findings = diagnostics.map((d) => ({
        uri,
        range: rpcRangeToVs(d.range),
        message: d.message,
        code: d.code,
        severity: severityToVs(d.severity),
        category: resolveCategory(d.code),
      }));
    }

    const filtered = findingsFilter ? findings.filter((f) => matchesFilter(f, findingsFilter!)) : findings;
    return filtered.slice().sort((a, b) => {
      if (a.category !== b.category) return categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
      if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
      return a.range.start.character - b.range.start.character;
    });
  }
}

class CategoryHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const docDiagnostics = diagnostics.get(document.uri) ?? [];
    const categories = new Set<Category>();

    for (const diag of docDiagnostics) {
      if (!diag.range.contains(position)) continue;
      const code = diagnosticCodeToString(diag.code);
      categories.add(resolveCategory(code));
    }

    if (categories.size === 0) return undefined;

    const label = localize("hover.category", "Category");
    const lines = Array.from(categories).map((category) => `${label}: ${category}`);
    return new vscode.Hover(lines.join("\n"));
  }
}

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  loadSelectedCompileCommandsFromState();
  diagnostics = vscode.languages.createDiagnosticCollection("clang-tidy");
  output = vscode.window.createOutputChannel("Clang-Tidy");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = localize("status.idle", "Clang-Tidy: idle");
  statusBar.show();
  summaryStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  summaryStatusBar.command = "clangTidy.setFindingsFilter";
  context.subscriptions.push(diagnostics, output, statusBar, summaryStatusBar);
  output.appendLine(localize("msg.activated", "Clang-Tidy extension activated."));

  reloadCategoryConfig();
  registerPersistWatchers(context);
  findingsProvider = new FindingsProvider();
  context.subscriptions.push(
    vscode.window.createTreeView<FindingsNode>("clangTidy.findings", { treeDataProvider: findingsProvider })
  );

  if (getAutoLoadPersistedOnStartup()) {
    await restorePersistedResults();
  } else {
    updateSummaryStatusBar();
  }

  await startDaemon(context);
  void detectClangTidyVersion();
  void refreshPluginArgs();

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.runFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (!isSupportedDocument(editor.document)) {
        vscode.window.showWarningMessage(
          localize(
            "msg.unsupportedLanguage",
            "Clang-Tidy works only for C/C++ files. Current language: {0}.",
            editor.document.languageId
          )
        );
        output.appendLine(
          localize(
            "msg.unsupportedLanguageLog",
            "Unsupported languageId: {0} for file {1}",
            editor.document.languageId,
            editor.document.fileName
          )
        );
        return;
      }
      await runAnalyzeFile(editor.document.uri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.runFileQuick", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (!isSupportedDocument(editor.document)) {
        vscode.window.showWarningMessage(
          localize(
            "msg.unsupportedLanguage",
            "Clang-Tidy works only for C/C++ files. Current language: {0}.",
            editor.document.languageId
          )
        );
        output.appendLine(
          localize(
            "msg.unsupportedLanguageLog",
            "Unsupported languageId: {0} for file {1}",
            editor.document.languageId,
            editor.document.fileName
          )
        );
        return;
      }
      await runAnalyzeFileWithMode(editor.document.uri, "quick");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.runFileFull", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (!isSupportedDocument(editor.document)) {
        vscode.window.showWarningMessage(
          localize(
            "msg.unsupportedLanguage",
            "Clang-Tidy works only for C/C++ files. Current language: {0}.",
            editor.document.languageId
          )
        );
        output.appendLine(
          localize(
            "msg.unsupportedLanguageLog",
            "Unsupported languageId: {0} for file {1}",
            editor.document.languageId,
            editor.document.fileName
          )
        );
        return;
      }
      await runAnalyzeFileWithMode(editor.document.uri, "full");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.runProject", async () => {
      await runAnalyzeProject();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.runProjectQuick", async () => {
      await runAnalyzeProjectWithMode("quick");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.runProjectFull", async () => {
      await runAnalyzeProjectWithMode("full");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.runProjectDiff", async () => {
      const { manual } = getModes();
      await runAnalyzeProjectWithMode(manual, undefined, { diffOnly: true });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.openCompileCommands", async () => {
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      const compilePath = await resolveCompileCommandsPathForUri(activeUri);
      if (!compilePath) {
        vscode.window.showWarningMessage(
          localize("msg.openCompileCommandsNotFound", "Clang-Tidy: compile_commands.json not found.")
        );
        return;
      }
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(compilePath));
      output.appendLine(
        localize(
          "msg.openCompileCommandsRevealed",
          "Clang-Tidy: revealed compile_commands.json location: {0}",
          compilePath
        )
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.generateCompileCommandsHelp", async () => {
      await showGenerateCompileCommandsHint();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.selectCompileCommands", async () => {
      const candidates = await findCompileCommandsAcrossWorkspace();
      if (candidates.length === 0) {
        vscode.window.showWarningMessage(
          localize(
            "msg.compileCommandsMissingProject",
            "Clang-Tidy: compile_commands.json not found. Project analysis cannot run."
          )
        );
        return;
      }
      const picked = await pickCompileCommandsPath(
        candidates,
        localize("msg.pickCompileCommandsProject", "Select compile_commands.json for project analysis")
      );
      if (picked) {
        await setSelectedCompileCommandsPath(picked.workspaceFolder, picked.path);
        output.appendLine(
          localize(
            "msg.openCompileCommandsRevealed",
            "Clang-Tidy: revealed compile_commands.json location: {0}",
            picked.path
          )
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.openFinding", async (finding: Finding) => {
      if (!finding) return;
      await openFinding(finding);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.nextFinding", async () => {
      await navigateFinding("next");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.prevFinding", async () => {
      await navigateFinding("prev");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.showMoreFindings", async (uri: vscode.Uri) => {
      if (!uri) return;
      const key = uri.toString();
      const current = findingsPageState.get(key) ?? 1;
      findingsPageState.set(key, current + 1);
      findingsProvider?.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.setFindingsFilter", async () => {
      const filter = await promptFindingsFilter();
      if (!filter) return;
      await applyFindingsFilter(filter);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.clearFindingsFilter", async () => {
      await applyFindingsFilter(null);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.filterByCategoryAtCursor", async () => {
      const hit = pickDiagnosticAtCursor();
      if (!hit) {
        vscode.window.showInformationMessage(
          localize("msg.filterNoDiagnostic", "No clang-tidy diagnostic under cursor.")
        );
        return;
      }
      const code = diagnosticCodeToString(hit.diagnostic.code);
      const category = resolveCategory(code);
      const filter: FindingsFilter = { categories: new Set([category]) };
      await applyFindingsFilter(filter);
      vscode.window.showInformationMessage(
        localize("msg.filterCategoryApplied", "Findings filter set to category: {0}", category)
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.filterByCheckAtCursor", async () => {
      const hit = pickDiagnosticAtCursor();
      if (!hit) {
        vscode.window.showInformationMessage(
          localize("msg.filterNoDiagnostic", "No clang-tidy diagnostic under cursor.")
        );
        return;
      }
      const code = diagnosticCodeToString(hit.diagnostic.code);
      if (!code) {
        vscode.window.showInformationMessage(
          localize("msg.filterNoCheck", "Diagnostic has no clang-tidy check code.")
        );
        return;
      }
      const filter: FindingsFilter = { checkPattern: code };
      await applyFindingsFilter(filter);
      vscode.window.showInformationMessage(
        localize("msg.filterCheckApplied", "Findings filter set to check: {0}", code)
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.setBaseline", async () => {
      if (!getPersistResultsEnabled()) {
        vscode.window.showWarningMessage(
          localize("msg.baselineRequiresPersist", "Baseline requires persistResults to be enabled.")
        );
        return;
      }
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) return;
      const folder =
        folders.length === 1
          ? folders[0]
          : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Select workspace for baseline" });
      if (!folder) return;

      await loadPersistedIndex(folder);
      const entries = getPersistedEntriesForFolder(folder);
      if (entries.length === 0) {
        vscode.window.showWarningMessage(
          localize("msg.baselineEmpty", "No persisted results found. Run project analysis first.")
        );
        return;
      }

      const files: Record<string, string[]> = {};
      for (const { uri } of entries) {
        const diagnosticsList = await loadPersistedDiagnostics(uri);
        if (!diagnosticsList) continue;
        const keys = diagnosticsList.map((d) => baselineKeyForDiagnostic(d));
        files[uri] = keys;
      }

      const sig = await getPersistSignature(folder);
      const baseline: BaselineData = {
        version: 1,
        createdAt: Date.now(),
        clangTidyVersion: sig.clangTidyVersion,
        compileCommandsPath: sig.compileCommandsPath,
        compileCommandsMtimeMs: sig.compileCommandsMtimeMs,
        clangTidyConfigPath: sig.clangTidyConfigPath,
        clangTidyConfigMtimeMs: sig.clangTidyConfigMtimeMs,
        files,
      };

      await saveBaselineForFolder(folder, baseline);
      await rebuildFilteredIndexState(findingsFilter);
      updateOpenFileDiagnosticsForBaseline();
      updateSummaryStatusBar();
      findingsProvider?.refresh();
      vscode.window.showInformationMessage(localize("msg.baselineSaved", "Baseline saved."));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.clearBaseline", async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) return;
      const folder =
        folders.length === 1
          ? folders[0]
          : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Select workspace to clear baseline" });
      if (!folder) return;
      await clearBaselineForFolder(folder);
      await rebuildFilteredIndexState(findingsFilter);
      updateOpenFileDiagnosticsForBaseline();
      updateSummaryStatusBar();
      findingsProvider?.refresh();
      vscode.window.showInformationMessage(localize("msg.baselineCleared", "Baseline cleared."));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.restorePersistedResults", async () => {
      await restorePersistedResults({ showInfo: true });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.fixAllProjectDryRun", async () => {
      if (!getPersistResultsEnabled()) {
        vscode.window.showWarningMessage(
          localize("msg.fixAllRequiresPersist", "Fix-all requires persistResults to be enabled.")
        );
        return;
      }
      const entries = getAllPersistedEntries();
      if (entries.length === 0) {
        vscode.window.showWarningMessage(
          localize("msg.fixAllEmpty", "No persisted results found. Run project analysis first.")
        );
        return;
      }

      const dirtyDocs = vscode.workspace.textDocuments.filter((d) => d.isDirty && isSupportedDocument(d));
      const dirtyPaths = dirtyDocs.map((d) => d.uri.fsPath);

      let totalFixes = 0;
      let totalEdits = 0;
      let totalConflicts = 0;
      let totalFiles = 0;

      const reportLines: string[] = [];
      reportLines.push("# Clang-Tidy Fix-All Dry Run");
      reportLines.push("");
      reportLines.push(`Generated: ${new Date().toISOString()}`);
      reportLines.push(`Files scanned: ${entries.length}`);
      reportLines.push("");

      if (dirtyPaths.length > 0) {
        reportLines.push("## Dirty Files (unsaved)");
        for (const p of dirtyPaths) reportLines.push(`- ${p}`);
        reportLines.push("");
      }

      reportLines.push("## Fix Summary");

      for (const { uri } of entries) {
        const diagnosticsList = await loadPersistedDiagnostics(uri);
        if (!diagnosticsList) continue;
        const edits: Array<{ range: vscode.Range; title: string }> = [];
        let fixCount = 0;
        for (const d of diagnosticsList) {
          if (!d.fixes) continue;
          for (const fix of d.fixes) {
            fixCount += 1;
            for (const e of fix.edits) {
              edits.push({ range: rpcRangeToVs(e.range), title: fix.title });
            }
          }
        }
        if (edits.length === 0) continue;

        edits.sort((a, b) => {
          if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
          return a.range.start.character - b.range.start.character;
        });

        let conflicts = 0;
        let prevEnd: vscode.Position | null = null;
        for (const e of edits) {
          if (prevEnd && (e.range.start.isBefore(prevEnd) || e.range.start.isEqual(prevEnd))) {
            conflicts += 1;
          }
          prevEnd = e.range.end;
        }

        totalFiles += 1;
        totalFixes += fixCount;
        totalEdits += edits.length;
        totalConflicts += conflicts;

        reportLines.push(`- ${uri}`);
        reportLines.push(`  fixes: ${fixCount}, edits: ${edits.length}, conflicts: ${conflicts}`);
      }

      reportLines.push("");
      reportLines.push("## Totals");
      reportLines.push(`- files with fixes: ${totalFiles}`);
      reportLines.push(`- fixes: ${totalFixes}`);
      reportLines.push(`- edits: ${totalEdits}`);
      reportLines.push(`- conflicts: ${totalConflicts}`);
      reportLines.push("");
      reportLines.push("Note: This is a dry run based on the last persisted clang-tidy results.");

      const doc = await vscode.workspace.openTextDocument({ content: reportLines.join("\\n"), language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: false });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.fixAllProjectApply", async () => {
      if (!getPersistResultsEnabled()) {
        vscode.window.showWarningMessage(
          localize("msg.fixAllRequiresPersist", "Fix-all requires persistResults to be enabled.")
        );
        return;
      }
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) return;
      const folder =
        folders.length === 1
          ? folders[0]
          : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Select workspace for fix-all" });
      if (!folder) return;

      await loadPersistedIndex(folder);
      const entries = getPersistedEntriesForFolder(folder);
      if (entries.length === 0) {
        vscode.window.showWarningMessage(
          localize("msg.fixAllEmpty", "No persisted results found. Run project analysis first.")
        );
        return;
      }

      const dirtyDocs = vscode.workspace.textDocuments.filter((d) => d.isDirty && isSupportedDocument(d));
      const dirtyPaths = new Set(dirtyDocs.map((d) => d.uri.fsPath));

      let totalFixes = 0;
      let totalEdits = 0;
      let totalConflicts = 0;
      let totalFiles = 0;
      let totalSkippedDirty = 0;
      let totalApplyFailures = 0;

      const reportLines: string[] = [];
      reportLines.push("# Clang-Tidy Fix-All Apply");
      reportLines.push("");
      reportLines.push(`Generated: ${new Date().toISOString()}`);
      reportLines.push(`Files scanned: ${entries.length}`);
      reportLines.push("");

      if (dirtyPaths.size > 0) {
        reportLines.push("## Dirty Files (skipped)");
        for (const p of Array.from(dirtyPaths.values())) reportLines.push(`- ${p}`);
        reportLines.push("");
      }

      reportLines.push("## Apply Summary");

      for (const { uri } of entries) {
        const filePath = vscode.Uri.parse(uri).fsPath;
        if (dirtyPaths.has(filePath)) {
          totalSkippedDirty += 1;
          continue;
        }
        const diagnosticsList = await loadPersistedDiagnostics(uri);
        if (!diagnosticsList) continue;
        const edits = collectFixEditsFromDiagnostics(diagnosticsList);
        if (edits.length === 0) continue;

        const { applied, conflicts } = selectNonOverlappingEdits(edits);
        if (applied.length === 0) {
          totalConflicts += conflicts;
          reportLines.push(`- ${uri}`);
          reportLines.push(`  fixes: 0, edits: 0, conflicts: ${conflicts}`);
          continue;
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        for (const edit of applied) {
          workspaceEdit.replace(vscode.Uri.parse(uri), edit.range, edit.newText);
        }
        const appliedOk = await vscode.workspace.applyEdit(workspaceEdit);
        if (!appliedOk) {
          totalApplyFailures += 1;
          reportLines.push(`- ${uri}`);
          reportLines.push(`  failed to apply edits`);
          continue;
        }

        totalFiles += 1;
        totalFixes += applied.length;
        totalEdits += applied.length;
        totalConflicts += conflicts;
        reportLines.push(`- ${uri}`);
        reportLines.push(`  edits applied: ${applied.length}, conflicts: ${conflicts}`);
      }

      reportLines.push("");
      reportLines.push("## Totals");
      reportLines.push(`- files updated: ${totalFiles}`);
      reportLines.push(`- edits applied: ${totalEdits}`);
      reportLines.push(`- conflicts skipped: ${totalConflicts}`);
      reportLines.push(`- skipped dirty files: ${totalSkippedDirty}`);
      reportLines.push(`- apply failures: ${totalApplyFailures}`);
      reportLines.push("");
      reportLines.push("Note: Fixes are based on the last persisted clang-tidy results.");

      const doc = await vscode.workspace.openTextDocument({ content: reportLines.join("\\n"), language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: false });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.showChecks", async () => {
      const configPath = await findClangTidyConfigPath();
      if (!configPath) {
        vscode.window.showWarningMessage(
          localize("msg.clangTidyConfigMissing", ".clang-tidy not found in workspace.")
        );
        return;
      }

      const checksText = await fs.promises.readFile(configPath, "utf8").catch(() => "");
      const checks = extractChecksFromConfig(checksText);
      if (!checks) {
        vscode.window.showWarningMessage(
          localize("msg.checksMissing", "Checks not found in .clang-tidy.")
        );
        return;
      }

      const cfg = vscode.workspace.getConfiguration("clangTidy");
      const configured = cfg.get<string>("clangTidyPath", "clang-tidy").trim();
      const clangPath = await findClangTidyPath(configured);
      if (!clangPath) {
        vscode.window.showWarningMessage(
          localize("msg.clangTidyNotFound", "clang-tidy not found. Configure clangTidyPath.")
        );
        return;
      }

      const allResult = await execFileAsync(clangPath, ["-list-checks"]);
      const activeResult = await execFileAsync(clangPath, ["-list-checks", `-checks=${checks}`]);
      if (!allResult || !activeResult) {
        vscode.window.showWarningMessage(
          localize("msg.clangTidyListChecksFailed", "Failed to list clang-tidy checks.")
        );
        return;
      }

      const active = parseCheckList(activeResult.stdout || activeResult.stderr);
      const disabled = parseDisabledTokens(checks);
      const title = localize("msg.checksTitle", "Clang-Tidy Checks");
      const panel = vscode.window.createWebviewPanel(
        "clangTidyChecks",
        title,
        vscode.ViewColumn.Beside,
        { enableFindWidget: true }
      );
      panel.webview.html = renderChecksHtml(title, configPath, checks, active, disabled);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.showCategories", async () => {
      const panel = vscode.window.createWebviewPanel(
        "clangTidyCategories",
        localize("msg.categoriesTitle", "Clang-Tidy Categories"),
        vscode.ViewColumn.Beside,
        { enableFindWidget: true }
      );
      const styles = readCategoryStyles();
      panel.webview.html = renderCategoryLegendHtml(styles);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.stop", async () => {
      await stopAnalysis();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.restartDaemon", async () => {
      clearDaemonTimers();
      connection?.dispose();
      connection = null;
      daemonRestartAttempts = 0;
      resetRuntimeForDaemonRestart();
      await startDaemon(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clangTidy.diagnoseEnvironment", async () => {
      await diagnoseEnvironment(context);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const cfg = vscode.workspace.getConfiguration("clangTidy");
      const onSave = cfg.get<boolean>("onSave", true);
      if (!onSave) return;
      const { onSave: onSaveMode } = getModes();
      if (!isSupportedDocument(doc)) return;
      const allowed = await ensureFileInCompilation(doc.uri);
      if (!allowed) return;
      if (!connection) return;
      dirtySuppressedFiles.delete(doc.uri.toString());
      const runId = `run-${Date.now()}-${runCounter++}`;
      const result = (await connection.sendRequest("analyzeFile", {
        runId,
        fileUri: doc.uri.toString(),
        mode: onSaveMode,
      })) as AnalyzeFileResult;
      handlePublishDiagnostics({ runId, fileUri: result.fileUri, diagnostics: result.diagnostics });
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(() => {
      const cfg = vscode.workspace.getConfiguration("clangTidy");
      const configured = cfg.get<string>("compileCommandsPath", "").trim();
      if (configured) {
        runtimeCompileCommandsPath = null;
      }
      if (connection) {
        connection.sendNotification("configChanged", { settings: getSettings() });
      }
      cachedClangTidyVersion = null;
      cachedClangTidyPath = null;
      clangTidyDetected = false;
      clearCompileCommandsCaches();
      warnedNotInCompilation.clear();
      warnedNoCompileCommands.clear();
      reloadCategoryConfig();
      registerPersistWatchers(context);
      for (const timer of onTypeTimers.values()) {
        clearTimeout(timer);
      }
      onTypeTimers.clear();
      void detectClangTidyVersion();
      void refreshPluginArgs();
      void loadPersistedIndices().then(async () => {
        await loadBaselines();
        if (findingsFilter) {
          void rebuildFilteredIndexState(findingsFilter);
        } else if (getBaselineEnabled()) {
          void rebuildFilteredIndexState(null);
        } else {
          filteredIndex = null;
        }
        updateOpenFileDiagnosticsForBaseline();
        updateSummaryStatusBar();
      });
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(async (editors) => {
      let changed = false;
      for (const editor of editors) {
        if (await loadPersistedForDocument(editor.document)) {
          changed = true;
        }
      }
      if (changed) {
        rebuildFindingsCache();
        findingsProvider?.refresh();
        updateSummaryStatusBar();
      }
      refreshCategoryDecorations();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const doc = e.document;
      if (!isSupportedDocument(doc)) return;
      if (!getUseUnsavedBuffer()) return;
      if (!doc.isDirty) return;

      const uri = doc.uri.toString();
      if (!dirtySuppressedFiles.has(uri)) {
        clearOpenFileDiagnostics(uri);
      }

      if (!getOnTypeEnabled()) return;
      const active = vscode.window.activeTextEditor?.document.uri.toString();
      if (active !== uri) return;

      const delay = getOnTypeDebounceMs();
      const existing = onTypeTimers.get(uri);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(async () => {
        onTypeTimers.delete(uri);
        await runAnalyzeFileWithMode(doc.uri, getOnTypeMode());
      }, delay);
      onTypeTimers.set(uri, timer);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const uri = doc.uri.toString();
      const timer = onTypeTimers.get(uri);
      if (timer) {
        clearTimeout(timer);
        onTypeTimers.delete(uri);
      }
      dirtySuppressedFiles.delete(uri);
      for (const [runId, entry] of runIdToDocVersion.entries()) {
        if (entry.uri === uri) {
          runIdToDocVersion.delete(runId);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (!editor) return;
      const changed = await loadPersistedForDocument(editor.document);
      applyCategoryDecorationsForEditor(editor);
      if (changed) {
        rebuildFindingsCache();
        findingsProvider?.refresh();
        updateSummaryStatusBar();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString();
      diagnostics.delete(doc.uri);
      categoryStore.delete(key);
      categoryLineStore.delete(key);
      lastDiagnosticsStore.delete(key);
      const prevFindings = findingStore.get(key) ?? [];
      const prevFixCount = fixCountStore.get(key) ?? 0;
      totalDiagnosticsCount = Math.max(0, totalDiagnosticsCount - prevFindings.length);
      totalFixesCount = Math.max(0, totalFixesCount - prevFixCount);
      findingStore.delete(key);
      fixCountStore.delete(key);
      findingsPageState.delete(key);
      rebuildFindingsCache();
      findingsProvider?.refresh();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async (doc) => {
      if (await loadPersistedForDocument(doc)) {
        rebuildFindingsCache();
        findingsProvider?.refresh();
        updateSummaryStatusBar();
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [{ scheme: "file", language: "cpp" }, { scheme: "file", language: "c" }],
      new FixCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [{ scheme: "file", language: "cpp" }, { scheme: "file", language: "c" }],
      new CategoryHoverProvider()
    )
  );
}

export function deactivate() {
  diagnostics?.dispose();
  connection?.dispose();
  for (const [, deco] of categoryHighlightDecorationTypes) {
    deco.dispose();
  }
  for (const [, deco] of categoryIconDecorationTypes) {
    deco.dispose();
  }
}

async function ensureCompileCommandsAvailable(uri?: vscode.Uri): Promise<boolean> {
  const index = await getCompileCommandsIndex(uri);
  if (!index) {
    if (!warnedNoCompileCommands.has("__project__")) {
      warnedNoCompileCommands.add("__project__");
      await showWarningWithSettings(
        localize(
          "msg.compileCommandsMissingProject",
          "Clang-Tidy: compile_commands.json not found. Project analysis cannot run."
        )
      );
    }
    return false;
  }
  return true;
}

async function ensureCompileCommandsAvailableForFolder(folder: vscode.WorkspaceFolder): Promise<boolean> {
  const index = await getCompileCommandsIndexForFolder(folder);
  if (!index) {
    const key = `__project__:${folder.uri.fsPath}`;
    if (!warnedNoCompileCommands.has(key)) {
      warnedNoCompileCommands.add(key);
      await showWarningWithSettings(
        localize(
          "msg.compileCommandsMissingProject",
          "Clang-Tidy: compile_commands.json not found. Project analysis cannot run."
        )
      );
    }
    return false;
  }
  return true;
}

async function ensureFileInCompilation(uri: vscode.Uri): Promise<boolean> {
  const index = await getCompileCommandsIndex(uri);
  if (!index) {
    const key = uri.fsPath;
    if (!warnedNoCompileCommands.has(key)) {
      warnedNoCompileCommands.add(key);
      await showWarningWithSettings(
        localize(
          "msg.compileCommandsMissingFile",
          "Clang-Tidy: compile_commands.json not found. The file analysis may be incomplete."
        )
      );
    }
    return true;
  }

  const filePath = await realpathSafe(uri.fsPath);
  if (!index.files.has(filePath)) {
    if (!warnedNotInCompilation.has(filePath)) {
      warnedNotInCompilation.add(filePath);
      await showWarningWithSettings(
        localize(
          "msg.fileNotInCompilation",
          "Clang-Tidy: file is not present in compile_commands.json and may not be analyzed."
        )
      );
    }
    return false;
  }
  return true;
}

async function getCompileCommandsIndex(uri?: vscode.Uri): Promise<CompileCommandsIndex | null> {
  const compilePath = await resolveCompileCommandsPathForUri(uri);
  if (!compilePath) return null;
  return await getCompileCommandsIndexForPath(compilePath);
}

async function getCompileCommandsIndexForFolder(
  folder: vscode.WorkspaceFolder
): Promise<CompileCommandsIndex | null> {
  const compilePath = await resolveCompileCommandsPathForFolder(folder);
  if (!compilePath) return null;
  return await getCompileCommandsIndexForPath(compilePath);
}

async function getGitChangedFiles(
  folder: vscode.WorkspaceFolder,
  includeUntracked: boolean
): Promise<Set<string> | null> {
  const cwd = folder.uri.fsPath;
  const result = await execFileAsyncWithCwd("git", ["status", "--porcelain=1", "-z"], cwd, 8000);
  if (!result) return null;
  const output = result.stdout;
  if (!output) return new Set();

  const entries = output.split("\0").filter((v) => v.length > 0);
  const files = new Set<string>();
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    if (entry.length < 3) {
      i += 1;
      continue;
    }
    const status = entry.slice(0, 2);
    const pathPart = entry.slice(3);
    const staged = status[0];
    const unstaged = status[1];
    const isRename = staged === "R" || staged === "C" || unstaged === "R" || unstaged === "C";
    const isUntracked = status === "??";
    const isDeleted = staged === "D" || unstaged === "D";

    if (isDeleted || (!includeUntracked && isUntracked)) {
      i += isRename ? 2 : 1;
      continue;
    }

    const targetPath = isRename && i + 1 < entries.length ? entries[i + 1] : pathPart;
    i += isRename ? 2 : 1;
    if (!targetPath) continue;
    const absolute = path.resolve(cwd, targetPath);
    const canonical = await realpathSafe(absolute);
    files.add(canonical);
  }

  return files;
}

async function findFilesRecursive(
  root: string,
  name: string,
  depth: number,
  excludes: Set<string>
): Promise<string[]> {
  if (depth < 0) return [];
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  const matches: string[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) {
      matches.push(path.join(root, entry.name));
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (shouldSkipDir(entry.name, excludes)) continue;
    const found = await findFilesRecursive(path.join(root, entry.name), name, depth - 1, excludes);
    matches.push(...found);
  }

  return matches;
}

function shouldSkipDir(name: string, excludes: Set<string>): boolean {
  if (excludes.has(name)) return true;
  return name === ".git" || name === "node_modules" || name === ".vscode";
}

function isSupportedLanguageId(id: string): boolean {
  return supportedLanguageIds.has(id);
}

function isSupportedDocument(doc: vscode.TextDocument): boolean {
  if (isSupportedLanguageId(doc.languageId)) return true;
  const ext = path.extname(doc.fileName).toLowerCase();
  return supportedExtensions.has(ext);
}

async function realpathSafe(p: string): Promise<string> {
  return await fs.promises.realpath(p).catch(() => path.normalize(p));
}

async function showWarningWithSettings(message: string): Promise<void> {
  const openLabel = localize("button.openSettings", "Open Settings");
  const generateLabel = localize("button.generateCompileCommands", "Generate compile_commands.json");
  const choice = await vscode.window.showWarningMessage(message, openLabel, generateLabel);
  if (choice === openLabel) {
    await vscode.commands.executeCommand("workbench.action.openSettings", "clangTidy.compileCommandsPath");
  }
  if (choice === generateLabel) {
    await showGenerateCompileCommandsHint();
  }
}

async function showGenerateCompileCommandsHint(): Promise<void> {
  const title = localize(
    "msg.generateCompileCommandsTitle",
    "Generate compile_commands.json"
  );
  const body = localize(
    "msg.generateCompileCommandsBody",
    "CMake: cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON\nMeson: meson setup builddir (compile_commands.json will be in builddir)\nThen set clangTidy.compileCommandsPath if the file is not in the workspace root."
  );
  output.appendLine(title);
  for (const line of body.split("\\n")) {
    output.appendLine(line);
  }
  const openOutput = localize("button.openOutput", "Open Output");
  const choice = await vscode.window.showInformationMessage(title, openOutput);
  if (choice === openOutput) {
    output.show(true);
  }
}

function handleProgress(p: { runId: string | number; kind: string; message?: string; percent?: number }) {
  const key = String(p.runId);
  handleProjectProgress(key, p);
  if (p.kind === "begin") {
    setRunActive(key);
  } else if (p.kind === "end") {
    setRunInactive(key);
  } else {
    const aggregate = getAggregateProjectProgress();
    if (aggregate) {
      updateStatusBar(aggregate.message, aggregate.percent);
    } else {
      updateStatusBar(p.message, p.percent);
    }
  }
}

function getAggregateProjectProgress(): { message?: string; percent?: number } | null {
  let total = 0;
  let done = 0;
  for (const state of projectRuns.values()) {
    if (state.totalFiles <= 0) continue;
    total += state.totalFiles;
    done += state.doneFiles;
    if (state.activeRunId) {
      const batch = projectRunById.get(state.activeRunId);
      if (batch) {
        done += Math.min(batch.done, batch.total);
      }
    }
  }
  if (total === 0) return null;
  const percent = Math.floor((done / total) * 100);
  return { message: `Analyzed ${done}/${total} files`, percent };
}

function handleProjectProgress(
  runId: string,
  p: { runId: string | number; kind: string; message?: string; percent?: number }
): void {
  const batch = projectRunById.get(runId);
  if (!batch) return;
  const state = projectRuns.get(batch.workspaceKey);

  if (p.kind === "report" && p.message) {
    const match = p.message.match(/Analyzed\s+(\d+)\/(\d+)\s+files/i);
    if (match) {
      batch.done = parseInt(match[1], 10);
      batch.total = parseInt(match[2], 10);
    }
    return;
  }

  if (p.kind === "end") {
    batch.done = batch.total;
    if (state && state.activeRunId === runId) {
      state.doneFiles += batch.total;
      state.activeRunId = null;
    }
    if (projectActiveWorkspaceKey === batch.workspaceKey) {
      projectActiveWorkspaceKey = null;
    }
    projectRunById.delete(runId);
    void startNextProjectBatchIfIdle();
  }
}

function setRunActive(runId: string) {
  activeRuns.add(runId);
  updateStatusBar();
}

function setRunInactive(runId: string) {
  activeRuns.delete(runId);
  updateStatusBar();
}

function updateStatusBar(message?: string, percent?: number) {
  if (!statusBar) return;
  if (activeRuns.size === 0) {
    statusBar.text = localize("status.idle", "Clang-Tidy: idle");
    statusBar.tooltip = undefined;
    return;
  }
  const aggregate = getAggregateProjectProgress();
  const pctValue = aggregate?.percent ?? percent;
  const tooltipMessage = aggregate?.message ?? message;
  const pct = typeof pctValue === "number" ? ` ${pctValue}%` : "";
  statusBar.text = localize(
    "status.busy",
    "$(sync~spin) Clang-Tidy: analyzing ({0}){1}",
    activeRuns.size,
    pct
  );
  statusBar.tooltip = tooltipMessage ?? localize("status.busyTooltip", "Analyzing with clang-tidy");
}

async function detectClangTidyVersion(): Promise<void> {
  if (clangTidyDetected) return;
  clangTidyDetected = true;

  const cfg = vscode.workspace.getConfiguration("clangTidy");
  const configured = cfg.get<string>("clangTidyPath", "clang-tidy").trim();

  const autoPath = await findClangTidyPath(configured);
  if (!autoPath) return;

  const versionLine = await getClangTidyVersion(autoPath);
  if (!versionLine) return;

  const version = extractVersion(versionLine) ?? versionLine.trim();
  cachedClangTidyVersion = version;
  cachedClangTidyPath = autoPath;
  const major = parseInt(version.split(".")[0], 10);
  const minVersion = cfg.get<number>("minVersion", 12);
  if (minVersion > 0 && !Number.isNaN(major) && major < minVersion) {
    vscode.window.showWarningMessage(
      localize(
        "msg.clangTidyTooOld",
        "Detected clang-tidy {0}. Minimum recommended version is {1}.",
        version,
        String(minVersion)
      )
    );
  }
  if (configured === "" || configured === "clang-tidy") {
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await cfg.update("clangTidyPath", autoPath, target);
    vscode.window.showInformationMessage(
      localize(
        "msg.autoDetectedClangTidy",
        "Detected clang-tidy {0}. Set clangTidyPath to {1}.",
        version,
        autoPath
      )
    );
  } else if (autoPath !== configured) {
    const message = localize(
      "msg.detectedClangTidy",
      "Detected clang-tidy {0} at {1}. Use this path?",
      version,
      autoPath
    );
    const useLabel = localize("button.useDetectedPath", "Use this clang-tidy");
    const choice = await vscode.window.showInformationMessage(message, useLabel);
    if (choice === useLabel) {
      const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await cfg.update("clangTidyPath", autoPath, target);
    }
  } else {
    output.appendLine(
      localize(
        "msg.detectedClangTidy",
        "Detected clang-tidy {0} at {1}. Use this path?",
        version,
        autoPath
      )
    );
  }
}

async function getClangTidyVersion(bin: string): Promise<string | null> {
  const result = await execFileAsync(bin, ["--version"]);
  if (!result) return null;
  const line =
    result.stdout.split(/\r?\n/).find((l) => l.trim().length > 0) ||
    result.stderr.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line ? line.trim() : null;
}

async function resolveWhich(bin: string): Promise<string | null> {
  const result = await execFileAsync("which", [bin]);
  if (!result) return null;
  const line = result.stdout.trim();
  return line.length > 0 ? line : null;
}

async function findClangTidyPath(configured: string): Promise<string | null> {
  if (configured && configured !== "clang-tidy") {
    if (await pathExists(configured)) return configured;
  }

  const whichPath = await resolveWhich("clang-tidy");
  if (whichPath) return whichPath;

  const candidates = [
    "/opt/homebrew/opt/llvm/bin/clang-tidy",
    "/usr/local/opt/llvm/bin/clang-tidy",
  ];
  for (const p of candidates) {
    if (await pathExists(p)) return p;
  }

  const runCandidates = [
    "/opt/homebrew/opt/llvm/bin/run-clang-tidy",
    "/usr/local/opt/llvm/bin/run-clang-tidy",
  ];
  for (const p of runCandidates) {
    const clangPath = p.replace(/run-clang-tidy$/, "clang-tidy");
    if (await pathExists(clangPath)) return clangPath;
  }

  const runWhich = await resolveWhich("run-clang-tidy");
  if (runWhich) {
    const clangPath = runWhich.replace(/run-clang-tidy$/, "clang-tidy");
    if (await pathExists(clangPath)) return clangPath;
  }

  return null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string } | null> {
  return await new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout, stderr) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function execFileAsyncWithCwd(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string } | null> {
  const options: { timeout?: number; cwd: string } = { cwd };
  if (timeoutMs && timeoutMs > 0) options.timeout = timeoutMs;
  return await new Promise((resolve) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function extractVersion(line: string): string | null {
  const match = line.match(/version\\s+([0-9]+(\\.[0-9]+)*)/i);
  return match ? match[1] : null;
}
