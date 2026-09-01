#!/bin/sh
set -eu

runtime_dir=/tmp/cloudflared
mkdir -p "$runtime_dir"

shutdown() {
  for pidfile in "$runtime_dir"/*.pid; do
    [ -f "$pidfile" ] || continue
    kill "$(cat "$pidfile")" 2>/dev/null || true
  done
  wait || true
}
trap shutdown INT TERM EXIT

while :; do
  for token_file in /tokens/*.token; do
    [ -f "$token_file" ] || continue
    tunnel_id=$(basename "$token_file" .token)
    pidfile="$runtime_dir/$tunnel_id.pid"
    logfile="$runtime_dir/$tunnel_id.log"

    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      continue
    fi

    rm -f "$pidfile"
    cloudflared --no-autoupdate tunnel run --token-file "$token_file" >>"$logfile" 2>&1 &
    echo $! >"$pidfile"
  done
  for pidfile in "$runtime_dir"/*.pid; do
    [ -f "$pidfile" ] || continue
    token_file="/tokens/$(basename "$pidfile" .pid).token"
    if [ ! -f "$token_file" ]; then
      kill "$(cat "$pidfile")" 2>/dev/null || true
      rm -f "$pidfile"
      continue
    fi
    kill -0 "$(cat "$pidfile")" 2>/dev/null || rm -f "$pidfile"
  done
  sleep 5
done
