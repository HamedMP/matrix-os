#pragma once

#include <string>

namespace matrix_fs {

enum class StagingSweepTestScenario {
  kNone,
  kReplaceChildBeforeOpen,
  kPauseAfterSweep,
};

struct StagingDirectoryClaim {
  int fd = -1;
  std::string name;
};

StagingDirectoryClaim CreateStagingDirectory(
  int parent,
  StagingSweepTestScenario test_scenario = StagingSweepTestScenario::kNone);

}  // namespace matrix_fs
