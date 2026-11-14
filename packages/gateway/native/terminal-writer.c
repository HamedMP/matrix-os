/* One owner per fd: opaque N-API handles, idempotent close and GC finalization.
 * No private Node handles. Linux SCM_CREDENTIALS is checked on every recvmsg.
 * Other development hosts retain Terminal I/O but cannot claim this proof. */
#define _GNU_SOURCE
#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdatomic.h>
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
#ifndef SCM_PIDFD
/* Linux v6.8 include/linux/socket.h: SCM_PIDFD 0x04, one received fd (ro int). */
#define SCM_PIDFD 0x04
#endif
#endif

typedef struct { int fd; int kind; int private_control; int proof; unsigned int cost, uid, gid; int creator; } owned_fd;
static atomic_uint open_count = 0;
static atomic_flag inherited_attempt = ATOMIC_FLAG_INIT;
static const unsigned int max_open = 128;
static int reserve(unsigned int cost) {
  unsigned int count = atomic_load(&open_count);
  do { if (count > max_open || cost > max_open - count) return 0; }
  while (!atomic_compare_exchange_weak(&open_count, &count, count + cost));
  return 1;
}
static napi_value fail(napi_env env) { napi_throw_error(env, NULL, "Terminal native proof unavailable"); return NULL; }
static napi_value nothing(napi_env env) { napi_value value; napi_get_null(env, &value); return value; }
static void close_owned(owned_fd *value) {
  if (value && value->fd >= 0) {
#ifdef __linux__
    if (value->kind == 7) shutdown(value->fd, SHUT_RDWR); /* Fences all aliases; never closes raw0/1. */
    close(value->fd); /* Do not retry close after EINTR: descriptor may already be reused. */
    if (value->proof >= 0) close(value->proof);
#endif
    value->fd = -1; value->proof = -1; atomic_fetch_sub(&open_count, value->cost); value->cost = 0;
  }
}
static void finalize(napi_env env, void *data, void *hint) { (void)env; (void)hint; close_owned(data); free(data); }
static napi_value wrap_reserved(napi_env env, int fd, int kind, int proof, unsigned int cost) {
  owned_fd *value = calloc(1, sizeof(*value));
  if (!value) {
#ifdef __linux__
    if (kind == 7) shutdown(fd, SHUT_RDWR);
    close(fd);
    if (proof >= 0) close(proof);
#endif
    atomic_fetch_sub(&open_count, cost);
    return fail(env);
  }
  value->fd = fd; value->kind = kind; value->proof = proof; value->cost = cost;
  napi_value result;
  if (napi_create_external(env, value, finalize, NULL, &result) != napi_ok) { finalize(env, value, NULL); return fail(env); }
  return result;
}
static napi_value wrap(napi_env env, int fd, int kind) {
  if (reserve(1)) return wrap_reserved(env, fd, kind, -1, 1);
#ifdef __linux__
  close(fd);
#endif
  return fail(env);
}
#ifdef __linux__
static int inherited_current(owned_fd *value);
static int inherited_domain(owned_fd *value);
#endif
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
#ifdef __linux__
  if (value->kind == 7 && value->fd >= 0 && !inherited_domain(value)) { close_owned(value); return fail(env); }
