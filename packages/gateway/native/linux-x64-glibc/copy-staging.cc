#define _GNU_SOURCE

#include "copy-staging.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <array>

namespace matrix_fs {
namespace {

constexpr size_t kStageRandomBytes = 16;
constexpr size_t kMaxStageClaims = 16;

bool FillRandom(std::array<unsigned char, kStageRandomBytes>* bytes) {
  size_t offset = 0;
  while (offset < bytes->size()) {
    const ssize_t count = getrandom(bytes->data() + offset, bytes->size() - offset, 0);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      if (count == 0) errno = EIO;
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  return true;
}

int OpenStagingDirectory(int parent, const char* name) {
  struct open_how how = {};
  how.flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC;
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV;
  return static_cast<int>(syscall(SYS_openat2, parent, name, &how, sizeof(how)));
}

bool SameDirectory(const struct stat& left, const struct stat& right) {
  return left.st_dev == right.st_dev
    && left.st_ino == right.st_ino
    && S_ISDIR(left.st_mode)
    && S_ISDIR(right.st_mode);
}

}  // namespace

StagingDirectoryClaim CreateStagingDirectory(int parent) {
  static constexpr char kHex[] = "0123456789abcdef";
  for (size_t attempt = 0; attempt < kMaxStageClaims; ++attempt) {
    std::array<unsigned char, kStageRandomBytes> random = {};
    if (!FillRandom(&random)) return {};
    std::string candidate = ".matrix-copy-stage-";
    candidate.reserve(candidate.size() + random.size() * 2);
    for (const unsigned char value : random) {
      candidate.push_back(kHex[value >> 4]);
      candidate.push_back(kHex[value & 0x0f]);
    }
    if (mkdirat(parent, candidate.c_str(), 0700) != 0) {
      if (errno == EEXIST) continue;
      return {};
    }
    struct stat claimed = {};
    if (fstatat(parent, candidate.c_str(), &claimed, AT_SYMLINK_NOFOLLOW) != 0) {
      return {-1, candidate};
    }
    const int opened = OpenStagingDirectory(parent, candidate.c_str());
    if (opened < 0) return {-1, candidate};
    struct stat opened_stat = {};
    if (fstat(opened, &opened_stat) != 0) {
      const int error = errno;
      close(opened);
      errno = error;
      return {-1, candidate};
    }
    if (!SameDirectory(claimed, opened_stat)) {
      close(opened);
      errno = ESTALE;
      return {-1, candidate};
    }
    return {opened, candidate};
  }
  errno = EEXIST;
  return {};
}

}  // namespace matrix_fs
