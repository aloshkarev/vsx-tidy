# Clang-Tidy VS Code Extension

Full clang-tidy management with smart hints, fixes, and high-performance analysis backed by a Rust daemon.

## Features
- Run clang-tidy on the current file or the entire project.
- Quick/Full modes (fast on-save, deep on-demand).
- Diagnostics + quick fixes (fix-its) in editor.
- On-save analysis for C/C++ (configurable).
- Status bar indicator with progress.
- Auto-detect clang-tidy and suggest a usable path.
- Helps locate and generate `compile_commands.json`.
- Persistent index stores per-check counts for faster filtering in large projects.
- Daemon disk cache speeds up repeated runs on large projects.
- Daemon can enforce per-file timeouts and throttle diagnostics to keep the UI responsive.
- Unsaved editor buffers can be analyzed for accurate live diagnostics.
- Baseline mode hides existing findings to focus on new issues.
- Fix-all dry run generates a report of available fixes across the project.

## Requirements
- `clang-tidy` installed locally.
- `compile_commands.json` available (recommended for accurate analysis).
- Supported languages: C and C++ only.

## Commands
- `Clang-Tidy: Run on Current File`
- `Run Clang-Tidy (Quick)`
- `Run Clang-Tidy (Full)`
- `Clang-Tidy: Run on Project`
- `Run Clang-Tidy on Project (Quick)`
- `Run Clang-Tidy on Project (Full)`
- `Run Clang-Tidy on Project (Diff Only)`
- `Clang-Tidy: Open compile_commands.json location`
- `Clang-Tidy: Generate compile_commands.json (Help)`
- `Clang-Tidy: Select compile_commands.json`
- `Clang-Tidy: Show Categories`
- `Clang-Tidy: Next Finding`
- `Clang-Tidy: Previous Finding`
- `Clang-Tidy: Set Findings Filter`
- `Clang-Tidy: Clear Findings Filter`
- `Clang-Tidy: Filter by Category at Cursor`
- `Clang-Tidy: Filter by Check at Cursor`
- `Clang-Tidy: Show Active Checks`
- `Clang-Tidy: Set Baseline`
- `Clang-Tidy: Clear Baseline`
- `Clang-Tidy: Restore Persisted Results`
- `Clang-Tidy: Fix All in Project (Dry Run)`
- `Clang-Tidy: Fix All in Project (Apply)`
- `Clang-Tidy: Stop Analysis`
- `Clang-Tidy: Restart Daemon`
- `Clang-Tidy: Diagnose Environment`

