#include "copy-test-hooks.h"

#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

namespace matrix_fs {

int InstallFinalDirectoryClaimantForTest(int parent, const std::string& name) {
  if (unlinkat(parent, name.c_str(), AT_REMOVEDIR) != 0 && errno != ENOENT) return -1;
  if (mkdirat(parent, name.c_str(), 0700) != 0) return -1;
  const int directory = openat(parent, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0) return -1;
  const int marker = openat(
    directory, "claimant.txt", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  const int open_error = errno;
  close(directory);
  if (marker < 0) {
    errno = open_error;
    return -1;
  }
  const ssize_t written = write(marker, "claimant", 8);
  const int write_error = errno;
  close(marker);
  if (written != 8) {
    errno = written < 0 ? write_error : EIO;
    return -1;
  }
  return 0;
}

int RunCopyEntryTestScenario(
  int source_parent,
  const std::string& source_name,
  size_t depth,
  const struct stat& before,
  CopyTestScenario scenario,
  bool* scenario_fired) {
  if (depth != 1 || *scenario_fired || !S_ISREG(before.st_mode)) return 0;
  if (scenario == CopyTestScenario::kChmodSourceAfterIdentity) {
    *scenario_fired = true;
    return fchmodat(source_parent, source_name.c_str(), (before.st_mode & 0777) ^ S_IXUSR, 0);
  }
  if (scenario == CopyTestScenario::kReplaceSourceAfterIdentity) {
    *scenario_fired = true;
    if (unlinkat(source_parent, source_name.c_str(), 0) != 0) return -1;
    return symlinkat("/etc/passwd", source_parent, source_name.c_str());
  }
  return 0;
}

}  // namespace matrix_fs
