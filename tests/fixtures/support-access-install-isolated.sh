#!/usr/bin/env bash
set -euo pipefail

# Run only inside an unshared user and mount namespace. Never write host /etc.
helper="$1"
active_key="$2"
candidate_key="$3"
fixture_dir="$(mktemp -d /tmp/matrix-support-fixture.XXXXXX)"
trap 'rm -rf -- "$fixture_dir"' EXIT

mount -t tmpfs tmpfs /etc
mount -t tmpfs tmpfs /var
chmod 0755 /etc /var
mkdir -p /etc/matrix/support /etc/sudoers.d /var/lib "$fixture_dir/bin"
chmod 0755 /etc/matrix /etc/sudoers.d /var/lib
chmod 0700 /etc/matrix/support
printf 'root:x:0:0:root:/root:/bin/bash\n' >/etc/passwd
printf 'root:x:0:\n' >/etc/group
printf 'root:*:20000:0:99999:7:::\n' >/etc/shadow
printf 'root:*::\n' >/etc/gshadow
printf 'passwd: files\ngroup: files\nshadow: files\n' >/etc/nsswitch.conf
install -o root -g root -m 0644 "$active_key" /etc/matrix/support/public-key

# Account database mutations and sshd validation are faked inside the mount
# namespace. Key, ownership, sudoers, and install operations run for real.
cat >"$fixture_dir/bin/useradd" <<'EOF'
#!/bin/sh
printf 'matrix-support:x:123:123::/var/lib/matrix-support:/bin/bash\n' >>/etc/passwd
printf 'matrix-support:x:123:\n' >>/etc/group
printf 'matrix-support:!:20000:0:99999:7:::\n' >>/etc/shadow
printf 'matrix-support:*::\n' >>/etc/gshadow
EOF
printf '#!/bin/sh\nprintf "locked\\n" >"%s/locked"\n' "$fixture_dir" >"$fixture_dir/bin/usermod"
printf '#!/bin/sh\nexit 0\n' >"$fixture_dir/bin/sshd"
chmod 0755 "$fixture_dir/bin/useradd" "$fixture_dir/bin/usermod" "$fixture_dir/bin/sshd"
export PATH="$fixture_dir/bin:/usr/sbin:/usr/bin:/sbin:/bin"

bash "$helper" install >/dev/null
bash "$helper" install >/dev/null
[ "$(id -u matrix-support)" = 123 ]
[ "$(id -gn matrix-support)" = matrix-support ]
[ -f "$fixture_dir/locked" ]
[ "$(stat -c '%u:%g:%a' /var/lib/matrix-support)" = 0:0:755 ]
[ "$(stat -c '%u:%g:%a' /var/lib/matrix-support/.ssh)" = 0:0:755 ]
[ "$(stat -c '%u:%g:%a' /var/lib/matrix-support/.ssh/authorized_keys)" = 0:0:644 ]
[ "$(stat -c '%u:%g:%a' /etc/sudoers.d/matrix-support)" = 0:0:440 ]
cmp -s "$active_key" /var/lib/matrix-support/.ssh/authorized_keys
visudo -cf /etc/sudoers.d/matrix-support >/dev/null

# An unexpected existing key must remain untouched on a failed rerun.
install -o root -g root -m 0644 "$candidate_key" /var/lib/matrix-support/.ssh/authorized_keys
if bash "$helper" install >/dev/null 2>&1; then
  echo 'install accepted an unexpected existing support key' >&2
  exit 1
fi
cmp -s "$candidate_key" /var/lib/matrix-support/.ssh/authorized_keys
install -o root -g root -m 0644 "$active_key" /var/lib/matrix-support/.ssh/authorized_keys

# Rotation keeps both keys until a candidate-only login can be checked.
install -o root -g root -m 0644 "$candidate_key" /etc/matrix/support/candidate-public-key
bash "$helper" stage-rotation >/dev/null
cat "$active_key" "$candidate_key" >"$fixture_dir/expected-staged"
cmp -s "$fixture_dir/expected-staged" /var/lib/matrix-support/.ssh/authorized_keys
if bash "$helper" finalize-rotation SHA256:wrong >/dev/null 2>&1; then
  echo 'rotation accepted a wrong fingerprint' >&2
  exit 1
fi
cmp -s "$fixture_dir/expected-staged" /var/lib/matrix-support/.ssh/authorized_keys
read -r _bits fingerprint _rest <<< "$(ssh-keygen -lf "$candidate_key")"
bash "$helper" finalize-rotation "$fingerprint" >/dev/null
cmp -s "$candidate_key" /etc/matrix/support/public-key
cmp -s "$candidate_key" /var/lib/matrix-support/.ssh/authorized_keys
[ ! -e /etc/matrix/support/candidate-public-key ]
bash "$helper" install >/dev/null