## Settings
- `clangTidy.onSave`: Run clang-tidy on file save.
- `clangTidy.onSaveMode`: `quick` or `full` for on-save.
- `clangTidy.onType`: Run clang-tidy while typing (debounced, active file only).
- `clangTidy.onTypeMode`: `quick` or `full` for on-type.
- `clangTidy.onTypeDebounceMs`: Debounce window (ms) for on-type analysis.
- `clangTidy.fallbackToCli`: Fallback to clang-tidy CLI when daemon is unavailable (slower, no fix-its).
- `clangTidy.manualMode`: `quick` or `full` for manual runs.
- `clangTidy.quickChecks`: Overrides checks in quick mode (clang-tidy `-checks=`).
- `clangTidy.clangTidyPath`: Path to clang-tidy executable.
- `clangTidy.minVersion`: Minimum recommended major version (0 disables check).
- `clangTidy.compileCommandsPath`: Path to compile_commands.json.
- `clangTidy.searchExcludeDirs`: Folders to skip when searching for compile_commands.json.
- `clangTidy.searchDepth`: Max directory depth for searching compile_commands.json.
- `clangTidy.autoDetectPlugins`: Auto-detect clang-tidy plugin libraries in the workspace.
- `clangTidy.pluginPaths`: Additional plugin paths (files or directories).
- `clangTidy.pluginSearchDepth`: Max directory depth for plugin detection.
- `clangTidy.pluginNameHints`: Filename hints used to detect plugin libraries.
- `clangTidy.updateDebounceMs`: Debounce window for UI updates.
- `clangTidy.maxDiagnosticsPerFile`: Cap diagnostics per file (0 = unlimited).
- `clangTidy.maxFixesPerFile`: Cap fix-its per file (0 = unlimited).
- `clangTidy.maxTotalDiagnostics`: Soft cap for total diagnostics in memory.
- `clangTidy.failSafeTotalDiagnostics`: Fail-safe threshold for total diagnostics.
- `clangTidy.failSafeAutoCancel`: Cancel analysis when fail-safe triggers.
- `clangTidy.failSafeDisableDecorations`: Disable decorations when fail-safe triggers.
- `clangTidy.findingsPageSize`: Page size for Findings view (0 = no paging).
- `clangTidy.baselineEnabled`: Show only diagnostics not present in the baseline.
- `clangTidy.projectBatchSize`: Batch size for project analysis (0 = no batching).
- `clangTidy.projectDiffOnly`: Analyze only changed git files (staged/unstaged) for project runs.
- `clangTidy.projectDiffIncludeUntracked`: Include untracked files in diff-only project analysis.
- `clangTidy.projectIncremental`: Analyze only changed files during project runs.
- `clangTidy.projectPrioritizeActive`: Analyze active file first during project runs.
- `clangTidy.projectPrioritizeOpen`: Analyze open files before the rest during project runs.
- `clangTidy.projectAdaptiveBatching`: Enable adaptive batching when the UI/daemon is under load.
- `clangTidy.projectAdaptiveMinBatchSize`: Minimum batch size when adaptive batching is enabled.
- `clangTidy.projectAdaptiveBackoffFactor`: Backoff factor (0-1) for adaptive batching.
- `clangTidy.showSummaryStatus`: Show category summary in status bar.
- `clangTidy.persistResults`: Persist clang-tidy results to `.vscode/clang-tidy-results`.
- `clangTidy.autoLoadPersistedOnStartup`: Auto-load persisted results at startup (Findings view + cached diagnostics).
- `clangTidy.persistDebounceMs`: Debounce window for persisting results.
- `clangTidy.daemonCacheOnDisk`: Enable disk cache inside the daemon.
- `clangTidy.daemonAutoRestart`: Automatically restart the daemon if it exits or becomes unresponsive.
- `clangTidy.daemonRestartMaxAttempts`: Max restart attempts before giving up.
- `clangTidy.daemonRestartDelayMs`: Delay (ms) before restarting the daemon.
- `clangTidy.daemonHealthCheckIntervalMs`: Health check interval (ms) for the daemon (0 = disabled).
- `clangTidy.daemonCacheDir`: Custom cache directory (default: `.vscode/clang-tidy-daemon-cache`).
- `clangTidy.perFileTimeoutMs`: Per-file clang-tidy timeout in milliseconds (0 = disabled).
- `clangTidy.publishDiagnosticsThrottleMs`: Minimum delay between diagnostics notifications (0 = disabled).
- `clangTidy.useUnsavedBuffer`: Analyze unsaved editor content for the active file.
- `clangTidy.unsavedBufferMaxBytes`: Max size of unsaved buffer to send to daemon (0 = unlimited).
- `clangTidy.extraArgs`: Extra clang-tidy args.
- `clangTidy.maxWorkers`: Parallel workers for daemon.
- `clangTidy.daemonPath`: Optional path to daemon binary.
- `clangTidy.categoryRules`: Mapping rules from check names to categories (prefix or regex).
- `clangTidy.categoryColors`: Per-category highlight colors (background/border/overviewRuler).

## Generating compile_commands.json
- CMake: `cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`
- Meson: `meson setup builddir` (file is in builddir)

If the file is not in the workspace root, set `clangTidy.compileCommandsPath` to the file or its directory.

## Build (Developer)
1. Build daemon for your platform (see `scripts/build-daemon.sh`).
   - Linux x64 (from macOS via Docker): `scripts/build-daemon-docker.sh`
2. Copy binaries into `extension/bin` or set `clangTidy.daemonPath`.
3. Install extension deps and build:
   - `cd extension`
   - `npm install`
   - `npm run build`

## Notes
- Linux/macOS only.
- Project analysis requires `compile_commands.json`.
- Per-file diagnostic/fix caps are enforced in the daemon to keep large project runs stable.
