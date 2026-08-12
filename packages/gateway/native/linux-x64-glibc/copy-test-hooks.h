#pragma once

#include <sys/stat.h>

#include <string>

#include "fs-ops.h"

namespace matrix_fs {

int InstallFinalDirectoryClaimantForTest(int parent, const std::string& name);
int PauseAfterStageClaimForTest(int parent, const std::string& stage_name);

int RunCopyEntryTestScenario(
  int source_parent,
  const std::string& source_name,
  size_t depth,
  const struct stat& before,
  CopyTestScenario scenario,
  bool* scenario_fired);

}  // namespace matrix_fs
