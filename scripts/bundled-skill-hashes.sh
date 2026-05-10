# Shared helpers for updating unmodified bundled directory skills in existing
# Matrix homes. Add only hashes from previously shipped bundled skill versions.

hash_file() {
  sha256sum "$1" | awk '{print $1}'
}

is_known_bundled_skill_hash() {
  local skill_name="$1"
  local hash="$2"
  case "$skill_name:$hash" in
    integrations:baceb1ffe57e46ba95d21b310cb0a49917bd29b8cd18ca53eb2784986c0f17ea|\
integrations:3ead6fd9db4c992778a1ea3aad13a0cd56f8aa33b608bf8a80bc721edc7131ee)
      return 0
      ;;
  esac
  return 1
}
