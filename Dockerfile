FROM alpine:3.22

ARG COPILOT_VERSION=1.0.112

LABEL org.opencontainers.image.source="https://github.com/justjoseorg/copilot-cli-unraid" \
    org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache \
        bash \
        ca-certificates \
        curl \
        github-cli \
        git \
        nodejs \
        npm \
        ttyd \
    && npm install --global "@github/copilot@${COPILOT_VERSION}" \
    && npm cache clean --force

COPY rootfs/usr/local/bin/apk /usr/local/bin/apk
COPY rootfs/usr/local/bin/container-init /usr/local/bin/container-init
COPY rootfs/usr/local/bin/start-terminal /usr/local/bin/start-terminal

RUN chmod 0755 /usr/local/bin/apk /usr/local/bin/container-init /usr/local/bin/start-terminal \
    && mkdir -p /config /workspace

ENV HOME=/config \
    COPILOT_HOME=/config/.copilot \
    COPILOT_CACHE_HOME=/config/cache/copilot \
    COPILOT_AUTO_UPDATE=false \
    GH_CONFIG_DIR=/config/gh \
    XDG_CONFIG_HOME=/config \
    XDG_CACHE_HOME=/config/cache \
    LANG=C.UTF-8 \
    COLORTERM=truecolor \
    TERM=xterm-256color

WORKDIR /workspace
VOLUME ["/config", "/workspace"]
EXPOSE 7681

ENTRYPOINT ["/usr/local/bin/container-init"]
CMD ["/usr/local/bin/start-terminal"]
