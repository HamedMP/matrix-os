# Exact predecessor functions from 710ffaf59b6df1c1e02ef7feb1a42fee717fab3d.
# Kept as executable fixture so shallow CI checkouts test the first upgrade too.
install_host_bin_payload() {
  local source_dir="$1" source name incoming destination protected_helper
  [ -d "$source_dir" ] && [ ! -L "$source_dir" ] || return 1
  sudo install -d -o root -g root -m 0755 "$BIN_DIR" || return 1
  while IFS= read -r -d '' source; do
    name="${source##*/}"
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || return 1
    incoming="$BIN_DIR/.${name}.incoming.$$"
    destination="$BIN_DIR/$name"
    if [ -L "$destination" ] || { [ -e "$destination" ] && [ ! -f "$destination" ]; }; then
      log "ERROR: invalid installed host-bin destination for $name"
      return 1
    fi
    sudo rm -f -- "$incoming" || return 1
    if ! sudo install -o root -g root -m 0755 "$source" "$incoming" \
      || ! sudo mv -Tf "$incoming" "$destination"; then
      sudo rm -f -- "$incoming"
      return 1
    fi
  done < <(find "$source_dir" -mindepth 1 -maxdepth 1 -type f -print0)
  protected_helper="$source_dir/matrix-postgres-start"
  if [ -f "$protected_helper" ] && [ ! -L "$protected_helper" ]; then
    sudo install -d -o root -g root -m 0755 /usr/local/libexec || return 1
    incoming="/usr/local/libexec/.matrix-postgres-start.incoming.$$"
    destination=/usr/local/libexec/matrix-postgres-start
    if [ -L "$destination" ] || { [ -e "$destination" ] && [ ! -f "$destination" ]; }; then
      log "ERROR: invalid protected PostgreSQL helper destination"
      return 1
    fi
    sudo rm -f -- "$incoming" || return 1
    if ! sudo install -o root -g root -m 0755 "$source_dir/matrix-postgres-start" "$incoming" \
      || ! sudo mv -Tf "$incoming" "$destination"; then
      sudo rm -f -- "$incoming"
      return 1
    fi
  fi
  protected_helper="$source_dir/matrix-support-access"
  if [ -f "$protected_helper" ] && [ ! -L "$protected_helper" ]; then
    sudo install -d -o root -g root -m 0755 /usr/local/libexec || return 1
    incoming="/usr/local/libexec/.matrix-support-access.incoming.$$"
    destination=/usr/local/libexec/matrix-support-access
    if [ -L "$destination" ] || { [ -e "$destination" ] && [ ! -f "$destination" ]; }; then
      log "ERROR: invalid protected support helper destination"
      return 1
    fi
    sudo rm -f -- "$incoming" || return 1
    if ! sudo install -o root -g root -m 0755 "$source_dir/matrix-support-access" "$incoming" \
      || ! sudo mv -Tf "$incoming" "$destination"; then
      sudo rm -f -- "$incoming"
      return 1
    fi
    sudo chmod 0644 "$BIN_DIR/matrix-support-access" || return 1
  fi
}

commit_release_metadata() {
  local rollback_incoming
  [ -n "$staged_release_metadata" ] && [ -f "$staged_release_metadata" ] && [ ! -L "$staged_release_metadata" ] || return 1
  rollback_incoming="$RELEASE_ROLLBACK_FILE.incoming.$$"
  sudo rm -f -- "$rollback_incoming" || return 1
  if [ -f "$RELEASE_FILE" ] && [ ! -L "$RELEASE_FILE" ]; then
    if ! sudo install -o root -g matrix -m 0644 "$RELEASE_FILE" "$rollback_incoming" \
      || ! sudo mv -Tf "$rollback_incoming" "$RELEASE_ROLLBACK_FILE"; then
      sudo rm -f -- "$rollback_incoming"
      return 1
    fi
  else
    sudo rm -f -- "$RELEASE_ROLLBACK_FILE" || return 1
  fi
  sudo mv -Tf "$staged_release_metadata" "$RELEASE_FILE" || return 1
  staged_release_metadata=""
}

restart_sync_agent_after_update() {
  log "Restarting sync agent to load updated agent code"
  sudo systemctl restart --no-block matrix-sync-agent.service || log "WARN: failed to restart matrix-sync-agent.service"
}