#endif
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
  int invalid = !!(message.msg_flags & (MSG_CTRUNC | MSG_TRUNC)), credentials = 0;
  struct ucred writer = {0};
  for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); header; header = CMSG_NXTHDR(&message, header)) {
    if (header->cmsg_level == SOL_SOCKET && (header->cmsg_type == SCM_RIGHTS || header->cmsg_type == SCM_PIDFD)) {
      /* Reject known fd-bearing metadata AND close installed descriptors. */
      if (header->cmsg_len >= CMSG_LEN(0)) {
        size_t count = (header->cmsg_len - CMSG_LEN(0)) / sizeof(int); int *fds = (int *)CMSG_DATA(header);
        if (header->cmsg_type == SCM_PIDFD && count > 1) count = 1; /* PIDFD is one ro int, not a list. */
        for (size_t i = 0; i < count; ++i) close(fds[i]);
      }
      invalid = 1;
    } else if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_CREDENTIALS && header->cmsg_len == CMSG_LEN(sizeof(writer))) {
      memcpy(&writer, CMSG_DATA(header), sizeof(writer)); credentials++;
    } else invalid = 1;
  }
  /* EOF is control loss, not a positive credentialled frame. Close all rights first. */
  if (length == 0) { close_owned(client); napi_value eof; napi_get_boolean(env, 0, &eof); return eof; }
  if (client->kind == 7 && (!inherited_current(client) || writer.pid != client->creator || writer.uid != client->uid || writer.gid != client->gid)) {
    close_owned(client); return fail(env);
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
  owned_fd *client = argc == 1 ? handle(env, args[0], 0) : NULL;
  if (!client || (client->kind != 2 && client->kind != 7) || (client->kind == 7 && !inherited_current(client))) return fail(env);
  return receive_fd(env, client, 0);
#else
  (void)info; return fail(env);
#endif
}
static napi_value send_bytes(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 2, length; napi_value args[2]; void *bytes; bool is_buffer;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  owned_fd *client = argc == 2 ? handle(env, args[0], 0) : NULL;
  if (!client || (client->kind != 2 && client->kind != 7) || (client->kind == 7 && !inherited_current(client))
      || napi_is_buffer(env, args[1], &is_buffer) != napi_ok || !is_buffer
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
/* Same zero-timeout kernel birth check used by childAlive and the handoff.
 * -1 is observation failure, 0 is no longer live, 1 is currently live. */
static int birth_state(const owned_fd *birth) {
  struct pollfd descriptor = { .fd = birth->fd, .events = POLLIN };
  int ready = poll(&descriptor, 1, 0);
  if (ready < 0) return -1;
  return ready == 0 && descriptor.revents == 0;
}
static int inherited_domain(owned_fd *value) {
  return syscall(SYS_gettid) == getpid() && unprivileged() && getuid() == value->uid && getgid() == value->gid;
}
static int inherited_current(owned_fd *value) {
  owned_fd proof = { .fd = value->proof };
  if (!inherited_domain(value) || value->proof < 3 || birth_state(&proof) != 1) { close_owned(value); return 0; }
  struct pollfd control = { .fd = value->fd, .events = POLLRDHUP };
  if (poll(&control, 1, 0) < 0 || (control.revents & (POLLHUP | POLLRDHUP | POLLERR | POLLNVAL))) {
    close_owned(value); return 0; /* Queued POLLIN alone remains valid; known channel loss fences immediately. */
  }
  return 1;
}
#endif
/* One fixed-stdio adoption attempt per loaded process image, burned even by a
 * Worker/invalid call. The creator proof comes from the socket, never a PID DTO. */
static napi_value inherited_control(napi_env env, napi_callback_info info) {
  if (atomic_flag_test_and_set(&inherited_attempt)) return fail(env);
#ifdef __linux__
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc
      || syscall(SYS_gettid) != getpid() || !unprivileged() || !reserve(2)) return fail(env);
  int fd = -1, proof = -1; unsigned int uid = getuid(), gid = getgid();
  struct stat input, output;
  if (fstat(0, &input) || fstat(1, &output) || !S_ISSOCK(input.st_mode) || !S_ISSOCK(output.st_mode)
      || input.st_dev != output.st_dev || input.st_ino != output.st_ino) goto unavailable;
  int options[] = {SO_DOMAIN, SO_TYPE, SO_PASSCRED}, expected[] = {AF_UNIX, SOCK_STREAM, 1};
  for (int descriptor = 0; descriptor <= 1; descriptor++) for (unsigned int i = 0; i < 3; i++) {
    int value = 0; socklen_t size = sizeof(value);
    if (getsockopt(descriptor, SOL_SOCKET, options[i], &value, &size) || size != sizeof(value) || value != expected[i]) goto unavailable;
  }
  struct sockaddr_un name = {0}; socklen_t size = sizeof(name);
  if (getsockname(0, (struct sockaddr *)&name, &size) || size != sizeof(sa_family_t) || name.sun_family != AF_UNIX) goto unavailable;
  size = sizeof(name);
  if (getpeername(0, (struct sockaddr *)&name, &size) || size != sizeof(sa_family_t) || name.sun_family != AF_UNIX) goto unavailable;
  struct ucred creator = {0}; size = sizeof(creator);
  if (getsockopt(0, SOL_SOCKET, SO_PEERCRED, &creator, &size) || size != sizeof(creator)
      || creator.pid <= 1 || creator.pid == getpid() || creator.uid != uid || creator.gid != gid) goto unavailable;
  size = sizeof(proof);
  if (getsockopt(0, SOL_SOCKET, 77, &proof, &size)) goto unavailable; /* Linux SO_PEERPIDFD. No numeric reopen. */
  if (proof < 3) {
    if (proof == 2) close(proof); /* Original stderr was closed; kernel installed this new owned fd. */
    proof = -1; goto unavailable; /* Keep the >=3 policy; never close original stdio0/1. */
  }
  if (size != sizeof(proof)) goto unavailable;
  int proof_flags = fcntl(proof, F_GETFD);
  if (proof_flags < 0 || !(proof_flags & FD_CLOEXEC)) goto unavailable;
#ifdef SYS_pidfd_send_signal
  if (syscall(SYS_pidfd_send_signal, proof, 0, NULL, 0) != 0) goto unavailable;
#else
  goto unavailable;
#endif
  fd = fcntl(0, F_DUPFD_CLOEXEC, 3);
  if (fd < 0) goto unavailable;
  int flags = fcntl(fd, F_GETFL);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) goto unavailable;
  napi_value result = wrap_reserved(env, fd, 7, proof, 2);
  if (!result) return NULL; /* Ownership/reservation already consumed, including failure. */
  owned_fd *value = handle(env, result, 7);
  value->uid = uid; value->gid = gid; value->creator = creator.pid;
  if (!inherited_current(value)) return fail(env);
  return result;
unavailable:
  if (fd >= 3) { shutdown(fd, SHUT_RDWR); close(fd); }
  if (proof >= 3) close(proof);
  atomic_fetch_sub(&open_count, 2); return fail(env);
#else
  (void)info; return fail(env);
#endif
}
static napi_value inherited_control_current(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  owned_fd *value = argc == 1 ? handle(env, args[0], 7) : NULL;
  if (!value) return fail(env);
  napi_value result; napi_get_boolean(env, inherited_current(value), &result); return result;
#else
  (void)info; return fail(env);
#endif
}
/* Private bidirectional control: kind2 reuses Terminal's strict ancillary
 * receive/send. The separate child role is exposed only for explicit spawn
 * inheritance, never as a second parent consumer or an identity assertion. */
