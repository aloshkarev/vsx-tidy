#include "util.h"
#include <sstream>

std::string make_message(const std::string& name) {
  std::stringstream ss;
  ss << "Hello, " << name << "!";
  return ss.str();
}

int add(int a, int b) {
  return a + b;
}
