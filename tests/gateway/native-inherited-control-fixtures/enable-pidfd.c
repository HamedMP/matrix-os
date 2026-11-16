/* Fixed test-only option setter. No descriptor/PID/identity input or payload. */
#define _GNU_SOURCE
#include <sys/socket.h>
int main(void) {
  int enabled = 1, observed = 0; socklen_t size = sizeof(observed);
  if (setsockopt(0, SOL_SOCKET, 76, &enabled, sizeof(enabled)) != 0
      || getsockopt(0, SOL_SOCKET, 76, &observed, &size) != 0
      || size != sizeof(observed) || observed != 1) return 78;
  return 0;
}