static napi_value control_pair(napi_env env, napi_callback_info info) {
  (void)info;
#ifdef __linux__
  int pair[2], enabled = 1;
  if (!unprivileged() || !reserve(2)) return fail(env);
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) != 0) { atomic_fetch_sub(&open_count, 2); return fail(env); }
  int flags = fcntl(pair[0], F_GETFL);
  /* Both receivers must be credentialled before even a pre-spawn bootstrap
   * can be queued. The child's endpoint intentionally remains blocking. */
  if (flags < 0 || fcntl(pair[0], F_SETFL, flags | O_NONBLOCK) != 0
      || setsockopt(pair[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) != 0
      || setsockopt(pair[1], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) != 0) {
    close(pair[0]); close(pair[1]); atomic_fetch_sub(&open_count, 2); return fail(env);
  }
  napi_value result, channel = wrap_reserved(env, pair[0], 2, -1, 1);
  if (!channel) { close(pair[1]); atomic_fetch_sub(&open_count, 1); return NULL; }
  handle(env, channel, 2)->private_control = 1; /* Never set on accepted Terminal sockets. */
  napi_value child = wrap_reserved(env, pair[1], 6, -1, 1);
  if (!child) { close_owned(handle(env, channel, 2)); return NULL; }
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "channel", channel); napi_set_named_property(env, result, "child", child);
  number(env, result, "uid", getuid()); number(env, result, "gid", getgid()); return result;
