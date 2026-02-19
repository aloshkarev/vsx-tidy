cmake_minimum_required(VERSION 3.15)
project(clang_tidy_smoke LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(APPLE)
  execute_process(
    COMMAND xcrun --show-sdk-path
    OUTPUT_VARIABLE SDK_PATH
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
  )
  if(SDK_PATH)
    add_compile_options("-isysroot" "${SDK_PATH}")
  endif()
endif()

add_library(smoke_util src/util.cpp src/util.h)
target_include_directories(smoke_util PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)

add_library(c_tool_lib src/c_tool.c)
target_include_directories(c_tool_lib PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_compile_definitions(c_tool_lib PRIVATE C_TOOL_LIBRARY)

add_executable(smoke_app src/main.cpp src/clang_tidy_samples.cpp)
target_link_libraries(smoke_app PRIVATE smoke_util c_tool_lib)
target_compile_options(smoke_app PRIVATE -Wall -Wextra -Wpedantic)

add_executable(c_tool src/c_tool.c)
target_include_directories(c_tool PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_compile_options(c_tool PRIVATE -Wall -Wextra -Wpedantic)
