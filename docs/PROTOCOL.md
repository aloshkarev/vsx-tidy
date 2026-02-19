# clang-tidy VS Code Extension Protocol (v0)

This protocol defines communication between the VS Code extension (client) and the Rust daemon (server).

## Transport
- JSON-RPC 2.0
- UTF-8
- One JSON message per line (NDJSON). Each message MUST be a single line with no embedded newlines.

## Message Envelope
All messages follow JSON-RPC 2.0:

```
{
  "jsonrpc": "2.0",
  "id": 1,                 // request/response only
  "method": "initialize", // requests/notifications only
  "params": { ... }
}
```

## Requests

### initialize
Client -> Server

Params:
```
{
  "rootUri": "file:///path/to/workspace",
  "client": {"name": "clang-tidy-vscode", "version": "0.1.0"},
  "capabilities": {
    "supportsProgress": true
  },
  "settings": {
    "clangTidyPath": "/usr/bin/clang-tidy",
    "compileCommandsPath": "/path/to/compile_commands.json",
    "extraArgs": ["--header-filter=.*"],
    "maxWorkers": 4,
    "quickChecks": "clang-diagnostic-*",
    "maxDiagnosticsPerFile": 1000,
    "maxFixesPerFile": 300,
    "daemonCacheOnDisk": true,
    "daemonCacheDir": "",
    "perFileTimeoutMs": 0,
    "publishDiagnosticsThrottleMs": 0
  }
}
```

Result:
```
{
  "server": {"name": "clang-tidy-daemon", "version": "0.1.0"},
  "capabilities": {
    "analyzeFile": true,
    "analyzeProject": true,
    "cancel": true
  },
  "pid": 12345
}
```

### shutdown
Client -> Server

Params: `{}`
Result: `{}`

### analyzeFile
Client -> Server

Params:
```
{
  "runId": "uuid-or-int",
  "fileUri": "file:///path/to/file.cpp",
  "mode": "full", // or "quick"
  "fileContent": "string (optional)"
}
```

Result:
```
{
  "runId": "uuid-or-int",
  "fileUri": "file:///path/to/file.cpp",
  "diagnostics": [
    {
      "range": {"start": {"line": 10, "character": 4}, "end": {"line": 10, "character": 12}},
      "severity": "warning",
      "code": "readability-identifier-naming",
      "message": "Variable name does not match style",
      "fixes": [
        {
          "title": "Rename to snake_case",
          "edits": [
            {"range": {"start": {"line": 10, "character": 4}, "end": {"line": 10, "character": 12}}, "newText": "my_var"}
          ]
        }
      ]
    }
  ]
}
```

### analyzeProject
Client -> Server

Params:
```
{
  "runId": "uuid-or-int",
  "mode": "full", // or "quick"
  "files": ["file:///path/to/a.cpp", "file:///path/to/b.cpp"], // optional override
  "incremental": true, // optional (default true)
  "batchSize": 250 // optional, hint for server-side batching
}
```

Result:
```
{
  "runId": "uuid-or-int"
}
```

Diagnostics are streamed via `publishDiagnostics` notifications.

### cancel
Client -> Server

Params:
```
{"runId": "uuid-or-int"}
```

Result: `{}`

## Notifications

### publishDiagnostics
Server -> Client

Params:
```
{
  "runId": "uuid-or-int",
  "fileUri": "file:///path/to/file.cpp",
  "diagnostics": [ ... ]
}
```

### progress
Server -> Client

Params:
```
{
  "runId": "uuid-or-int",
  "kind": "begin" | "report" | "end",
  "message": "Analyzing...",
  "percent": 42 // 0..100 optional
}
```

### log
Server -> Client

Params:
```
{"level": "info" | "warn" | "error", "message": "..."}
```

### configChanged
Client -> Server

Params:
```
{
  "settings": {
    "clangTidyPath": "/usr/bin/clang-tidy",
    "compileCommandsPath": "/path/to/compile_commands.json",
    "extraArgs": [],
    "maxWorkers": 4,
    "quickChecks": "clang-diagnostic-*",
    "maxDiagnosticsPerFile": 1000,
    "maxFixesPerFile": 300,
    "daemonCacheOnDisk": true,
    "daemonCacheDir": "",
    "perFileTimeoutMs": 0,
    "publishDiagnosticsThrottleMs": 0
  }
}
```

## Types

### Diagnostic
- `range`: 0-based line/character positions
- `severity`: `info` | `warning` | `error`
- `code`: clang-tidy check name
- `message`: diagnostic message
- `fixes`: optional list of fixes

### Fix
- `title`: short description
- `edits`: list of text edits for the file

### TextEdit
- `range`: start/end positions
- `newText`: replacement text

## Notes
- Client should treat missing fields as optional and be forward-compatible.
- Server should be resilient to missing settings and use defaults.
- `analyzeProject` may send many `publishDiagnostics` messages; client should update per-file diagnostics.
### ping
Used by the client to verify daemon health.

Request:
```
{"jsonrpc":"2.0","id":1,"method":"ping","params":{"ts":123}}
```

Response:
```
{"jsonrpc":"2.0","id":1,"result":{"ok":true}}
```
