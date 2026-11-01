/* One owner per fd: opaque N-API handles, idempotent close and GC finalization.
 * No private Node handles. Linux SCM_CREDENTIALS is checked on every recvmsg.
 * Other development hosts retain Terminal I/O but cannot claim this proof. */
#define _GNU_SOURCE
#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#ifdef __linux__
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/syscall.h>
#include <poll.h>
#include <linux/capability.h>
#endif

typedef struct { int fd; int kind; } owned_fd;
static unsigned int open_count = 0;
static const unsigned int max_open = 128;
static napi_value fail(napi_env env) { napi_throw_error(env, NULL, "Terminal native proof unavailable"); return NULL; }
static napi_value nothing(napi_env env) { napi_value value; napi_get_null(env, &value); return value; }
static void close_owned(owned_fd *value) {
  if (value && value->fd >= 0) {
#ifdef __linux__
    close(value->fd); /* Do not retry close after EINTR: descriptor may already be reused. */
#endif
    value->fd = -1; if (open_count) open_count--;
  }
}
static void finalize(napi_env env, void *data, void *hint) { (void)env; (void)hint; close_owned(data); free(data); }
static napi_value wrap(napi_env env, int fd, int kind) {
  owned_fd *value = calloc(1, sizeof(*value));
  if (!value) {
#ifdef __linux__
    close(fd);
#endif
    return fail(env);
  }
  value->fd = fd; value->kind = kind; open_count++;
  napi_value result;
  if (napi_create_external(env, value, finalize, NULL, &result) != napi_ok) { finalize(env, value, NULL); return fail(env); }
  return result;
}
static owned_fd *handle(napi_env env, napi_value raw, int kind) {
  owned_fd *value = NULL;
  if (napi_get_value_external(env, raw, (void **)&value) != napi_ok || !value || value->fd < 0 || (kind && value->kind != kind)) return NULL;
  return value;
}
static void number(napi_env env, napi_value object, const char *key, int64_t value) {
  napi_value raw; napi_create_int64(env, value, &raw); napi_set_named_property(env, object, key, raw);
}
static napi_value close_handle(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  owned_fd *value = NULL;
  if (argc != 1 || napi_get_value_external(env, args[0], (void **)&value) != napi_ok || !value) return fail(env);
  close_owned(value); return nothing(env);
}
static napi_value listen_socket(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 1, length; napi_value args[1]; char path[sizeof(((struct sockaddr_un *)0)->sun_path)];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1 || open_count >= max_open || napi_get_value_string_utf8(env, args[0], NULL, 0, &length) != napi_ok
      || length < 2 || length >= sizeof(path) || napi_get_value_string_utf8(env, args[0], path, sizeof(path), &length) != napi_ok
      || path[0] != '/' || strlen(path) != length) return fail(env);
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0), enabled = 1;
  if (fd < 0) return fail(env);
  struct sockaddr_un address = {0}; address.sun_family = AF_UNIX; memcpy(address.sun_path, path, length + 1);
  /* Set before bind/listen: accepted sockets inherit it, including bytes sent before accept. */
  if (setsockopt(fd, SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) != 0
      || bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { close(fd); return fail(env); }
  /* Never unlink an existing path. Caller owns an exclusive private namespace. */
  if (chmod(path, 0600) != 0 || listen(fd, 32) != 0) { close(fd); unlink(path); return fail(env); }
  return wrap(env, fd, 1);
#else
  (void)info; return fail(env);
#endif
}
static napi_value accept_socket(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  owned_fd *listener = argc == 1 ? handle(env, args[0], 1) : NULL;
  if (!listener || open_count >= max_open) return fail(env);
  int fd = accept4(listener->fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
  if (fd < 0) { if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return nothing(env); return fail(env); }
  struct ucred peer; socklen_t length = sizeof(peer); int enabled = 1;
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &length) != 0 || length != sizeof(peer) || peer.pid <= 0
      || setsockopt(fd, SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) != 0) { close(fd); return fail(env); }
  napi_value result, writer, connection = wrap(env, fd, 2); if (!connection) return NULL;
  napi_create_object(env, &result); napi_create_object(env, &writer);
  number(env, writer, "pid", peer.pid); number(env, writer, "uid", peer.uid); number(env, writer, "gid", peer.gid);
  napi_set_named_property(env, result, "handle", connection); napi_set_named_property(env, result, "creator", writer); return result;
