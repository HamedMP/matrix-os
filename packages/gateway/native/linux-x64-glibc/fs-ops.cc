#define _GNU_SOURCE

#include "fs-ops.h"
#include "copy-staging.h"
#include "copy-test-hooks.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

namespace matrix_fs {
namespace {
constexpr size_t kMaxEntries = 10000;
constexpr size_t kMaxDepth = 128;
constexpr size_t kMaxRelativePathBytes = 4096;

class Fd {
 public:
  explicit Fd(int value = -1) : value_(value) {}
  ~Fd() { if (value_ >= 0) close(value_); }
  Fd(const Fd&) = delete;
  Fd& operator=(const Fd&) = delete;
  Fd(Fd&& other) noexcept : value_(std::exchange(other.value_, -1)) {}
  Fd& operator=(Fd&& other) noexcept {
    if (this != &other) {
      if (value_ >= 0) close(value_);
      value_ = std::exchange(other.value_, -1);
    }
    return *this;
  }
  int get() const { return value_; }
  int release() { return std::exchange(value_, -1); }
  explicit operator bool() const { return value_ >= 0; }

 private:
  int value_;
};
struct PathParts {
  std::vector<std::string> components;
  bool valid = false;
};

PathParts SplitRelative(const std::string& path) {
  PathParts result;
  if (path.empty() || path.size() > kMaxRelativePathBytes || path.front() == '/' || path.back() == '/') return result;
  size_t start = 0;
  while (start < path.size()) {
    const size_t end = path.find('/', start);
    const std::string component = path.substr(start, end == std::string::npos ? end : end - start);
    if (component.empty() || component == "." || component == ".." || component.size() > 255) return result;
    if (std::any_of(component.begin(), component.end(), [](unsigned char value) { return value == 0 || value < 32 || value == 127; })) return result;
    result.components.push_back(component);
    if (end == std::string::npos) break;
    start = end + 1;
  }
  result.valid = !result.components.empty();
  return result;
}
bool IsSameOrDescendant(const PathParts& source, const PathParts& target) {
  if (source.components.size() > target.components.size()) return false;
  return std::equal(source.components.begin(), source.components.end(), target.components.begin());
}
int OpenAt2(int directory, const char* path, int flags, mode_t mode = 0) {
  struct open_how how = {};
  how.flags = static_cast<__u64>(flags);
  how.mode = static_cast<__u64>(mode);
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV;
  return static_cast<int>(syscall(SYS_openat2, directory, path, &how, sizeof(how)));
}

Fd OpenHome(const std::string& home) {
  if (home.empty() || home.front() != '/') {
    errno = EINVAL;
    return Fd();
  }
  return Fd(open(home.c_str(), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
}

bool SameIdentity(const struct stat& left, const struct stat& right);

Fd OpenParent(int home_fd, const PathParts& path, bool create_parents) {
  Fd current(dup(home_fd));
  if (!current) return Fd();
  for (size_t index = 0; index + 1 < path.components.size(); ++index) {
    const std::string& component = path.components[index];
    Fd next(OpenAt2(current.get(), component.c_str(), O_PATH | O_DIRECTORY | O_CLOEXEC));
    if (!next && errno == ENOENT && create_parents) {
      const bool created = mkdirat(current.get(), component.c_str(), 0777) == 0;
      if (!created && errno != EEXIST) return Fd();
      struct stat claimed = {};
      if (created && fstatat(current.get(), component.c_str(), &claimed, AT_SYMLINK_NOFOLLOW) != 0) return Fd();
      next = Fd(OpenAt2(current.get(), component.c_str(), O_PATH | O_DIRECTORY | O_CLOEXEC));
      struct stat opened = {};
      if (created && (!next || fstat(next.get(), &opened) != 0 || !SameIdentity(claimed, opened))) {
        errno = ESTALE;
        return Fd();
      }
    }
    if (!next) return Fd();
    current = std::move(next);
  }
  return current;
}
Code ErrorCode(int error, bool partial = false) {
  if (partial) return Code::kPartial;
  switch (error) {
    case EEXIST: return Code::kDestinationConflict;
    case ENOENT: return Code::kNotFound;
    case EINVAL:
    case ELOOP:
    case ENOTDIR:
    case EXDEV: return error == EXDEV ? Code::kCrossDevice : Code::kInvalidPath;
    case E2BIG:
    case EFBIG: return Code::kLimitExceeded;
    case ENOSYS: return Code::kUnsupported;
    default: return Code::kFailed;
  }
}
Result Failure(int error, bool partial = false, std::string partial_path = {}) {
  return {ErrorCode(error, partial), error, std::move(partial_path)};
}

bool SameIdentity(const struct stat& left, const struct stat& right) {
  return left.st_dev == right.st_dev && left.st_ino == right.st_ino && (left.st_mode & S_IFMT) == (right.st_mode & S_IFMT);
}
bool StableEntry(const struct stat& left, const struct stat& right) {
  return SameIdentity(left, right)
    && left.st_mode == right.st_mode
    && left.st_size == right.st_size
    && left.st_mtim.tv_sec == right.st_mtim.tv_sec
    && left.st_mtim.tv_nsec == right.st_mtim.tv_nsec
    && left.st_ctim.tv_sec == right.st_ctim.tv_sec
    && left.st_ctim.tv_nsec == right.st_ctim.tv_nsec;
}
int WriteAll(int fd, const char* bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    const ssize_t written = write(fd, bytes + offset, length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return -1;
    offset += static_cast<size_t>(written);
  }
  return 0;
}
int CopyBytes(int source, int target) {
  std::array<char, 65536> buffer;
  while (true) {
    const ssize_t count = read(source, buffer.data(), buffer.size());
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return -1;
    if (count == 0) return 0;
    if (WriteAll(target, buffer.data(), static_cast<size_t>(count)) != 0) return -1;
  }
}

struct CopyState {
  size_t entries = 0;
  bool target_claimed = false;
  bool test_scenario_fired = false;
  CopyTestScenario test_scenario = CopyTestScenario::kNone;
};
std::string ParentRelativePath(const PathParts& target, const std::string& name) {
  std::string result;
  for (size_t index = 0; index + 1 < target.components.size(); ++index) {
    if (!result.empty()) result.push_back('/');
    result.append(target.components[index]);
  }
  if (!result.empty()) result.push_back('/');
  result.append(name);
  return result;
}
int CopyEntry(int source_parent, const std::string& source_name, int target_parent, const std::string& target_name, size_t depth, CopyState* state);

int CopyDirectory(int source, int target, size_t depth, CopyState* state) {
  Fd iteration(OpenAt2(source, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  if (!iteration) return -1;
  const int iteration_fd = iteration.release();
  DIR* directory = fdopendir(iteration_fd);
  if (!directory) {
    close(iteration_fd);
    return -1;
  }
  errno = 0;
  while (dirent* entry = readdir(directory)) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (CopyEntry(source, entry->d_name, target, entry->d_name, depth + 1, state) != 0) {
      const int error = errno;
      closedir(directory);
      errno = error;
      return -1;
    }
    errno = 0;
  }
  const int error = errno;
  closedir(directory);
  errno = error;
  return error == 0 ? 0 : -1;
}

int CopyCapturedEntry(
  int identity,
  const struct stat& before,
  int source_parent,
  const std::string& source_name,
  int target_parent,
  const std::string& target_name,
  size_t depth,
  CopyState* state) {
  if (RunCopyEntryTestScenario(
        source_parent,
        source_name,
        depth,
        before,
        state->test_scenario,
        &state->test_scenario_fired) != 0) return -1;

  if (S_ISREG(before.st_mode)) {
    Fd source(OpenAt2(source_parent, source_name.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
    if (!source) return -1;
    struct stat opened = {};
    if (fstat(source.get(), &opened) != 0 || !StableEntry(before, opened)) { errno = ESTALE; return -1; }
    Fd target(openat(target_parent, target_name.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, opened.st_mode & 0777));
    if (!target) return -1;
    state->target_claimed = true;
    if (state->test_scenario == CopyTestScenario::kFailRegularAfterTargetClaim
        && !state->test_scenario_fired
        && depth == 0) {
      state->test_scenario_fired = true;
      errno = EIO;
      return -1;
    }
    if (CopyBytes(source.get(), target.get()) != 0 || fchmod(target.get(), opened.st_mode & 0777) != 0) return -1;
    struct stat after = {};
    if (fstat(source.get(), &after) != 0 || !StableEntry(opened, after)) { errno = ESTALE; return -1; }
    return 0;
  }

  if (S_ISDIR(before.st_mode)) {
    Fd source(OpenAt2(source_parent, source_name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC));
    if (!source) return -1;
    struct stat opened = {};
    if (fstat(source.get(), &opened) != 0 || !StableEntry(before, opened)) { errno = ESTALE; return -1; }
    if (mkdirat(target_parent, target_name.c_str(), opened.st_mode & 0777) != 0) return -1;
    state->target_claimed = true;
    struct stat claimed = {};
    if (fstatat(target_parent, target_name.c_str(), &claimed, AT_SYMLINK_NOFOLLOW) != 0) return -1;
    Fd target(OpenAt2(target_parent, target_name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC));
    if (!target) return -1;
    struct stat target_opened = {};
    if (fstat(target.get(), &target_opened) != 0 || !SameIdentity(claimed, target_opened)) { errno = ESTALE; return -1; }
    if (CopyDirectory(source.get(), target.get(), depth, state) != 0) return -1;
    if (fchmod(target.get(), opened.st_mode & 0777) != 0) return -1;
    struct stat after = {};
    if (fstat(source.get(), &after) != 0 || !StableEntry(opened, after)) { errno = ESTALE; return -1; }
    return 0;
  }

  if (S_ISLNK(before.st_mode)) {
    std::array<char, kMaxRelativePathBytes + 1> link_target;
    const ssize_t length = readlinkat(identity, "", link_target.data(), link_target.size() - 1);
    if (length < 0) return -1;
    link_target[static_cast<size_t>(length)] = '\0';
    if (symlinkat(link_target.data(), target_parent, target_name.c_str()) != 0) return -1;
    state->target_claimed = true;
    return 0;
  }

  errno = EINVAL;
  return -1;
}

int CopyEntry(int source_parent, const std::string& source_name, int target_parent, const std::string& target_name, size_t depth, CopyState* state) {
  if (depth > kMaxDepth || ++state->entries > kMaxEntries) {
    errno = E2BIG;
    return -1;
  }
  Fd identity(OpenAt2(source_parent, source_name.c_str(), O_PATH | O_NOFOLLOW | O_CLOEXEC));
  if (!identity) return -1;
  struct stat before = {};
  if (fstat(identity.get(), &before) != 0) return -1;
  return CopyCapturedEntry(
    identity.get(), before, source_parent, source_name, target_parent, target_name, depth, state);
}

Result CopyDirectoryStaged(
  int source_parent,
  const std::string& source_name,
  const struct stat& before,
  int target_parent,
  const PathParts& target_path,
  CopyTestScenario test_scenario) {
  Fd source(OpenAt2(source_parent, source_name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  if (!source) return Failure(errno);
  struct stat opened = {};
  if (fstat(source.get(), &opened) != 0 || !StableEntry(before, opened)) return Failure(ESTALE);

  StagingDirectoryClaim staging = CreateStagingDirectory(target_parent);
  Fd stage(staging.fd);
  if (!stage) {
    const int error = errno;
    return staging.name.empty()
      ? Failure(error)
      : Failure(error, true, ParentRelativePath(target_path, staging.name));
  }
  const std::string partial_path = ParentRelativePath(target_path, staging.name);
  if (test_scenario == CopyTestScenario::kReplaceFinalAfterStageClaim
      && InstallFinalDirectoryClaimantForTest(target_parent, target_path.components.back()) != 0) {
    return Failure(errno, true, partial_path);
  }

  CopyState state;
  state.entries = 1;
  state.target_claimed = true;
  state.test_scenario = test_scenario;
  if (CopyDirectory(source.get(), stage.get(), 0, &state) != 0
      || fchmod(stage.get(), opened.st_mode & 0777) != 0) {
    return Failure(errno, true, partial_path);
  }
  struct stat source_after = {};
  if (fstat(source.get(), &source_after) != 0 || !StableEntry(opened, source_after)) {
    return Failure(ESTALE, true, partial_path);
  }

  struct stat staged_fd = {};
  struct stat staged_name = {};
  if (fstat(stage.get(), &staged_fd) != 0
      || fstatat(target_parent, staging.name.c_str(), &staged_name, AT_SYMLINK_NOFOLLOW) != 0
      || !SameIdentity(staged_fd, staged_name)) {
    return Failure(ESTALE, true, partial_path);
  }
  const int published = static_cast<int>(syscall(
    SYS_renameat2,
    target_parent, staging.name.c_str(),
    target_parent, target_path.components.back().c_str(),
    RENAME_NOREPLACE));
  if (published != 0) return {ErrorCode(errno), errno, partial_path};
  return {Code::kOk, 0};
}

Result CopyImpl(
  const std::string& home,
  const std::string& source,
  const std::string& target,
  bool create_parents,
  CopyTestScenario test_scenario) {
  const PathParts source_path = SplitRelative(source);
  const PathParts target_path = SplitRelative(target);
  if (!source_path.valid || !target_path.valid || IsSameOrDescendant(source_path, target_path)) return Failure(EINVAL);
  Fd home_fd = OpenHome(home);
  if (!home_fd) return Failure(errno);
  Fd source_parent = OpenParent(home_fd.get(), source_path, false);
  if (!source_parent) return Failure(errno);
  Fd target_parent = OpenParent(home_fd.get(), target_path, create_parents);
  if (!target_parent) return Failure(errno);

  const std::string& source_name = source_path.components.back();
  Fd identity(OpenAt2(source_parent.get(), source_name.c_str(), O_PATH | O_NOFOLLOW | O_CLOEXEC));
  if (!identity) return Failure(errno);
  struct stat before = {};
  if (fstat(identity.get(), &before) != 0) return Failure(errno);
  if (S_ISDIR(before.st_mode)) {
    return CopyDirectoryStaged(
      source_parent.get(), source_name, before, target_parent.get(), target_path, test_scenario);
  }

  CopyState state;
  state.entries = 1;
  state.test_scenario = test_scenario;
  if (CopyCapturedEntry(
        identity.get(),
        before,
        source_parent.get(),
        source_name,
        target_parent.get(),
        target_path.components.back(),
        0,
        &state) != 0) {
    return Failure(errno, state.target_claimed, state.target_claimed ? target : std::string{});
  }
  return {Code::kOk, 0};
}

}  // namespace

Result Create(const std::string& home, const std::string& relative_path, bool directory, const std::string& content, bool create_parents, bool allow_existing) {
  const PathParts path = SplitRelative(relative_path);
  if (!path.valid) return Failure(EINVAL);
  Fd home_fd = OpenHome(home);
  if (!home_fd) return Failure(errno);
  Fd parent = OpenParent(home_fd.get(), path, create_parents);
  if (!parent) return Failure(errno);
  const std::string& name = path.components.back();
  if (directory) {
    if (mkdirat(parent.get(), name.c_str(), 0777) == 0) return {Code::kOk, 0};
    if (errno == EEXIST && allow_existing) {
      Fd existing(OpenAt2(parent.get(), name.c_str(), O_PATH | O_DIRECTORY | O_CLOEXEC));
      if (existing) return {Code::kOk, 0};
    }
    return Failure(errno);
  }
  Fd target(openat(parent.get(), name.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0666));
  if (!target) return Failure(errno);
  if (WriteAll(target.get(), content.data(), content.size()) != 0) return Failure(errno, true);
  return {Code::kOk, 0};
}

Result Copy(const std::string& home, const std::string& source, const std::string& target, bool create_parents) {
  return CopyImpl(home, source, target, create_parents, CopyTestScenario::kNone);
}

Result CopyForTest(
  const std::string& home,
  const std::string& source,
  const std::string& target,
  bool create_parents,
  CopyTestScenario scenario) {
  return CopyImpl(home, source, target, create_parents, scenario);
}

Result Move(const std::string& home, const std::string& source, const std::string& target, bool create_parents) {
  const PathParts source_path = SplitRelative(source);
  const PathParts target_path = SplitRelative(target);
  if (!source_path.valid || !target_path.valid || IsSameOrDescendant(source_path, target_path)) return Failure(EINVAL);
  Fd home_fd = OpenHome(home);
  if (!home_fd) return Failure(errno);
  Fd source_parent = OpenParent(home_fd.get(), source_path, false);
  if (!source_parent) return Failure(errno);
  Fd target_parent = OpenParent(home_fd.get(), target_path, create_parents);
  if (!target_parent) return Failure(errno);
  const int result = static_cast<int>(syscall(
    SYS_renameat2,
    source_parent.get(), source_path.components.back().c_str(),
    target_parent.get(), target_path.components.back().c_str(),
    RENAME_NOREPLACE));
  return result == 0 ? Result{Code::kOk, 0} : Failure(errno);
}

const char* CodeName(Code code) {
  switch (code) {
    case Code::kOk: return "ok";
    case Code::kDestinationConflict: return "destination_conflict";
    case Code::kNotFound: return "source_missing";
    case Code::kInvalidPath: return "invalid_path";
    case Code::kCrossDevice: return "cross_device";
    case Code::kLimitExceeded: return "limit_exceeded";
    case Code::kPartial: return "partial";
    case Code::kUnsupported: return "unsupported_platform";
    case Code::kFailed: return "failed";
  }
  return "failed";
}

}  // namespace matrix_fs
