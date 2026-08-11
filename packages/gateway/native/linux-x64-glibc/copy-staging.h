#pragma once

#include <string>

namespace matrix_fs {

struct StagingDirectoryClaim {
  int fd = -1;
  std::string name;
};

StagingDirectoryClaim CreateStagingDirectory(int parent);

}  // namespace matrix_fs