#else
  (void)info; return fail(env);
#endif
}
/* Shared ancillary validator: Terminal rejects by closing; private stdout keeps
 * usable I/O but returns no writer identity after invalid metadata. */
#ifdef __linux__
static napi_value receive_fd(napi_env env, owned_fd *client, int preserve_io) {
  char bytes[8192]; union { struct cmsghdr alignment; char data[CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(256 * sizeof(int))]; } control;
  struct iovec vector = {bytes, sizeof(bytes)};
  struct msghdr message = {0}; message.msg_iov = &vector; message.msg_iovlen = 1; message.msg_control = control.data; message.msg_controllen = sizeof(control.data);
  ssize_t length = recvmsg(client->fd, &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
  if (length < 0) { if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return nothing(env); close_owned(client); return fail(env); }
  if (length == 0) { close_owned(client); napi_value eof; napi_get_boolean(env, 0, &eof); return eof; }
  int invalid = !!(message.msg_flags & (MSG_CTRUNC | MSG_TRUNC)), credentials = 0;
  struct ucred writer = {0};
  for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); header; header = CMSG_NXTHDR(&message, header)) {
    if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS) {
      /* Reject ancillary descriptors AND close every descriptor the kernel installed. */
      if (header->cmsg_len >= CMSG_LEN(0)) {
        size_t count = (header->cmsg_len - CMSG_LEN(0)) / sizeof(int); int *fds = (int *)CMSG_DATA(header);
        for (size_t i = 0; i < count; ++i) close(fds[i]);
      }
      invalid = 1;
    } else if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_CREDENTIALS && header->cmsg_len == CMSG_LEN(sizeof(writer))) {
      memcpy(&writer, CMSG_DATA(header), sizeof(writer)); credentials++;
    } else invalid = 1;
  }
  if (invalid || credentials != 1 || writer.pid <= 0) {
    if (!preserve_io) { close_owned(client); return fail(env); }
    writer.pid = 0;
  }
  napi_value result, data, identity; napi_create_object(env, &result); napi_create_object(env, &identity);
  napi_create_buffer_copy(env, (size_t)length, bytes, NULL, &data);
  number(env, identity, "pid", writer.pid); number(env, identity, "uid", writer.uid); number(env, identity, "gid", writer.gid);
  napi_set_named_property(env, result, "data", data);
  napi_set_named_property(env, result, "writer", writer.pid > 0 ? identity : nothing(env)); return result;
}
#endif
static napi_value receive(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  owned_fd *client = argc == 1 ? handle(env, args[0], 2) : NULL;
  if (!client) return fail(env);
  return receive_fd(env, client, 0);
#else
  (void)info; return fail(env);
#endif
}
static napi_value send_bytes(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 2, length; napi_value args[2]; void *bytes; bool is_buffer;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  owned_fd *client = argc == 2 ? handle(env, args[0], 2) : NULL;
  if (!client || napi_is_buffer(env, args[1], &is_buffer) != napi_ok || !is_buffer
      || napi_get_buffer_info(env, args[1], &bytes, &length) != napi_ok || length > 131073) return fail(env);
  ssize_t written = send(client->fd, bytes, length, MSG_DONTWAIT | MSG_NOSIGNAL);
  if (written < 0) { if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) written = 0; else { close_owned(client); return fail(env); } }
  napi_value result; napi_create_int64(env, written, &result); return result;
#else
  (void)info; return fail(env);
