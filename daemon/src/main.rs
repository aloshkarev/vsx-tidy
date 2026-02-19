use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::hash::{Hash, Hasher};
use std::collections::hash_map::DefaultHasher;
use std::time::{Duration, Instant, UNIX_EPOCH};

use anyhow::{Context, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tempfile::{NamedTempFile, TempDir};
use url::Url;
use walkdir::WalkDir;
use threadpool::ThreadPool;

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct Settings {
    #[serde(default)]
    clangTidyPath: String,
    #[serde(default)]
    compileCommandsPath: String,
    #[serde(default)]
    extraArgs: Vec<String>,
    #[serde(default)]
    maxWorkers: u32,
    #[serde(default)]
    quickChecks: String,
    #[serde(default)]
    maxDiagnosticsPerFile: u32,
    #[serde(default)]
    maxFixesPerFile: u32,
    #[serde(default)]
    daemonCacheOnDisk: bool,
    #[serde(default)]
    daemonCacheDir: String,
    #[serde(default)]
    perFileTimeoutMs: u64,
    #[serde(default)]
    publishDiagnosticsThrottleMs: u64,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse<T> {
    jsonrpc: &'static str,
    id: Value,
    result: T,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

#[derive(Debug, Serialize)]
struct JsonRpcErrorResponse {
    jsonrpc: &'static str,
    id: Value,
    error: JsonRpcError,
}

#[derive(Debug, Serialize)]
struct LogParams {
    level: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
struct Notification<T> {
    jsonrpc: &'static str,
    method: &'static str,
    params: T,
}

#[derive(Clone)]
struct AppState {
    settings: Arc<Mutex<Settings>>,
    root_dir: Arc<Mutex<Option<PathBuf>>>,
    compile_commands: Arc<Mutex<Option<PathBuf>>>,
    compile_index: Arc<Mutex<Option<Arc<CompileCommandsIndex>>>>,
    stdout: Arc<Mutex<io::Stdout>>,
    cancel_map: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    cache: Arc<Mutex<HashMap<PathBuf, CacheEntry>>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Position {
    line: usize,
    character: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Range {
    start: Position,
    end: Position,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct TextEdit {
    range: Range,
    #[serde(rename = "newText")]
    new_text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Fix {
    title: String,
    edits: Vec<TextEdit>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct RpcDiagnostic {
    range: Range,
    severity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fixes: Option<Vec<Fix>>,
}

const DISK_CACHE_VERSION: u32 = 1;

#[derive(Debug, Clone)]
struct CacheEntry {
    mtime: u64,
    size: u64,
    settings_hash: u64,
    diagnostics: Vec<RpcDiagnostic>,
}

#[derive(Debug, Deserialize, Serialize)]
struct DiskCacheEntry {
    version: u32,
    filePath: String,
    mtime: u64,
    size: u64,
    settingsHash: u64,
    diagnostics: Vec<RpcDiagnostic>,
}

#[derive(Debug, Clone)]
struct InternalDiagnostic {
    file: PathBuf,
    range: Range,
    severity: String,
    code: Option<String>,
    message: String,
    fixes: Vec<Fix>,
}

#[derive(Debug, Deserialize)]
struct FixesFile {
    #[serde(rename = "Diagnostics", default)]
    diagnostics: Vec<FixDiagnostic>,
}

#[derive(Debug, Deserialize)]
struct FixDiagnostic {
    #[serde(rename = "DiagnosticName")]
    diagnostic_name: Option<String>,
    #[serde(rename = "DiagnosticMessage")]
    diagnostic_message: Option<FixMessage>,
    #[serde(rename = "Message")]
    message: Option<String>,
    #[serde(rename = "FilePath")]
    file_path: Option<String>,
    #[serde(rename = "FileOffset")]
    file_offset: Option<usize>,
    #[serde(rename = "Replacements")]
    replacements: Option<Vec<FixReplacement>>,
}

#[derive(Debug, Deserialize, Clone)]
struct FixMessage {
    #[serde(rename = "Message")]
    message: Option<String>,
    #[serde(rename = "FilePath")]
    file_path: Option<String>,
    #[serde(rename = "FileOffset")]
    file_offset: Option<usize>,
    #[serde(rename = "Replacements")]
    replacements: Option<Vec<FixReplacement>>,
}

#[derive(Debug, Deserialize, Clone)]
struct FixReplacement {
    #[serde(rename = "FilePath", default)]
    file_path: String,
    #[serde(rename = "Offset", default)]
    offset: usize,
    #[serde(rename = "Length", default)]
    length: usize,
    #[serde(rename = "ReplacementText", default)]
    replacement_text: String,
}

#[derive(Debug, Deserialize)]
struct CompileCommand {
    file: String,
    directory: String,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    arguments: Option<Vec<String>>,
}

#[derive(Debug)]
struct CompileCommandsIndex {
    path: PathBuf,
    mtime: u64,
    files: Vec<PathBuf>,
    file_set: HashSet<PathBuf>,
    commands: HashMap<PathBuf, CompileCommandEntry>,
}

#[derive(Debug, Clone)]
struct CompileCommandEntry {
    file: String,
    directory: String,
    command: Option<String>,
    arguments: Option<Vec<String>>,
}

fn main() -> Result<()> {
    let stdin = io::stdin();
    let stdout = Arc::new(Mutex::new(io::stdout()));

    let state = AppState {
        settings: Arc::new(Mutex::new(Settings::default())),
        root_dir: Arc::new(Mutex::new(None)),
        compile_commands: Arc::new(Mutex::new(None)),
        compile_index: Arc::new(Mutex::new(None)),
        stdout: stdout.clone(),
        cancel_map: Arc::new(Mutex::new(HashMap::new())),
        cache: Arc::new(Mutex::new(HashMap::new())),
    };

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }

        let value: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(err) => {
                send_notification(&stdout, "log", LogParams {
                    level: "error",
                    message: format!("Failed to parse JSON: {err}"),
                })?;
                continue;
            }
        };

        let method = value.get("method").and_then(|m| m.as_str()).map(|s| s.to_string());
        let id = value.get("id").cloned();
        let params = value.get("params").cloned().unwrap_or(Value::Null);

        if let Some(method) = method {
            if let Some(id) = id {
                let response = handle_request(&method, params, &state);
                match response {
                    Ok(result) => {
                        let resp = JsonRpcResponse { jsonrpc: "2.0", id, result };
                        write_json(&stdout, &resp)?;
                    }
                    Err(err) => {
                        let resp = JsonRpcErrorResponse {
                            jsonrpc: "2.0",
                            id,
                            error: JsonRpcError { code: -32000, message: err.to_string() },
                        };
                        write_json(&stdout, &resp)?;
                    }
                }
            } else {
                handle_notification(&method, params, &state)?;
            }
        }
    }

    Ok(())
}

fn handle_request(method: &str, params: Value, state: &AppState) -> Result<Value> {
    match method {
        "initialize" => {
            if let Some(root_uri) = params.get("rootUri").and_then(|v| v.as_str()) {
                if let Some(path) = uri_to_path(root_uri) {
                    *state.root_dir.lock().unwrap() = Some(path);
                }
            }
            if let Some(s) = params.get("settings") {
                if let Ok(parsed) = serde_json::from_value::<Settings>(s.clone()) {
                    *state.settings.lock().unwrap() = parsed;
                }
            }
            *state.compile_commands.lock().unwrap() = None;
            *state.compile_index.lock().unwrap() = None;
            let result = serde_json::json!({
                "server": {"name": "clang-tidy-daemon", "version": "0.1.0"},
                "capabilities": {"analyzeFile": true, "analyzeProject": true, "cancel": true},
                "pid": std::process::id(),
            });
            Ok(result)
        }
        "shutdown" => Ok(serde_json::json!({})),
        "ping" => Ok(serde_json::json!({ "ok": true })),
        "analyzeFile" => {
            let run_id = params.get("runId").cloned().unwrap_or(Value::String("unknown".to_string()));
            let file_uri = params.get("fileUri").and_then(|v| v.as_str()).unwrap_or("");
            let mode = params.get("mode").and_then(|v| v.as_str()).unwrap_or("full").to_string();
            let file_content = params.get("fileContent").and_then(|v| v.as_str()).map(|s| s.to_string());
            let file_path = uri_to_path(file_uri).context("Invalid fileUri")?;

            let settings = state.settings.lock().unwrap().clone();
            let root_dir = state.root_dir.lock().unwrap().clone();
            let compile_commands = resolve_compile_commands_path(&settings, root_dir.as_deref(), state);
            let compile_index = match compile_commands.as_deref() {
                Some(path) => match get_compile_index(path, state) {
                    Ok(index) => Some(index),
                    Err(err) => {
                        let _ = send_notification(&state.stdout, "log", LogParams {
                            level: "warn",
                            message: format!("Failed to load compile_commands.json index: {err}"),
                        });
                        None
                    }
                },
                None => None,
            };

            if let Some(index) = compile_index.as_ref() {
                if !file_in_index(&file_path, index) {
                    let result = serde_json::json!({
                        "runId": run_id,
                        "fileUri": file_uri,
                        "diagnostics": [],
                    });
                    return Ok(result);
                }
            }
            let diags = if let Some(content) = file_content {
                analyze_file_with_content(
                    &file_path,
                    &content,
                    &settings,
                    root_dir.as_deref(),
                    compile_commands.as_deref(),
                    compile_index.as_deref(),
                    mode.as_str(),
                )
                .unwrap_or_else(|_| {
                    analyze_file(
                        &file_path,
                        &settings,
                        root_dir.as_deref(),
                        compile_commands.as_deref(),
                        mode.as_str(),
                        &state.cache,
                    )
                    .unwrap_or_default()
                })
            } else {
                analyze_file(
                    &file_path,
                    &settings,
                    root_dir.as_deref(),
                    compile_commands.as_deref(),
                    mode.as_str(),
                    &state.cache,
                )?
            };
            let result = serde_json::json!({
                "runId": run_id,
                "fileUri": file_uri,
                "diagnostics": diags,
            });
            Ok(result)
        }
        "analyzeProject" => {
            let run_id = params.get("runId").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
            let mode = params.get("mode").and_then(|v| v.as_str()).unwrap_or("full").to_string();
            let incremental = params.get("incremental").and_then(|v| v.as_bool()).unwrap_or(true);
            let batch_size = params.get("batchSize").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let settings = state.settings.lock().unwrap().clone();
            let root_dir = state.root_dir.lock().unwrap().clone();
            let stdout = state.stdout.clone();
            let compile_commands = resolve_compile_commands_path(&settings, root_dir.as_deref(), state);
            let cache = state.cache.clone();
            let compile_index = match compile_commands.as_deref() {
                Some(path) => match get_compile_index(path, state) {
                    Ok(index) => Some(index),
                    Err(err) => {
                        let _ = send_notification(&stdout, "log", LogParams {
                            level: "error",
                            message: format!("Failed to load compile_commands.json index: {err}"),
                        });
                        None
                    }
                },
                None => None,
            };

            let cancel_flag = Arc::new(AtomicBool::new(false));
            state.cancel_map.lock().unwrap().insert(run_id.clone(), cancel_flag.clone());

            let run_id_thread = run_id.clone();
            thread::spawn(move || {
                let run_id_for_tasks = run_id_thread.clone();
                let _ = send_notification(&stdout, "progress", serde_json::json!({
                    "runId": run_id_thread,
                    "kind": "begin",
                    "message": format!("Starting project analysis ({mode})")
                }));

                let compile_commands = match compile_commands {
                    Some(p) => p,
                    None => {
                        let _ = send_notification(&stdout, "log", LogParams {
                            level: "error",
                            message: "compile_commands.json not found".to_string(),
                        });
                        return;
                    }
                };

                let mut files: Vec<PathBuf> = if let Some(list) = params.get("files").and_then(|v| v.as_array()) {
                    let mut override_files = Vec::new();
                    for entry in list {
                        if let Some(raw) = entry.as_str() {
                            if let Ok(url) = Url::parse(raw) {
                                if let Ok(path) = url.to_file_path() {
                                    override_files.push(path);
                                    continue;
                                }
                            }
                            override_files.push(PathBuf::from(raw));
                        }
                    }
                    override_files
                } else if let Some(index) = compile_index.as_ref() {
                    index.files.clone()
                } else {
                    match load_project_files(&compile_commands) {
                        Ok(v) => v,
                        Err(err) => {
                            let _ = send_notification(&stdout, "log", LogParams {
                                level: "error",
                                message: format!("Failed to load compile_commands.json: {err}"),
                            });
                            return;
                        }
                    }
                };

                if incremental {
                    let compile_dir = compile_commands.parent();
                    let compile_commands_mtime = mtime_for_path(&compile_commands);
                    let config_mtime = clang_tidy_config_mtime(root_dir.as_deref(), compile_dir);
                    let settings_hash = settings_fingerprint(&settings, Some(&compile_commands), compile_commands_mtime, config_mtime, mode.as_str());
                    let cache_dir = resolve_cache_dir(&settings, root_dir.as_deref(), compile_dir);
                    files.retain(|file_path| !is_cached(file_path, &cache, settings_hash, cache_dir.as_deref()));
                }

                let total = files.len();
                if total == 0 {
                    let _ = send_notification(&stdout, "progress", serde_json::json!({
                        "runId": run_id_thread,
                        "kind": "end",
                        "message": if incremental { "No changed files to analyze" } else { "No files found in compile_commands.json" }
                    }));
                    return;
                }

                let throttle_ms = settings.publishDiagnosticsThrottleMs;
                let limiter = Arc::new(Mutex::new(Instant::now() - Duration::from_millis(throttle_ms)));

                let pool = ThreadPool::new(settings.maxWorkers.max(1) as usize);
                let done = Arc::new(AtomicUsize::new(0));
                let effective_batch = if batch_size == 0 { total } else { batch_size.max(1) };
                for chunk in files.chunks(effective_batch) {
                    for file_path in chunk.iter().cloned() {
                        let cancel = cancel_flag.clone();
                        let stdout = stdout.clone();
                        let settings = settings.clone();
                        let root_dir = root_dir.clone();
                        let compile_commands = compile_commands.clone();
                        let done = done.clone();
                        let run_id = run_id_for_tasks.clone();
                        let cache = cache.clone();
                        let mode = mode.clone();
                        let limiter = limiter.clone();

                        pool.execute(move || {
                            if cancel.load(Ordering::Relaxed) {
                                return;
                            }

                            let diags = match analyze_file(
                                &file_path,
                                &settings,
                                root_dir.as_deref(),
                                Some(&compile_commands),
                                mode.as_str(),
                                &cache,
                            ) {
                                Ok(d) => d,
                                Err(err) => {
                                    let _ = send_notification(&stdout, "log", LogParams {
                                        level: "error",
                                        message: format!("clang-tidy failed for {}: {err}", file_path.display()),
                                    });
                                    Vec::new()
                                }
                            };

                            let file_uri = match Url::from_file_path(&file_path) {
                                Ok(u) => u.to_string(),
                                Err(_) => return,
                            };

                            throttle_publish(&limiter, throttle_ms);
                            let _ = send_notification(&stdout, "publishDiagnostics", serde_json::json!({
                                "runId": run_id,
                                "fileUri": file_uri,
                                "diagnostics": diags,
                            }));

                            let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
                            let percent = (finished as f64 / total as f64 * 100.0) as u32;
                            if finished == total || finished % 10 == 0 {
                                let _ = send_notification(&stdout, "progress", serde_json::json!({
                                    "runId": run_id,
                                    "kind": "report",
                                    "message": format!("Analyzed {finished}/{total} files"),
                                    "percent": percent
                                }));
                            }
                        });
                    }

                    pool.join();
                }

                let _ = send_notification(&stdout, "progress", serde_json::json!({
                    "runId": run_id_thread,
                    "kind": "end",
                    "message": "Project analysis completed"
                }));
            });

            Ok(serde_json::json!({ "runId": run_id }))
        }
        "cancel" => {
            if let Some(run_id) = params.get("runId").and_then(|v| v.as_str()) {
                let map = state.cancel_map.lock().unwrap();
                if run_id == "*" {
                    for (_, flag) in map.iter() {
                        flag.store(true, Ordering::Relaxed);
                    }
                } else if let Some(flag) = map.get(run_id) {
                    flag.store(true, Ordering::Relaxed);
                }
            }
            Ok(serde_json::json!({}))
        }
        _ => Ok(serde_json::json!({})),
    }
}

fn handle_notification(method: &str, params: Value, state: &AppState) -> Result<()> {
    if method == "configChanged" {
        if let Some(s) = params.get("settings") {
            if let Ok(parsed) = serde_json::from_value::<Settings>(s.clone()) {
                *state.settings.lock().unwrap() = parsed;
                *state.compile_commands.lock().unwrap() = None;
                *state.compile_index.lock().unwrap() = None;
            }
        }
        send_notification(&state.stdout, "log", LogParams {
            level: "info",
            message: "Settings updated".to_string(),
        })?;
    }
    Ok(())
}

fn analyze_file(
    file_path: &Path,
    settings: &Settings,
    root_dir: Option<&Path>,
    compile_commands: Option<&Path>,
    mode: &str,
    cache: &Arc<Mutex<HashMap<PathBuf, CacheEntry>>>,
) -> Result<Vec<RpcDiagnostic>> {
    let clang_tidy = if settings.clangTidyPath.is_empty() {
        "clang-tidy".to_string()
    } else {
        settings.clangTidyPath.clone()
    };

    let compile_dir = compile_commands.and_then(|p| p.parent());
    let base_dir = compile_dir.or(root_dir);

    let file_sig = file_signature(file_path);
    let compile_commands_mtime = compile_commands.and_then(mtime_for_path);
    let config_mtime = clang_tidy_config_mtime(root_dir, compile_dir);
    let settings_hash = settings_fingerprint(settings, compile_commands, compile_commands_mtime, config_mtime, mode);
    let cache_dir = resolve_cache_dir(settings, root_dir, compile_dir);

    if let Some((mtime, size)) = file_sig {
        if let Some(entry) = cache.lock().unwrap().get(file_path) {
            if entry.mtime == mtime && entry.size == size && entry.settings_hash == settings_hash {
                return Ok(entry.diagnostics.clone());
            }
        }
        if let Some(dir) = cache_dir.as_deref() {
            if let Some(diags) = read_disk_cache(dir, file_path, mtime, size, settings_hash) {
                cache.lock().unwrap().insert(
                    file_path.to_path_buf(),
                    CacheEntry {
                        mtime,
                        size,
                        settings_hash,
                        diagnostics: diags.clone(),
                    },
                );
                return Ok(diags);
            }
        }
    }

    let temp = NamedTempFile::new().context("Failed to create temp file for fixes")?;

    let mut cmd = Command::new(clang_tidy);
    cmd.arg(file_path);
    if let Some(dir) = compile_dir {
        cmd.arg("-p").arg(dir);
        cmd.current_dir(dir);
    } else if let Some(dir) = root_dir {
        cmd.current_dir(dir);
    }
    cmd.arg("-export-fixes").arg(temp.path());
    cmd.arg("--quiet");
    cmd.arg("-extra-arg=-fno-color-diagnostics");
    if mode == "quick" && !settings.quickChecks.trim().is_empty() {
        cmd.arg(format!("-checks={}", settings.quickChecks.trim()));
    }
    for arg in &settings.extraArgs {
        cmd.arg(arg);
    }

    let output = run_command_with_timeout(&mut cmd, settings.perFileTimeoutMs)
        .context("Failed to run clang-tidy")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);

    let mut diags = parse_diagnostics(&combined, base_dir, file_path);
    let fix_diags = parse_fixes(temp.path(), base_dir, file_path);

    if let Ok(fixes) = fix_diags {
        merge_diagnostics(&mut diags, fixes);
    }

    diags.retain(|d| paths_match(&d.file, file_path));
    apply_diagnostic_caps(&mut diags, settings.maxDiagnosticsPerFile, settings.maxFixesPerFile);
    let result: Vec<RpcDiagnostic> = diags.into_iter().map(to_rpc_diagnostic).collect();

    if let Some((mtime, size)) = file_sig {
        cache.lock().unwrap().insert(
            file_path.to_path_buf(),
            CacheEntry {
                mtime,
                size,
                settings_hash,
                diagnostics: result.clone(),
            },
        );
        if let Some(dir) = cache_dir.as_deref() {
            let _ = write_disk_cache(dir, file_path, mtime, size, settings_hash, &result);
        }
    }

    Ok(result)
}

fn analyze_file_with_content(
    file_path: &Path,
    content: &str,
    settings: &Settings,
    root_dir: Option<&Path>,
    compile_commands: Option<&Path>,
    compile_index: Option<&CompileCommandsIndex>,
    mode: &str,
) -> Result<Vec<RpcDiagnostic>> {
    let _ = compile_commands.context("compile_commands.json not found")?;
    let index = compile_index.context("compile_commands index missing")?;
    let entry = find_compile_entry(index, file_path).context("compile command not found for file")?;

    let temp_dir = TempDir::new().context("Failed to create temp dir for unsaved buffer")?;
    let filename = file_path.file_name().unwrap_or_else(|| std::ffi::OsStr::new("file.cpp"));
    let temp_file = temp_dir.path().join(filename);
    std::fs::write(&temp_file, content).context("Failed to write temp file content")?;

    let mut args = resolve_arguments(&entry).context("compile command missing arguments")?;
    let original_path = file_path.to_string_lossy().to_string();
    let temp_path = temp_file.to_string_lossy().to_string();
    let replaced = replace_file_arg(&mut args, &entry.file, &original_path, &temp_path);
    if !replaced {
        return Err(anyhow::anyhow!("compile command does not reference file path"));
    }

    let compile_entry = serde_json::json!({
        "directory": entry.directory,
        "file": temp_path,
        "arguments": args,
    });
    let compile_path = temp_dir.path().join("compile_commands.json");
    std::fs::write(&compile_path, serde_json::to_vec(&vec![compile_entry])?)
        .context("Failed to write temp compile_commands.json")?;

    let clang_tidy = if settings.clangTidyPath.is_empty() {
        "clang-tidy".to_string()
    } else {
        settings.clangTidyPath.clone()
    };

    let base_dir = PathBuf::from(&entry.directory);
    let base_dir_ref = if base_dir.exists() { Some(base_dir.as_path()) } else { root_dir };
    let config_path = find_clang_tidy_config(file_path, root_dir, base_dir_ref);

    let temp = NamedTempFile::new().context("Failed to create temp file for fixes")?;
    let mut cmd = Command::new(clang_tidy);
    cmd.arg(&temp_file);
    cmd.arg("-p").arg(temp_dir.path());
    if base_dir.exists() {
        cmd.current_dir(&base_dir);
    } else if let Some(dir) = root_dir {
        cmd.current_dir(dir);
    }
    cmd.arg("-export-fixes").arg(temp.path());
    cmd.arg("--quiet");
    cmd.arg("-extra-arg=-fno-color-diagnostics");
    if let Some(config) = config_path {
        cmd.arg(format!("--config-file={}", config.display()));
    }
    if mode == "quick" && !settings.quickChecks.trim().is_empty() {
        cmd.arg(format!("-checks={}", settings.quickChecks.trim()));
    }
    for arg in &settings.extraArgs {
        cmd.arg(arg);
    }

    let output = run_command_with_timeout(&mut cmd, settings.perFileTimeoutMs)
        .context("Failed to run clang-tidy")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);

    let mut diags = parse_diagnostics(&combined, base_dir_ref, &temp_file);
    for diag in diags.iter_mut() {
        diag.file = file_path.to_path_buf();
    }
    let fix_diags = parse_fixes(temp.path(), base_dir_ref, &temp_file);

    if let Ok(mut fixes) = fix_diags {
        for fix in fixes.iter_mut() {
            fix.file = file_path.to_path_buf();
        }
        merge_diagnostics(&mut diags, fixes);
    }

    diags.retain(|d| paths_match(&d.file, file_path));
    apply_diagnostic_caps(&mut diags, settings.maxDiagnosticsPerFile, settings.maxFixesPerFile);
    let result: Vec<RpcDiagnostic> = diags.into_iter().map(to_rpc_diagnostic).collect();
    Ok(result)
}

fn parse_diagnostics(output: &str, root_dir: Option<&Path>, default_file: &Path) -> Vec<InternalDiagnostic> {
    let re = Regex::new(r"^(?P<file>.+?):(?P<line>\d+):(?P<col>\d+): (?P<severity>warning|error|note): (?P<message>.*?)(?: \[(?P<code>.+?)\])?$").unwrap();
    let mut diags = Vec::new();

    for line in output.lines() {
        if let Some(caps) = re.captures(line) {
            let file_raw = caps.name("file").map(|m| m.as_str()).unwrap_or("");
            let file_path = resolve_path(file_raw, root_dir).unwrap_or_else(|| default_file.to_path_buf());
            let line_num: usize = caps.name("line").and_then(|m| m.as_str().parse().ok()).unwrap_or(1);
            let col_num: usize = caps.name("col").and_then(|m| m.as_str().parse().ok()).unwrap_or(1);
            let severity_raw = caps.name("severity").map(|m| m.as_str()).unwrap_or("warning");
            let severity = normalize_severity(severity_raw);
            let message = caps.name("message").map(|m| m.as_str()).unwrap_or("").to_string();
            let code = caps.name("code").map(|m| m.as_str().to_string());

            let range = range_from_line_col(line_num, col_num);
            diags.push(InternalDiagnostic {
                file: file_path,
                range,
                severity,
                code,
                message,
                fixes: Vec::new(),
            });
        }
    }

    diags
}

fn parse_fixes(fixes_path: &Path, root_dir: Option<&Path>, target_file: &Path) -> Result<Vec<InternalDiagnostic>> {
    if !fixes_path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(fixes_path).unwrap_or_default();
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }

    let fixes: FixesFile = serde_yaml::from_str(&content).context("Failed to parse fixes YAML")?;
    let file_text = std::fs::read_to_string(target_file).unwrap_or_default();
    let line_starts = build_line_starts(&file_text);

    let mut diags = Vec::new();

    for diag in fixes.diagnostics {
        let (message, file_path, file_offset, replacements) = if let Some(dm) = diag.diagnostic_message.as_ref() {
            (
                dm.message.clone().or(diag.message.clone()).unwrap_or_default(),
                dm.file_path.clone().or(diag.file_path.clone()).unwrap_or_default(),
                dm.file_offset.or(diag.file_offset).unwrap_or(0),
                dm.replacements.clone().or(diag.replacements.clone()).unwrap_or_default(),
            )
        } else {
            (
                diag.message.clone().unwrap_or_default(),
                diag.file_path.clone().unwrap_or_default(),
                diag.file_offset.unwrap_or(0),
                diag.replacements.clone().unwrap_or_default(),
            )
        };

        let diag_path = resolve_path(&file_path, root_dir).unwrap_or_else(|| target_file.to_path_buf());
        if !paths_match(&diag_path, target_file) {
            continue;
        }

        let mut edits = Vec::new();
        for rep in replacements {
            let rep_path = resolve_path(&rep.file_path, root_dir).unwrap_or_else(|| target_file.to_path_buf());
            if !paths_match(&rep_path, target_file) {
                continue;
            }
            let range = offset_range(&file_text, &line_starts, rep.offset, rep.length);
            edits.push(TextEdit {
                range,
                new_text: rep.replacement_text,
            });
        }

        if edits.is_empty() {
            continue;
        }

        let range = offset_range(&file_text, &line_starts, file_offset, 1);
        let fix = Fix {
            title: match &diag.diagnostic_name {
                Some(name) if !name.is_empty() => format!("Apply clang-tidy fix ({name})"),
                _ => "Apply clang-tidy fix".to_string(),
            },
            edits,
        };

        diags.push(InternalDiagnostic {
            file: diag_path,
            range,
            severity: "warning".to_string(),
            code: diag.diagnostic_name.clone(),
            message,
            fixes: vec![fix],
        });
    }

    Ok(diags)
}

fn merge_diagnostics(base: &mut Vec<InternalDiagnostic>, fixes: Vec<InternalDiagnostic>) {
    let mut map: HashMap<String, InternalDiagnostic> = HashMap::new();
    for d in base.drain(..) {
        map.insert(diag_key(&d), d);
    }

    for mut f in fixes {
        let key = diag_key(&f);
        if let Some(existing) = map.get_mut(&key) {
            existing.fixes.append(&mut f.fixes);
        } else {
            map.insert(key, f);
        }
    }

    *base = map.into_values().collect();
}

fn apply_diagnostic_caps(diags: &mut Vec<InternalDiagnostic>, max_diags: u32, max_fixes: u32) {
    if max_diags > 0 && diags.len() > max_diags as usize {
        diags.truncate(max_diags as usize);
    }

    if max_fixes == 0 {
        return;
    }

    let mut remaining = max_fixes as usize;
    for diag in diags.iter_mut() {
        if diag.fixes.is_empty() {
            continue;
        }
        if remaining == 0 {
            diag.fixes.clear();
            continue;
        }
        if diag.fixes.len() > remaining {
            diag.fixes.truncate(remaining);
            remaining = 0;
        } else {
            remaining -= diag.fixes.len();
        }
    }
}

fn throttle_publish(limiter: &Arc<Mutex<Instant>>, throttle_ms: u64) {
    if throttle_ms == 0 {
        return;
    }
    let mut last = limiter.lock().unwrap();
    let elapsed = last.elapsed();
    let interval = Duration::from_millis(throttle_ms);
    if elapsed < interval {
        thread::sleep(interval - elapsed);
    }
    *last = Instant::now();
}

fn run_command_with_timeout(cmd: &mut Command, timeout_ms: u64) -> Result<std::process::Output> {
    if timeout_ms == 0 {
        return Ok(cmd.output()?);
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().context("Failed to run clang-tidy")?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let mut stdout = String::new();
            let mut stderr = String::new();
            if let Some(mut out) = child.stdout.take() {
                let _ = out.read_to_string(&mut stdout);
            }
            if let Some(mut err) = child.stderr.take() {
                let _ = err.read_to_string(&mut stderr);
            }
            return Ok(std::process::Output {
                status,
                stdout: stdout.into_bytes(),
                stderr: stderr.into_bytes(),
            });
        }
        if start.elapsed() >= Duration::from_millis(timeout_ms) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow::anyhow!("clang-tidy timed out after {} ms", timeout_ms));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn split_command(command: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;

    for ch in command.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }
        if ch == '\\' && !in_single {
            escape = true;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            continue;
        }
        if ch.is_whitespace() && !in_single && !in_double {
            if !current.is_empty() {
                args.push(current.clone());
                current.clear();
            }
            continue;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

fn replace_file_arg(args: &mut [String], raw_file: &str, original_path: &str, temp_path: &str) -> bool {
    let mut replaced = false;
    for arg in args.iter_mut() {
        if arg == raw_file || arg == original_path {
            *arg = temp_path.to_string();
            replaced = true;
        }
    }
    replaced
}

fn resolve_arguments(entry: &CompileCommandEntry) -> Option<Vec<String>> {
    if let Some(args) = entry.arguments.clone() {
        return Some(args);
    }
    entry.command.as_ref().map(|cmd| split_command(cmd))
}

fn diag_key(d: &InternalDiagnostic) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        d.file.display(),
        d.range.start.line,
        d.range.start.character,
        d.code.clone().unwrap_or_default(),
        d.message
    )
}

fn to_rpc_diagnostic(d: InternalDiagnostic) -> RpcDiagnostic {
    RpcDiagnostic {
        range: d.range,
        severity: d.severity,
        code: d.code,
        message: d.message,
        fixes: if d.fixes.is_empty() { None } else { Some(d.fixes) },
    }
}

fn normalize_severity(raw: &str) -> String {
    match raw {
        "error" => "error",
        "warning" => "warning",
        _ => "info",
    }
    .to_string()
}

fn range_from_line_col(line: usize, col: usize) -> Range {
    let line0 = line.saturating_sub(1);
    let col0 = col.saturating_sub(1);
    Range {
        start: Position { line: line0, character: col0 },
        end: Position { line: line0, character: col0 + 1 },
    }
}

fn build_line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            starts.push(i + 1);
        }
    }
    starts
}

