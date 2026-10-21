#define _GNU_SOURCE
#include <node_api.h>
#include <fcntl.h>
#include <stdint.h>
#include <errno.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <unistd.h>

/* No pathname lookup, open_by_handle_at, privileges, retained handles or writes.
 * Only ext4 with proven metadata_csum protection and tmpfs are qualified;
 * ordinary inode ownership is not trusted generation authority. Mount IDs are not
 * persistent identities. f_fsid is UUID-derived on ext4 and mount-lifetime on
 * tmpfs, whose objects themselves do not survive destroying that filesystem. */
static napi_value unavailable(napi_env env) {
  napi_throw_error(env, "MATRIX_FILESYSTEM_IDENTITY_UNAVAILABLE", "Filesystem generation identity unavailable");
  return NULL;
}
static void u32(unsigned char *to, uint32_t value) {
  to[0] = value >> 24; to[1] = value >> 16; to[2] = value >> 8; to[3] = value;
}
struct fsuuid_header { uint32_t length, flags; };
static int protected_ext4(int fd, const struct stat *st, unsigned char identity[16]) {
  /* Reviewed Linux 6.1+ ext4 API (GETFSUUID appeared in 6.1).
   * fs/ext4/ioctl.c: owner -> metadata_csum/ENOTTY -> mnt_want_write ->
   * get_user/EFAULT -> inode lock/journal/metadata writes. UINTPTR_MAX is
   * never a valid userspace int pointer, so this cannot reach a write even
   * on an unsupported, generation-mutable mount. No seccomp-synthesized
   * ENOTTY is accepted. EPERM/EROFS/EFAULT and unknown replies fail closed.
   * https://github.com/torvalds/linux/blob/v6.8/fs/ext4/ioctl.c#L1170-L1203 */
  if (st->st_uid != geteuid() || prctl(PR_GET_SECCOMP, 0L, 0L, 0L, 0L) != 0) return 0;
  struct { struct fsuuid_header header; unsigned char uuid[16]; } query = {{16, 0}, {0}};
  if (ioctl(fd, _IOR('f', 44, struct fsuuid_header), &query) != 0
      || query.header.length != 16 || query.header.flags != 0) return 0;
  unsigned char zero[16] = {0};
  if (memcmp(query.uuid, zero, sizeof(zero)) == 0) return 0;
  errno = 0;
  if (ioctl(fd, _IOW('f', 4, long), (void *)UINTPTR_MAX) != -1 || errno != ENOTTY) return 0;
  memcpy(identity, query.uuid, 16);
  return 1;
}
static napi_value read_identity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  double number;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1
      || napi_get_value_double(env, argv[0], &number) != napi_ok
      || !(number >= 0 && number <= INT32_MAX) || number != (int32_t)number) return unavailable(env);
  int fd = (int)number;
  struct stat st;
  struct statfs fs;
  if (fstat(fd, &st) != 0 || (!S_ISREG(st.st_mode) && !S_ISDIR(st.st_mode))
      || fstatfs(fd, &fs) != 0 || (fs.f_type != 0xef53 && fs.f_type != 0x01021994)) return unavailable(env);
  unsigned char identity[16] = {0};
  if (fs.f_type == 0xef53) {
    if (!protected_ext4(fd, &st, identity)) return unavailable(env);
  } else {
    uint32_t fsid[2];
    if (sizeof(fs.f_fsid) != sizeof(fsid)) return unavailable(env);
    memcpy(fsid, &fs.f_fsid, sizeof(fsid));
    if (fsid[0] == 0 && fsid[1] == 0) return unavailable(env);
    u32(identity, fsid[0]); u32(identity + 4, fsid[1]);
  }
  union { struct file_handle align; unsigned char bytes[sizeof(struct file_handle) + 128]; } storage;
  memset(&storage, 0, sizeof(storage));
  struct file_handle *handle = (struct file_handle *)storage.bytes;
  handle->handle_bytes = 128;
  int mount_id;
  if (name_to_handle_at(fd, "", handle, &mount_id, AT_EMPTY_PATH) != 0
      || handle->handle_bytes == 0 || handle->handle_bytes > 128 || handle->handle_type <= 0) return unavailable(env);
  unsigned char bytes[160] = {'M', 'F', 'I', '2'};
  u32(bytes + 4, (uint32_t)fs.f_type);
  memcpy(bytes + 8, identity, 16);
  u32(bytes + 24, (uint32_t)handle->handle_type);
  u32(bytes + 28, handle->handle_bytes);
  memcpy(bytes + 32, handle->f_handle, handle->handle_bytes);
  napi_value result;
  if (napi_create_buffer_copy(env, 32 + handle->handle_bytes, bytes, NULL, &result) != napi_ok) return unavailable(env);
  return result;
}
NAPI_MODULE_INIT() {
  napi_property_descriptor property = {"readIdentity", NULL, read_identity, NULL, NULL, NULL, napi_default, NULL};
  if (napi_define_properties(env, exports, 1, &property) != napi_ok) return unavailable(env);
  return exports;
}