#else
  return fail(env);
#endif
}
static napi_value control_child_fd(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  owned_fd *child = argc == 1 ? handle(env, args[0], 6) : NULL;
  if (!child) return fail(env);
  napi_value result; napi_create_int32(env, child->fd, &result); return result;
}
static napi_value stdout_pair(napi_env env, napi_callback_info info) {
  (void)info;
#ifdef __linux__
  int pair[2], enabled = 1;
  if (!unprivileged() || !reserve(2)) return fail(env);
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) != 0) { atomic_fetch_sub(&open_count, 2); return fail(env); }
  /* Only the receiver is nonblocking. SO_PASSCRED precedes any possible exec. */
  int flags = fcntl(pair[0], F_GETFL);
  if (flags < 0 || fcntl(pair[0], F_SETFL, flags | O_NONBLOCK) != 0
      || setsockopt(pair[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) != 0) {
    close(pair[0]); close(pair[1]); atomic_fetch_sub(&open_count, 2); return fail(env);
  }
  napi_value result, receiver = wrap_reserved(env, pair[0], 3, -1, 1);
  if (!receiver) { close(pair[1]); atomic_fetch_sub(&open_count, 1); return NULL; }
  napi_value writer = wrap_reserved(env, pair[1], 4, -1, 1);
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
  int state = birth_state(birth);
  if (state < 0) return fail(env);
  napi_value result; napi_get_boolean(env, state, &result); return result;
#else
  (void)info; return fail(env);
#endif
}
/* One retained birth copy, not an arbitrary descriptor list or source grant.
 * Positive bytes remain physical fact even if the child exits immediately
 * afterward. Caller owns the original deadline and any remaining byte writes. */
static napi_value control_send_child_birth(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 3, length; napi_value args[3]; void *bytes; bool is_buffer;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  owned_fd *channel = argc == 3 ? handle(env, args[0], 2) : NULL;
  owned_fd *birth = argc == 3 ? handle(env, args[2], 5) : NULL;
  if (!channel || !channel->private_control || !birth || !unprivileged()
      || napi_is_buffer(env, args[1], &is_buffer) != napi_ok || !is_buffer
      || napi_get_buffer_info(env, args[1], &bytes, &length) != napi_ok
      || length < 1 || length > 8192 || birth_state(birth) != 1) return fail(env);
  union { struct cmsghdr alignment; char data[CMSG_SPACE(sizeof(int))]; } control;
  memset(&control, 0, sizeof(control));
  struct iovec vector = {bytes, length}; struct msghdr message = {0};
  message.msg_iov = &vector; message.msg_iovlen = 1;
  message.msg_control = control.data; message.msg_controllen = sizeof(control.data);
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN(sizeof(int)); memcpy(CMSG_DATA(header), &birth->fd, sizeof(int));
  ssize_t written = sendmsg(channel->fd, &message, MSG_DONTWAIT | MSG_NOSIGNAL);
  if (written < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) written = 0;
    else { close_owned(channel); return fail(env); }
  }
  napi_value result; napi_create_int64(env, written, &result); return result;
#else
  (void)info; return fail(env);
#endif
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"inheritedControl", NULL, inherited_control, NULL, NULL, NULL, napi_default, NULL},
    {"inheritedControlCurrent", NULL, inherited_control_current, NULL, NULL, NULL, napi_default, NULL},
    {"controlSendChildBirth", NULL, control_send_child_birth, NULL, NULL, NULL, napi_default, NULL},
    {"controlPair", NULL, control_pair, NULL, NULL, NULL, napi_default, NULL},
    {"controlChildFd", NULL, control_child_fd, NULL, NULL, NULL, napi_default, NULL},
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
