# Smoke Test Checklist

## Preconditions
- clang-tidy installed and on PATH or configured in settings.
- compile_commands.json available (CMake/Meson) and path configured if not at root.

## Steps
1. Use the bundled smoke project: `/Users/alex/Documents/New project/smoke`.
2. Generate compile commands: `cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`
3. If clang-tidy is from Homebrew on macOS, reconfigure with:
4. `CMAKE_CXX_COMPILER=/opt/homebrew/opt/llvm/bin/clang++ CMAKE_C_COMPILER=/opt/homebrew/opt/llvm/bin/clang cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`
5. Open the `smoke` folder in Cursor/VS Code.
6. Set `clangTidy.compileCommandsPath` to `smoke/build/compile_commands.json` if it is not auto-detected.
7. Open `src/main.cpp` and run `Run Clang-Tidy (Quick)`.
8. Confirm diagnostics appear and quick fixes are offered (e.g. `modernize-use-nullptr`).
9. Run `Run Clang-Tidy on Project (Quick)` and observe progress + status bar.
10. Stop analysis with `Clang-Tidy: Stop Analysis` and confirm status bar returns to idle.
11. Trigger on-save and confirm quick analysis runs.
12. Run `Clang-Tidy: Open compile_commands.json location` and confirm OS reveals file.

## Expected
- Status bar shows analyzing/idle correctly.
- Warnings appear if compile_commands.json is missing or file not in compilation.