fn offset_range(text: &str, line_starts: &[usize], offset: usize, length: usize) -> Range {
    let (start_line, start_col) = offset_to_line_col(text, line_starts, offset);
    let (end_line, end_col) = offset_to_line_col(text, line_starts, offset + length);
    Range {
        start: Position { line: start_line, character: start_col },
        end: Position { line: end_line, character: end_col },
    }
}

fn offset_to_line_col(text: &str, line_starts: &[usize], offset: usize) -> (usize, usize) {
    let offset = offset.min(text.len());
    let mut line = 0;
    for (idx, &start) in line_starts.iter().enumerate() {
        if start > offset {
            break;
        }
        line = idx;
    }
    let line_start = line_starts.get(line).cloned().unwrap_or(0);
    let slice = &text[line_start..offset];
    let col = slice.encode_utf16().count();
    (line, col)
}

fn resolve_path(path_str: &str, root_dir: Option<&Path>) -> Option<PathBuf> {
    if path_str.is_empty() {
        return None;
    }
    let p = PathBuf::from(path_str);
    if p.is_absolute() {
        Some(p)
    } else if let Some(root) = root_dir {
        Some(root.join(p))
    } else {
        Some(p)
    }
}

fn file_signature(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some((mtime, meta.len()))
}

fn mtime_for_path(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    meta.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
}

