# vsx-tidy

`vsx-tidy` is a VS Code extension project for running `clang-tidy` with a Rust daemon backend.

## Repository Structure

- `extension/` - VS Code extension (TypeScript).
- `daemon/` - analysis daemon (Rust).
- `scripts/` - helper scripts to build and package components.
- `smoke/` - sample C/C++ project for smoke testing.

## Requirements

- Node.js and npm (for the extension build).
- Rust toolchain (`cargo`) (for the daemon build).
- `clang-tidy` installed on your system.

## Build

### 1) Build the daemon binary

From repository root:

```bash
scripts/build-daemon.sh
```

This builds the Rust daemon and copies a platform-specific binary into `extension/bin/`.

### 2) Build the extension

From repository root:

```bash
scripts/build-extension.sh
```

This installs npm dependencies in `extension/` and compiles TypeScript into `extension/dist/`.

## Package Extension (.vsix)

From repository root:

```bash
scripts/package-extension.sh
```

The script builds the extension and creates a `.vsix` package inside `extension/`.

## Install the Extension

### Option A: Install from `.vsix` (recommended)

1. Open VS Code.
2. Open Extensions view.
3. Click the `...` menu in the top-right corner.
4. Select **Install from VSIX...**.
5. Choose the generated `.vsix` file from `extension/`.

### Option B: Run in Extension Development Host

1. Open the repository in VS Code.
2. Open `extension/` as your active extension project.
3. Press `F5` to launch an Extension Development Host window.

## Notes

- Project-level analysis requires a valid `compile_commands.json`.
- If needed, configure `clangTidy.daemonPath` to a custom daemon binary path.
