#include <node_api.h>

#include <string>

#include "fs-ops.h"

namespace {

enum class Operation { kCreate, kCopy, kCopyTest, kMove };

struct Work {
  napi_async_work async = nullptr;
  napi_deferred deferred = nullptr;
  Operation operation = Operation::kCreate;
  std::string home;
  std::string source;
  std::string target;
  std::string content;
  bool directory = false;
  bool create_parents = false;
  bool allow_existing = false;
  matrix_fs::CopyTestScenario test_scenario = matrix_fs::CopyTestScenario::kNone;
  matrix_fs::Result result;
};

bool ReadString(napi_env env, napi_value value, std::string* output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  output->resize(length + 1);
  size_t copied = 0;
  const bool ok = napi_get_value_string_utf8(env, value, output->data(), length + 1, &copied) == napi_ok && copied == length;
  output->resize(copied);
  return ok;
}

bool ReadBoolean(napi_env env, napi_value value, bool* output) {
  return napi_get_value_bool(env, value, output) == napi_ok;
}

bool ReadTestScenario(napi_env env, napi_value value, matrix_fs::CopyTestScenario* output) {
  std::string scenario;
  if (!ReadString(env, value, &scenario)) return false;
  if (scenario == "replace_final_after_stage_claim") {
    *output = matrix_fs::CopyTestScenario::kReplaceFinalAfterStageClaim;
    return true;
  }
  if (scenario == "chmod_source_after_identity") {
    *output = matrix_fs::CopyTestScenario::kChmodSourceAfterIdentity;
    return true;
  }
  if (scenario == "replace_source_after_identity") {
    *output = matrix_fs::CopyTestScenario::kReplaceSourceAfterIdentity;
    return true;
  }
  if (scenario == "fail_regular_after_target_claim") {
    *output = matrix_fs::CopyTestScenario::kFailRegularAfterTargetClaim;
    return true;
  }
  if (scenario == "replace_retained_child_before_open") {
    *output = matrix_fs::CopyTestScenario::kReplaceRetainedChildBeforeOpen;
    return true;
  }
  if (scenario == "pause_after_stage_claim") {
    *output = matrix_fs::CopyTestScenario::kPauseAfterStageClaim;
    return true;
  }
  if (scenario == "pause_after_stage_sweep") {
    *output = matrix_fs::CopyTestScenario::kPauseAfterStageSweep;
    return true;
  }
  return false;
}

void Execute(napi_env, void* data) {
  Work* work = static_cast<Work*>(data);
  switch (work->operation) {
    case Operation::kCreate:
      work->result = matrix_fs::Create(
        work->home,
        work->target,
        work->directory,
        work->content,
        work->create_parents,
        work->allow_existing);
      break;
    case Operation::kCopy:
      work->result = matrix_fs::Copy(work->home, work->source, work->target, work->create_parents);
      break;
    case Operation::kCopyTest:
      work->result = matrix_fs::CopyForTest(
        work->home, work->source, work->target, work->create_parents, work->test_scenario);
      break;
    case Operation::kMove:
      work->result = matrix_fs::Move(work->home, work->source, work->target, work->create_parents);
      break;
  }
}

void Complete(napi_env env, napi_status status, void* data) {
  Work* work = static_cast<Work*>(data);
  napi_value result;
  napi_create_object(env, &result);
  napi_value ok;
  napi_get_boolean(env, status == napi_ok && work->result.code == matrix_fs::Code::kOk, &ok);
  napi_set_named_property(env, result, "ok", ok);
  napi_value code;
  napi_create_string_utf8(env, status == napi_ok ? matrix_fs::CodeName(work->result.code) : "failed", NAPI_AUTO_LENGTH, &code);
  napi_set_named_property(env, result, "code", code);
  if (status == napi_ok && !work->result.partial_path.empty()) {
    napi_value partial_path;
    napi_create_string_utf8(env, work->result.partial_path.c_str(), NAPI_AUTO_LENGTH, &partial_path);
    napi_set_named_property(env, result, "partialPath", partial_path);
  }
  napi_resolve_deferred(env, work->deferred, result);
  napi_delete_async_work(env, work->async);
  delete work;
}

napi_value Queue(napi_env env, Work* work, const char* name) {
  napi_value promise;
  napi_create_promise(env, &work->deferred, &promise);
  napi_value resource_name;
  napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &resource_name);
  if (napi_create_async_work(env, nullptr, resource_name, Execute, Complete, work, &work->async) != napi_ok) {
    delete work;
    napi_throw_error(env, nullptr, "Unable to schedule native filesystem operation");
    return nullptr;
  }
  if (napi_queue_async_work(env, work->async) != napi_ok) {
    napi_delete_async_work(env, work->async);
    delete work;
    napi_throw_error(env, nullptr, "Unable to schedule native filesystem operation");
    return nullptr;
  }
  return promise;
}

napi_value Create(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value args[6];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 6) {
    napi_throw_type_error(env, nullptr, "create requires 6 arguments");
    return nullptr;
  }
  Work* work = new Work();
  work->operation = Operation::kCreate;
  if (!ReadString(env, args[0], &work->home)
      || !ReadString(env, args[1], &work->target)
      || !ReadBoolean(env, args[2], &work->directory)
      || !ReadString(env, args[3], &work->content)
      || !ReadBoolean(env, args[4], &work->create_parents)
      || !ReadBoolean(env, args[5], &work->allow_existing)) {
    delete work;
    napi_throw_type_error(env, nullptr, "invalid create arguments");
    return nullptr;
  }
  return Queue(env, work, "matrix_fs_create");
}

napi_value CopyOrMove(napi_env env, napi_callback_info info, Operation operation) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 4) {
    napi_throw_type_error(env, nullptr, "copy/move requires 4 arguments");
    return nullptr;
  }
  Work* work = new Work();
  work->operation = operation;
  if (!ReadString(env, args[0], &work->home)
      || !ReadString(env, args[1], &work->source)
      || !ReadString(env, args[2], &work->target)
      || !ReadBoolean(env, args[3], &work->create_parents)) {
    delete work;
    napi_throw_type_error(env, nullptr, "invalid copy/move arguments");
    return nullptr;
  }
  return Queue(env, work, operation == Operation::kCopy ? "matrix_fs_copy" : "matrix_fs_move");
}

napi_value Copy(napi_env env, napi_callback_info info) {
  return CopyOrMove(env, info, Operation::kCopy);
}

napi_value CopyForTest(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value args[5];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 5) {
    napi_throw_type_error(env, nullptr, "copyForTest requires 5 arguments");
    return nullptr;
  }
  Work* work = new Work();
  work->operation = Operation::kCopyTest;
  if (!ReadString(env, args[0], &work->home)
      || !ReadString(env, args[1], &work->source)
      || !ReadString(env, args[2], &work->target)
      || !ReadBoolean(env, args[3], &work->create_parents)
      || !ReadTestScenario(env, args[4], &work->test_scenario)) {
    delete work;
    napi_throw_type_error(env, nullptr, "invalid copyForTest arguments");
    return nullptr;
  }
  return Queue(env, work, "matrix_fs_copy_test");
}

napi_value Move(napi_env env, napi_callback_info info) {
  return CopyOrMove(env, info, Operation::kMove);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"create", nullptr, Create, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"copy", nullptr, Copy, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"copyForTest", nullptr, CopyForTest, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"move", nullptr, Move, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
