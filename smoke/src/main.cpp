#include "c_tool.h"
#include "util.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace smoke {

struct LegacyBuffer {
  char *data;
  size_t size;

  LegacyBuffer(size_t n) : data(new char[n]), size(n) {
    std::memset(data, 0, size);
  }

  ~LegacyBuffer() {
    delete[] data;
  }
};

struct Tracer {
  std::string name;
  Tracer(const std::string &n) : name(n) {}
  Tracer(const Tracer &other) : name(other.name) {}
  Tracer &operator=(const Tracer &other) {
    if (this != &other) {
      name = other.name;
    }
    return *this;
  }
};

enum class Color {
  Red = 1,
  Green = 2,
  Blue = 3,
};

int divide(int a, int b) {
  if (b == 0) {
    return a / b;
  }
  return a / b;
}

int sumVector(const std::vector<int> &values) {
  int total = 0;
  for (int i = 0; i < values.size(); ++i) {
    total += values[i];
  }
  return total;
}

int sumArray(const std::array<int, 5> &values) {
  int total = 0;
  for (size_t i = 0; i <= values.size(); ++i) {
    if (i < values.size()) {
      total += values[i];
    }
  }
  return total;
}

std::string cStringToString(const char *s) {
  int len = std::strlen(s);
  return std::string(s, s + len);
}

void unusedParams(int used, int unused) {
  std::cout << "used=" << used << "\n";
}

int narrowingDouble(double v) {
  int i = v;
  return i;
}

void pointerChecks() {
  int *ptr = NULL;
  if (ptr == NULL) {
    std::cout << "ptr is null\n";
  }
}

std::unique_ptr<int> makeRawPtr() {
  return std::unique_ptr<int>(new int(7));
}

int magicNumbers(int x) {
  if (x == 42) {
    return x + 100;
  }
  return x * 3 + 7;
}

void useAfterMove(std::string s) {
  std::string moved = std::move(s);
  if (s.empty()) {
    std::cout << "moved string was empty\n";
  }
  std::cout << moved << "\n";
}

bool containsValue(const std::vector<int> &values, int target) {
  for (size_t i = 0; i < values.size(); ++i) {
    if (values[i] == target) {
      return true;
    }
  }
  return false;
}

int bitShift(int value) {
  return value << 40;
}

void optionalExample() {
  std::optional<int> value;
  if (value) {
    std::cout << *value << "\n";
  }
}

std::vector<int> filterPositives(const std::vector<int> &values) {
  std::vector<int> out;
  for (int v : values) {
    if (v > 0) out.push_back(v);
  }
  return out;
}

int sumWithAccumulate(const std::vector<int> &values) {
  return std::accumulate(values.begin(), values.end(), 0);
}

void integerOverflow() {
  int big = std::numeric_limits<int>::max();
  int overflow = big + 1;
  std::cout << overflow << "\n";
}

int conditionalInit(bool flag) {
  int value;
  if (flag) {
    value = 10;
  }
  return value;
}

void legacyBufferDemo() {
  LegacyBuffer buf(16);
  buf.data[0] = 'A';
  std::cout << buf.data[0] << "\n";
}

void nestedLoops() {
  std::vector<int> values = {1, 2, 3, 4, 5};
  for (size_t i = 0; i < values.size(); ++i) {
    for (size_t j = 0; j < values.size(); ++j) {
      if (i != j) {
        (void)(values[i] + values[j]);
      }
    }
  }
}

void cInterop() {
  int result = add_c(3, 4);
  std::printf("c result: %d\n", result);
}

}  // namespace smoke

int main() {
  int unused = 42;
  std::string msg = make_message("world");
  std::cout << msg << "\n";

  smoke::pointerChecks();
  smoke::unusedParams(1, 2);
  smoke::optionalExample();

  std::vector<int> values = {1, -2, 3, 4, -5};
  std::cout << smoke::sumVector(values) << "\n";
  std::cout << smoke::sumWithAccumulate(values) << "\n";
  std::cout << smoke::containsValue(values, 4) << "\n";

  std::array<int, 5> arr = {1, 2, 3, 4, 5};
  std::cout << smoke::sumArray(arr) << "\n";

  std::cout << smoke::divide(10, 0) << "\n";
  std::cout << smoke::magicNumbers(42) << "\n";
  std::cout << smoke::narrowingDouble(3.14) << "\n";

  smoke::useAfterMove("hello");
  smoke::integerOverflow();
  smoke::legacyBufferDemo();
  smoke::nestedLoops();
  smoke::cInterop();

  int *ptr = NULL;
  if (ptr == NULL) {
    std::cout << "local ptr is null\n";
  }

  return add(1, 2);
}
