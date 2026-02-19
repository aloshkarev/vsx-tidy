# Daemon binaries

Place platform-specific daemon binaries in this folder with the following names:

- clang-tidy-daemon-darwin-x64
- clang-tidy-daemon-darwin-arm64
- clang-tidy-daemon-linux-x64

The extension auto-selects the binary based on `process.platform` and `process.arch`.
You can override by setting `clangTidy.daemonPath` in settings.

To build a binary for the current platform, run:
- `scripts/build-daemon.sh`

For Linux x64 from macOS via Docker, run:
- `scripts/build-daemon-docker.sh`

For other platforms, build on the target OS and copy the resulting binary here.
