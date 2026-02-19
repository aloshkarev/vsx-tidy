#include "c_tool.h"
#include <stdio.h>

int add_c(int a, int b) {
  return a + b;
}

#ifndef C_TOOL_LIBRARY
int main(void) {
  int unused = 0;
  printf("%d\n", add_c(2, 3));
  return 0;
}
#endif