fn clang_tidy_config_mtime(root_dir: Option<&Path>, compile_dir: Option<&Path>) -> Option<u64> {
    let mut candidates = Vec::new();
    if let Some(dir) = compile_dir {
        candidates.push(dir.to_path_buf());
    }
    if let Some(dir) = root_dir {
        candidates.push(dir.to_path_buf());
    }

    for dir in candidates {
        let p = dir.join(".clang-tidy");
        if p.exists() {
            return mtime_for_path(&p);
        }
    }
    None
}

fn find_clang_tidy_config(file_path: &Path, root_dir: Option<&Path>, compile_dir: Option<&Path>) -> Option<PathBuf> {
    let mut current = file_path.parent();
    while let Some(dir) = current {
        let candidate = dir.join(".clang-tidy");
        if candidate.exists() {
            return Some(candidate);
        }
        if root_dir.is_some() && root_dir == Some(dir) {
            break;
        }
        if compile_dir.is_some() && compile_dir == Some(dir) {
            break;
        }
        current = dir.parent();
    }

    if let Some(dir) = compile_dir {
        let candidate = dir.join(".clang-tidy");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    if let Some(dir) = root_dir {
        let candidate = dir.join(".clang-tidy");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn settings_fingerprint(
    settings: &Settings,
    compile_commands: Option<&Path>,
    compile_commands_mtime: Option<u64>,
    config_mtime: Option<u64>,
    mode: &str,
) -> u64 {
    let mut hasher = DefaultHasher::new();
    settings.clangTidyPath.hash(&mut hasher);
    settings.extraArgs.hash(&mut hasher);
    settings.maxWorkers.hash(&mut hasher);
    settings.quickChecks.hash(&mut hasher);
    settings.maxDiagnosticsPerFile.hash(&mut hasher);
    settings.maxFixesPerFile.hash(&mut hasher);
    settings.perFileTimeoutMs.hash(&mut hasher);
    mode.hash(&mut hasher);
    if let Some(p) = compile_commands {
        p.to_string_lossy().hash(&mut hasher);
    }
    compile_commands_mtime.hash(&mut hasher);
    config_mtime.hash(&mut hasher);
    hasher.finish()
}

fn cache_key_for_path(path: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    hasher.finish()
}

fn cache_file_name(key: u64, mtime: u64, size: u64, settings_hash: u64) -> String {
    format!("{:016x}-{}-{}-{:016x}.json", key, mtime, size, settings_hash)
}

fn resolve_cache_dir(settings: &Settings, root_dir: Option<&Path>, compile_dir: Option<&Path>) -> Option<PathBuf> {
    if !settings.daemonCacheOnDisk {
        return None;
    }

    let trimmed = settings.daemonCacheDir.trim();
    let mut base = if !trimmed.is_empty() {
        PathBuf::from(trimmed)
    } else if let Some(root) = root_dir {
        root.join(".vscode").join("clang-tidy-daemon-cache")
    } else if let Some(dir) = compile_dir {
        dir.join(".vscode").join("clang-tidy-daemon-cache")
    } else {
        return None;
    };

    if base.is_relative() {
        if let Some(root) = root_dir {
            base = root.join(base);
        } else if let Some(dir) = compile_dir {
            base = dir.join(base);
        }
    }

    if std::fs::create_dir_all(&base).is_err() {
        return None;
    }

    Some(base)
}

fn read_disk_cache(
    cache_dir: &Path,
    file_path: &Path,
    mtime: u64,
    size: u64,
    settings_hash: u64,
) -> Option<Vec<RpcDiagnostic>> {
    let key = cache_key_for_path(file_path);
    let filename = cache_file_name(key, mtime, size, settings_hash);
    let full_path = cache_dir.join(filename);
    let data = std::fs::read(full_path).ok()?;
    let entry: DiskCacheEntry = serde_json::from_slice(&data).ok()?;
    if entry.version != DISK_CACHE_VERSION {
        return None;
    }
    if entry.filePath != file_path.to_string_lossy() {
        return None;
    }
    if entry.mtime != mtime || entry.size != size || entry.settingsHash != settings_hash {
        return None;
    }
    Some(entry.diagnostics)
}

fn write_disk_cache(
    cache_dir: &Path,
    file_path: &Path,
    mtime: u64,
    size: u64,
    settings_hash: u64,
    diagnostics: &[RpcDiagnostic],
) -> Result<()> {
    let key = cache_key_for_path(file_path);
    let filename = cache_file_name(key, mtime, size, settings_hash);
    let full_path = cache_dir.join(&filename);

    let entry = DiskCacheEntry {
        version: DISK_CACHE_VERSION,
        filePath: file_path.to_string_lossy().to_string(),
        mtime,
        size,
        settingsHash: settings_hash,
        diagnostics: diagnostics.to_vec(),
    };
    let data = serde_json::to_vec(&entry)?;

    let mut tmp = NamedTempFile::new_in(cache_dir)?;
    tmp.write_all(&data)?;
    tmp.flush()?;
    tmp.persist(&full_path).map_err(|err| err.error)?;

    if let Ok(entries) = std::fs::read_dir(cache_dir) {
        let prefix = format!("{:016x}-", key);
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == filename {
                continue;
            }
            if name.starts_with(&prefix) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    Ok(())
}

fn is_cached(
    file_path: &Path,
    cache: &Arc<Mutex<HashMap<PathBuf, CacheEntry>>>,
    settings_hash: u64,
    cache_dir: Option<&Path>,
) -> bool {
    let sig = file_signature(file_path);
    if let Some((mtime, size)) = sig {
        if let Some(entry) = cache.lock().unwrap().get(file_path) {
            return entry.mtime == mtime && entry.size == size && entry.settings_hash == settings_hash;
        }
        if let Some(dir) = cache_dir {
            let key = cache_key_for_path(file_path);
            let filename = cache_file_name(key, mtime, size, settings_hash);
            return dir.join(filename).exists();
        }
    }
    false
}

fn paths_match(a: &Path, b: &Path) -> bool {
    let ca = std::fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let cb = std::fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

fn uri_to_path(uri: &str) -> Option<PathBuf> {
    Url::parse(uri).ok().and_then(|u| u.to_file_path().ok())
}

fn resolve_compile_commands_path(settings: &Settings, root_dir: Option<&Path>, state: &AppState) -> Option<PathBuf> {
    if !settings.compileCommandsPath.trim().is_empty() {
        let p = PathBuf::from(settings.compileCommandsPath.trim());
        if p.is_dir() {
            return Some(p.join("compile_commands.json"));
        }
        return Some(p);
    }

    if let Some(cached) = state.compile_commands.lock().unwrap().clone() {
        if cached.exists() {
            return Some(cached);
        }
    }

    let root = root_dir?;
    let found = find_compile_commands(root);
    if let Some(ref path) = found {
        *state.compile_commands.lock().unwrap() = Some(path.clone());
    }
    found
}

fn find_compile_commands(root: &Path) -> Option<PathBuf> {
    for entry in WalkDir::new(root).max_depth(4).follow_links(false) {
        if let Ok(ent) = entry {
            if ent.file_name() == "compile_commands.json" {
                return Some(ent.path().to_path_buf());
            }
        }
    }
    None
}

fn load_project_files(compile_commands: &Path) -> Result<Vec<PathBuf>> {
    let content = std::fs::read_to_string(compile_commands).context("Failed to read compile_commands.json")?;
    let entries: Vec<CompileCommand> = serde_json::from_str(&content).context("Invalid compile_commands.json")?;

    let mut files = HashSet::new();
    for entry in entries {
        let file_path = PathBuf::from(entry.file);
        let full = if file_path.is_absolute() {
            file_path
        } else {
            PathBuf::from(entry.directory).join(file_path)
        };
        files.insert(full);
    }

    Ok(files.into_iter().collect())
}

fn get_compile_index(path: &Path, state: &AppState) -> Result<Arc<CompileCommandsIndex>> {
    let mtime = mtime_for_path(path).unwrap_or(0);
    if let Some(existing) = state.compile_index.lock().unwrap().as_ref() {
        if existing.path == path && existing.mtime == mtime {
            return Ok(existing.clone());
        }
    }

    let content = std::fs::read_to_string(path).context("Failed to read compile_commands.json")?;
    let entries: Vec<CompileCommand> = serde_json::from_str(&content).context("Invalid compile_commands.json")?;
    let mut files = Vec::new();
    let mut file_set = HashSet::new();
    let mut commands: HashMap<PathBuf, CompileCommandEntry> = HashMap::new();

    for entry in entries {
        let file_path = PathBuf::from(&entry.file);
        let full = if file_path.is_absolute() {
            file_path
        } else {
            PathBuf::from(&entry.directory).join(file_path)
        };
        let canonical = std::fs::canonicalize(&full).unwrap_or(full);
        file_set.insert(canonical.clone());
        files.push(canonical.clone());
        commands.entry(canonical.clone()).or_insert(CompileCommandEntry {
            file: entry.file,
            directory: entry.directory,
            command: entry.command,
            arguments: entry.arguments,
        });
    }

    let index = Arc::new(CompileCommandsIndex {
        path: path.to_path_buf(),
        mtime,
        files,
        file_set,
        commands,
    });

    *state.compile_index.lock().unwrap() = Some(index.clone());
    Ok(index)
}

fn file_in_index(file_path: &Path, index: &CompileCommandsIndex) -> bool {
    let candidate = std::fs::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
    index.file_set.contains(&candidate)
}

fn find_compile_entry(index: &CompileCommandsIndex, file_path: &Path) -> Option<CompileCommandEntry> {
    let candidate = std::fs::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
    index.commands.get(&candidate).cloned()
}

fn write_json<T: Serialize>(stdout: &Arc<Mutex<io::Stdout>>, value: &T) -> Result<()> {
    let mut out = stdout.lock().unwrap();
    writeln!(out, "{}", serde_json::to_string(value)?)?;
    out.flush()?;
    Ok(())
}

fn send_notification<T: Serialize>(stdout: &Arc<Mutex<io::Stdout>>, method: &'static str, params: T) -> Result<()> {
    let note = Notification { jsonrpc: "2.0", method, params };
    write_json(stdout, &note)
}
