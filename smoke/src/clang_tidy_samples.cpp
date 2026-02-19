#include <array>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace smoke::tidy_samples {

// performance-for-range-copy
void performanceForRangeCopy(const std::vector<std::string> &values) {
  for (auto value : values) {
    (void)value.size();
  }
}

// performance-unnecessary-value-param
int performanceValueParam(std::vector<int> values) {
  int total = 0;
  for (int v : values) {
    total += v;
  }
  return total;
}

// readability-else-after-return
int readabilityElseAfterReturn(bool flag) {
  if (flag) {
    return 1;
  } else {
    return 2;
  }
}

// readability-simplify-boolean-expr
bool readabilitySimplifyBoolean(int value) {
  return value == 0 ? true : false;
}

// bugprone-branch-clone
int bugproneBranchClone(bool flag, int value) {
  if (flag) {
    return value + 1;
  }
  return value + 1;
}

// bugprone-use-after-move
void bugproneUseAfterMove(std::string input) {
  std::string moved = std::move(input);
  if (input.empty()) {
    std::printf("moved was empty\n");
  }
  std::printf("%s\n", moved.c_str());
}

// modernize-make-unique
std::unique_ptr<int> modernizeMakeUnique() {
  return std::unique_ptr<int>(new int(42));
}

// modernize-use-nullptr
void modernizeUseNullPtr() {
  int *ptr = NULL;
  if (ptr == NULL) {
    std::printf("null\n");
  }
}

// cert-msc50-cpp (rand)
int securityCertRand() {
  return std::rand();
}

// security.insecureAPI.strcpy
void securityInsecureStrcpy(const char *source) {
  char buffer[8];
  std::strcpy(buffer, source);
  std::printf("%s\n", buffer);
}

// cppcoreguidelines-avoid-c-arrays / hicpp-avoid-c-arrays
int cppcoreguidelinesCArrays() {
  int values[3] = {1, 2, 3};
  int *ptr = values;
  return ptr[0];
}

// misc-unused-parameters
int miscUnusedParams(int used, int unused) {
  return used;
}

// clang-analyzer-core.NullDereference
int analyzerNullDeref(int *ptr) {
  if (!ptr) {
    return *ptr;
  }
  return 0;
}

// clang-diagnostic-unused-variable
void clangDiagnosticUnusedVar() {
  int unused = 7;
}

}  // namespace smoke::tidy_samples
