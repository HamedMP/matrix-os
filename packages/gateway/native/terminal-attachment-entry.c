#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#if !defined(__linux__) || (!defined(__x86_64__) && !defined(__aarch64__))
#error "Terminal attachment entry requires Linux x64 or arm64"
#endif

/* Public location only: no source, stop, configuration or process authority. */
static int valid_location(const char *path) {
  size_t length = strnlen(path, 104);
  static const char prefix[] = "/matrix-terminal-";
  static const char suffix[] = "/io.sock";
  const size_t tail = sizeof(prefix) - 1 + 32 + sizeof(suffix) - 1;
  if (length >= 104 || length < tail || path[0] != '/') return 0;
  for (size_t i = 0; i < length; i++) {
    unsigned char value = (unsigned char)path[i];
    if (value <= 0x20 || value == 0x7f || value == '?' || value == '#') return 0;
    if (path[i] == '/') {
      if (path[i + 1] == '/') return 0;
      if (path[i + 1] == '.' && (path[i + 2] == '/' || path[i + 2] == '\0')) return 0;
      if (path[i + 1] == '.' && path[i + 2] == '.' &&
          (path[i + 3] == '/' || path[i + 3] == '\0')) return 0;
    }
  }
  const char *at = path + length - tail;
  if (memcmp(at, prefix, sizeof(prefix) - 1) != 0) return 0;
  at += sizeof(prefix) - 1;
  for (size_t i = 0; i < 32; i++)
    if (!((at[i] >= '0' && at[i] <= '9') || (at[i] >= 'a' && at[i] <= 'f'))) return 0;
  return memcmp(at + 32, suffix, sizeof(suffix) - 1) == 0;
}

static int sibling(char *output, const char *directory, size_t length, const char *name, int mode) {
  size_t name_length = strlen(name);
  if (length + name_length + 1 > PATH_MAX) return 0;
  memcpy(output, directory, length);
  memcpy(output + length, name, name_length + 1);
  struct stat info;
  return lstat(output, &info) == 0 && S_ISREG(info.st_mode) && access(output, mode) == 0;
}

/* No RLIMIT sweep. The single-threaded entry opens only this inventory FD.
 * Readdir errors, inventory exhaustion or ambiguous closure all fail closed. */
static int close_inherited(void) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 3U, UINT_MAX, 0U) == 0) return 1;
#endif
  DIR *directory = opendir("/proc/self/fd");
  if (directory == NULL) return 0;
  int own_fd = dirfd(directory), ok = own_fd >= 0;
  unsigned int count = 0;
  while (ok) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (entry == NULL) { if (errno != 0) ok = 0; break; }
    if (++count > 65536) { ok = 0; break; }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    unsigned int fd = 0;
    for (const unsigned char *at = (const unsigned char *)entry->d_name; *at; at++) {
      if (*at < '0' || *at > '9' || fd > ((unsigned int)INT_MAX - (*at - '0')) / 10) {
        ok = 0; break;
      }
      fd = fd * 10 + (*at - '0');
    }
    if (!ok) break;
    if (fd >= 3 && (int)fd != own_fd && close((int)fd) != 0 && errno != EBADF) ok = 0;
  }
  if (closedir(directory) != 0) ok = 0;
  return ok;
}

static int unavailable(void) {
  static const char message[] = "Terminal I/O unavailable\n";
  (void)write(STDERR_FILENO, message, sizeof(message) - 1);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 2 || !valid_location(argv[1])) return unavailable();
  char executable[PATH_MAX + 1], node[PATH_MAX + 1], module[PATH_MAX + 1];
  ssize_t length = readlink("/proc/self/exe", executable, PATH_MAX);
  if (length <= 0 || length >= PATH_MAX || executable[0] != '/') return unavailable();
  executable[length] = '\0';
  static const char deleted[] = " (deleted)";
  if ((size_t)length >= sizeof(deleted) - 1 &&
      strcmp(executable + length - (sizeof(deleted) - 1), deleted) == 0) return unavailable();
  char *separator = strrchr(executable, '/');
  if (separator == NULL || separator[1] == '\0') return unavailable();
  size_t directory_length = (size_t)(separator - executable) + 1;
  if (!sibling(node, executable, directory_length, "node", R_OK | X_OK) ||
      !sibling(module, executable, directory_length, "terminal-io-attach.mjs", R_OK) ||
      !close_inherited()) return unavailable();
  char *const arguments[] = {node, module, argv[1], NULL};
  char *const environment[] = {"PATH=/usr/bin:/bin", "LANG=C.UTF-8", NULL};
  execve(node, arguments, environment);
  return unavailable();
}
