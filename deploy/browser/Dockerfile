# Browser for the replay Pod: Chromium behind the replay proxy, CDP exposed on 9223.
# Page clocks are shifted to the recording time by the replay service (see src/replay/clock.ts);
# libfaketime was tried here and makes Chromium's CDP handshake hang.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium socat fonts-noto-cjk ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV RR_PROXY=http://127.0.0.1:8899
EXPOSE 9223
ENTRYPOINT ["/entrypoint.sh"]
