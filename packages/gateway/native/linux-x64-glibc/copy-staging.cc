#define _GNU_SOURCE

#include "copy-staging.h"

#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <sys/random.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <ctime>
#include <string>

namespace matrix_fs {
namespace {

constexpr size_t kStageRandomBytes = 16;
constexpr size_t kMaxStageClaims = 16;
constexpr size_t kMaxRetainedStages = 64;
constexpr size_t kMaxSweepEntries = 10000;
constexpr size_t kMaxSweepDepth = 128;
constexpr time_t kStageTtlSeconds = 24 * 60 * 60;
constexpr char kStagePrefix[] = ".matrix-copy-stage-";

struct RetainedStage {
  std::string name;
  struct timespec modified = {};
};

class ScopedFd {
 public:
  explicit ScopedFd(int fd = -1) : fd_(fd) {}
  ~ScopedFd() { if (fd_ >= 0) close(fd_); }
  ScopedFd(const ScopedFd&) = delete;
  ScopedFd& operator=(const ScopedFd&) = delete;
  int get() const { return fd_; }
  explicit operator bool() const { return fd_ >= 0; }

 private:
  int fd_;
};

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

bool IsStageName(const char* name) {
  constexpr size_t prefix_length = sizeof(kStagePrefix) - 1;
  if (strncmp(name, kStagePrefix, prefix_length) != 0 || strlen(name) != prefix_length + 32) return false;
  return std::all_of(name + prefix_length, name + prefix_length + 32, [](unsigned char value) {
    return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
  });
}

bool ReplaceChildBeforeOpenForTest(int directory, const char* name) {
  constexpr char moved_name[] = ".matrix-sweep-original";
  if (renameat(directory, name, directory, moved_name) != 0
      || mkdirat(directory, name, 0700) != 0) return false;
  const int replacement = openat(
    directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (replacement < 0) return false;
  const int claimant = openat(
    replacement, "claimant.txt", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  const int open_error = errno;
  close(replacement);
  if (claimant < 0) { errno = open_error; return false; }
  const ssize_t written = write(claimant, "claimant", 8);
  const int write_error = errno;
  close(claimant);
  if (written != 8) { errno = written < 0 ? write_error : EIO; return false; }
  return true;
}

bool RemoveTreeContents(
  int directory,
  size_t depth,
  size_t* entries,
  StagingSweepTestScenario test_scenario,
  bool* test_scenario_fired) {
  if (depth > kMaxSweepDepth) { errno = E2BIG; return false; }
  const int iteration_fd = dup(directory);
  if (iteration_fd < 0) return false;
  DIR* iteration = fdopendir(iteration_fd);
  if (!iteration) {
    const int error = errno;
    close(iteration_fd);
    errno = error;
    return false;
  }
  errno = 0;
  while (dirent* entry = readdir(iteration)) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (++*entries > kMaxSweepEntries) {
      closedir(iteration);
      errno = E2BIG;
      return false;
    }
    struct stat child = {};
    if (fstatat(directory, entry->d_name, &child, AT_SYMLINK_NOFOLLOW) != 0) {
      const int error = errno;
      closedir(iteration);
      errno = error;
      return false;
    }
    if (S_ISDIR(child.st_mode)) {
      if (test_scenario == StagingSweepTestScenario::kReplaceChildBeforeOpen
          && !*test_scenario_fired) {
        *test_scenario_fired = true;
        if (!ReplaceChildBeforeOpenForTest(directory, entry->d_name)) {
          const int error = errno;
          closedir(iteration);
          errno = error;
          return false;
        }
      }
      ScopedFd child_fd(OpenStagingDirectory(directory, entry->d_name));
      struct stat opened = {};
      if (!child_fd) {
        const int error = errno;
        closedir(iteration);
        errno = error;
        return false;
      }
      if (fstat(child_fd.get(), &opened) != 0) {
        const int error = errno;
        closedir(iteration);
        errno = error;
        return false;
      }
      if (!SameDirectory(child, opened)) {
        closedir(iteration);
        errno = ESTALE;
        return false;
      }
      const bool removed = RemoveTreeContents(
        child_fd.get(), depth + 1, entries, test_scenario, test_scenario_fired);
      const int error = errno;
      struct stat current = {};
      const bool identity_matches = removed
        && fstatat(directory, entry->d_name, &current, AT_SYMLINK_NOFOLLOW) == 0
        && SameDirectory(opened, current);
      if (!identity_matches || unlinkat(directory, entry->d_name, AT_REMOVEDIR) != 0) {
        const int unlink_error = identity_matches ? errno : (removed ? ESTALE : error);
        closedir(iteration);
        errno = unlink_error;
        return false;
      }
    } else if (unlinkat(directory, entry->d_name, 0) != 0) {
      const int error = errno;
      closedir(iteration);
      errno = error;
      return false;
    }
    errno = 0;
  }
  const int error = errno;
  closedir(iteration);
  errno = error;
  return error == 0;
}

bool RemoveRetainedStage(
  int parent,
  const RetainedStage& stage,
  StagingSweepTestScenario test_scenario,
  bool* test_scenario_fired) {
  struct stat before = {};
  if (fstatat(parent, stage.name.c_str(), &before, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(before.st_mode)) return false;
  ScopedFd stage_fd(OpenStagingDirectory(parent, stage.name.c_str()));
  if (!stage_fd || flock(stage_fd.get(), LOCK_EX | LOCK_NB) != 0) return false;
  struct stat opened = {};
  if (fstat(stage_fd.get(), &opened) != 0 || !SameDirectory(before, opened)) {
    const int error = errno == 0 ? ESTALE : errno;
    errno = error;
    return false;
  }
  size_t entries = 0;
  const bool contents_removed = RemoveTreeContents(
    stage_fd.get(), 0, &entries, test_scenario, test_scenario_fired);
  const int removal_error = errno;
  struct stat current = {};
  const bool identity_matches = contents_removed
    && fstatat(parent, stage.name.c_str(), &current, AT_SYMLINK_NOFOLLOW) == 0
    && SameDirectory(opened, current);
  if (!identity_matches) {
    errno = contents_removed ? ESTALE : removal_error;
    return false;
  }
  return unlinkat(parent, stage.name.c_str(), AT_REMOVEDIR) == 0;
}

bool SweepRetainedStages(
  int parent,
  StagingSweepTestScenario test_scenario,
  bool* test_scenario_fired) {
  const int iteration_fd = OpenStagingDirectory(parent, ".");
  if (iteration_fd < 0) return false;
  DIR* iteration = fdopendir(iteration_fd);
  if (!iteration) {
    const int error = errno;
    close(iteration_fd);
    errno = error;
    return false;
  }
  const time_t now = time(nullptr);
  if (now == static_cast<time_t>(-1)) {
    closedir(iteration);
    errno = EIO;
    return false;
  }
  const time_t cutoff = now - kStageTtlSeconds;
  size_t scanned = 0;
  size_t remaining = 0;
  errno = 0;
  while (dirent* entry = readdir(iteration)) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (++scanned > kMaxSweepEntries) {
      closedir(iteration);
      errno = E2BIG;
      return false;
    }
    if (!IsStageName(entry->d_name)) continue;
    struct stat stats = {};
    if (fstatat(parent, entry->d_name, &stats, AT_SYMLINK_NOFOLLOW) != 0) {
      const int error = errno;
      closedir(iteration);
      errno = error;
      return false;
    }
    if (S_ISDIR(stats.st_mode)) {
      const RetainedStage stage{entry->d_name, stats.st_mtim};
      if (stage.modified.tv_sec > cutoff
          || !RemoveRetainedStage(parent, stage, test_scenario, test_scenario_fired)) {
        ++remaining;
      }
    }
    errno = 0;
  }
  const int read_error = errno;
  closedir(iteration);
  if (read_error != 0) { errno = read_error; return false; }

  // Recent stages may still belong to an active copy. Never delete them merely
  // to make room; reject the new claim until an expired stage can be swept.
  if (remaining >= kMaxRetainedStages) { errno = E2BIG; return false; }
  return true;
}

}  // namespace

StagingDirectoryClaim CreateStagingDirectory(int parent, StagingSweepTestScenario test_scenario) {
  ScopedFd locked_parent(OpenStagingDirectory(parent, "."));
  if (!locked_parent || flock(locked_parent.get(), LOCK_EX) != 0) return {};
  bool test_scenario_fired = false;
  if (!SweepRetainedStages(parent, test_scenario, &test_scenario_fired)) return {};
  static constexpr char kHex[] = "0123456789abcdef";
  for (size_t attempt = 0; attempt < kMaxStageClaims; ++attempt) {
    std::array<unsigned char, kStageRandomBytes> random = {};
    if (!FillRandom(&random)) return {};
    std::string candidate = kStagePrefix;
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
    if (flock(opened, LOCK_SH | LOCK_NB) != 0) {
      const int error = errno;
      close(opened);
      errno = error;
      return {-1, candidate};
    }
    return {opened, candidate};
  }
  errno = EEXIST;
  return {};
}

}  // namespace matrix_fs
