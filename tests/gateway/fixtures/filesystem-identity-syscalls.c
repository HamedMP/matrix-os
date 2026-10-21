#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <sys/types.h>
#include <sys/ioctl.h>
static int scenario(const char *value) { const char *current = getenv("MATRIX_IDENTITY_TEST_CASE"); return current && strcmp(current, value) == 0; }
int mock_fstat(int fd, struct stat *s) { (void)fd; memset(s, 0, sizeof(*s)); s->st_mode = S_IFREG | 0600; s->st_uid = scenario("foreign_owner") || scenario("tmpfs") ? 1002 : 1001; return 0; }
int mock_fstatfs(int fd, struct statfs *s) { (void)fd; memset(s, 0, sizeof(*s)); s->f_type = scenario("tmpfs") ? 0x01021994 : 0xef53; memset(&s->f_fsid, 1, sizeof(s->f_fsid)); return 0; }
uid_t mock_geteuid(void) { return 1001; }
int mock_prctl(int option, ...) { (void)option; return scenario("seccomp") || scenario("tmpfs") ? 2 : 0; }
int mock_ioctl(int fd, unsigned long request, ...) {
  (void)fd; va_list args; va_start(args, request); void *pointer = va_arg(args, void *); va_end(args);
  if (scenario("tmpfs")) abort();
  if (request == _IOR('f', 44, uint64_t)) {
    if (scenario("uuid_missing")) { errno = ENOTTY; return -1; }
    uint32_t *header = pointer;
    header[0] = scenario("uuid_bad_length") ? 15 : 16;
    header[1] = scenario("uuid_bad_flags") ? 1 : 0;
    memset((unsigned char *)pointer + 8, scenario("uuid_zero") ? 0 : 1, 16); return 0;
  }
  if (request != _IOW('f', 4, long) || pointer != (void *)UINTPTR_MAX) abort();
  if (scenario("unexpected_success")) return 0;
  errno = scenario("mutable_generation") ? EFAULT : scenario("not_permitted") ? EPERM : scenario("read_only") ? EROFS : ENOTTY;
  return -1;
}
int mock_name_to_handle_at(int fd, const char *path, struct file_handle *h, int *mount_id, int flags) {
  (void)fd; if (*path || flags != AT_EMPTY_PATH) abort();
  *mount_id = 1; h->handle_type = 1; h->handle_bytes = scenario("tmpfs") ? 12 : 8; memset(h->f_handle, 1, h->handle_bytes); return 0;
}