#endif
}
/* These are transport observations, never an executable/source admission. */
#ifdef __linux__
static int unprivileged(void) {
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct caps[2] = {{0}};
  if (getuid() == 0 || getuid() != geteuid() || getgid() != getegid()
      || syscall(SYS_capget, &header, caps) != 0) return 0;
  for (int i = 0; i < 2; i++) if (caps[i].effective || caps[i].permitted || caps[i].inheritable) return 0;
  return 1;
}
#endif
static napi_value stdout_pair(napi_env env, napi_callback_info info) {
  (void)info;
#ifdef __linux__
  int pair[2], enabled = 1;
  if (!unprivileged() || open_count > max_open - 2 || socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) != 0) return fail(env);
  /* Only the receiver is nonblocking. SO_PASSCRED precedes any possible exec. */
  int flags = fcntl(pair[0], F_GETFL);
  if (flags < 0 || fcntl(pair[0], F_SETFL, flags | O_NONBLOCK) != 0
      || setsockopt(pair[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) != 0) {
    close(pair[0]); close(pair[1]); return fail(env);
  }
  napi_value result, receiver = wrap(env, pair[0], 3);
  if (!receiver) { close(pair[1]); return NULL; }
  napi_value writer = wrap(env, pair[1], 4);
  if (!writer) { close_owned(handle(env, receiver, 3)); return NULL; }
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "receiver", receiver); napi_set_named_property(env, result, "writer", writer);
  number(env, result, "uid", getuid()); number(env, result, "gid", getgid()); return result;
#else
  return fail(env);
#endif
}
static napi_value stdout_writer_fd(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  owned_fd *writer = argc == 1 ? handle(env, args[0], 4) : NULL;
  if (!writer) return fail(env);
  napi_value result; napi_create_int32(env, writer->fd, &result); return result;
}
static napi_value stdout_receive(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  owned_fd *receiver = argc == 1 ? handle(env, args[0], 3) : NULL;
  if (!receiver) return fail(env);
  return receive_fd(env, receiver, 1);
#else
  (void)info; return fail(env);
#endif
}
static napi_value retain_child(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 1; napi_value args[1]; int64_t pid;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1 || !unprivileged() || open_count >= max_open
      || napi_get_value_int64(env, args[0], &pid) != napi_ok || pid <= 0 || pid > INT32_MAX) return fail(env);
  /* Caller must retain the actual spawn return before its child can be reaped.
   * This primitive alone accepts no source and proves no image continuity. */
#ifdef SYS_pidfd_open
  int fd = (int)syscall(SYS_pidfd_open, (pid_t)pid, 0);
  if (fd < 0) return fail(env);
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) != 0) { close(fd); return fail(env); }
  return wrap(env, fd, 5);
#else
  return fail(env);
#endif
#else
  (void)info; return fail(env);
#endif
}
static napi_value child_alive(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  owned_fd *birth = argc == 1 ? handle(env, args[0], 5) : NULL;
  if (!birth || !unprivileged()) return fail(env);
  struct pollfd descriptor = { .fd = birth->fd, .events = POLLIN };
  int ready = poll(&descriptor, 1, 0);
  if (ready < 0) return fail(env);
  napi_value result; napi_get_boolean(env, ready == 0 && descriptor.revents == 0, &result); return result;
#else
  (void)info; return fail(env);
#endif
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"stdoutPair", NULL, stdout_pair, NULL, NULL, NULL, napi_default, NULL},
    {"stdoutWriterFd", NULL, stdout_writer_fd, NULL, NULL, NULL, napi_default, NULL},
    {"stdoutReceive", NULL, stdout_receive, NULL, NULL, NULL, napi_default, NULL},
    {"retainChild", NULL, retain_child, NULL, NULL, NULL, napi_default, NULL},
    {"childAlive", NULL, child_alive, NULL, NULL, NULL, napi_default, NULL},
    {"listen", NULL, listen_socket, NULL, NULL, NULL, napi_default, NULL},
    {"accept", NULL, accept_socket, NULL, NULL, NULL, napi_default, NULL},
    {"receive", NULL, receive, NULL, NULL, NULL, napi_default, NULL},
    {"send", NULL, send_bytes, NULL, NULL, NULL, napi_default, NULL},
    {"close", NULL, close_handle, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
