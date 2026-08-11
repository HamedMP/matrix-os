#pragma once

#include <string>

namespace matrix_fs {

enum class Code {
  kOk,
  kDestinationConflict,
  kNotFound,
  kInvalidPath,
  kCrossDevice,
  kLimitExceeded,
  kPartial,
  kUnsupported,
  kFailed,
};

struct Result {
  Code code = Code::kFailed;
  int system_error = 0;
};

Result Create(
  const std::string& home,
  const std::string& relative_path,
  bool directory,
  const std::string& content,
  bool create_parents,
  bool allow_existing);

Result Copy(
  const std::string& home,
  const std::string& source,
  const std::string& target,
  bool create_parents);

Result Move(
  const std::string& home,
  const std::string& source,
  const std::string& target,
  bool create_parents);

const char* CodeName(Code code);

}  // namespace matrix_fs
