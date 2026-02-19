# Clang-Tidy Smoke Project

This folder contains a small C and C++ project with intentional warnings to validate the extension.

## Build (CMake)
```
cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
cmake --build build
```

If you need a specific clang toolchain, set compilers explicitly:
```
CMAKE_CXX_COMPILER=/opt/homebrew/opt/llvm/bin/clang++ \
CMAKE_C_COMPILER=/opt/homebrew/opt/llvm/bin/clang \
cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

The generated `compile_commands.json` will be in `smoke/build`.

## What to Expect
- Unused variable warnings (C/C++).
- `modernize-use-nullptr` suggestion in `src/main.cpp`.
- clang-tidy category samples in `src/clang_tidy_samples.cpp`.
- `.clang-tidy` in this folder enables checks across major categories.

## Extension Settings
- Set `clangTidy.compileCommandsPath` to `smoke/build/compile_commands.json` if needed.
- Run `Run Clang-Tidy (Quick)` or `Run Clang-Tidy (Full)` on `src/main.cpp`.
- Run `Run Clang-Tidy (Full)` on `src/clang_tidy_samples.cpp` to see category coverage.
