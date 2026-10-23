#!/bin/sh
# Starts Chromium behind the replay proxy and exposes CDP on 0.0.0.0:9223 (Chromium itself only
# listens on localhost).
set -e
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &
exec chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --proxy-server="$RR_PROXY" --ignore-certificate-errors --disable-quic \
  --disable-background-networking --disable-component-update --disable-sync \
  --remote-debugging-port=9222 --user-data-dir=/tmp/profile about:blank
