FROM alpine:3.22

ARG COPILOT_VERSION=1.0.112

LABEL org.opencontainers.image.source="https://github.com/justjoseorg/copilot-cli-unraid" \
    org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache \
        bash \
        ca-certificates \
        curl \
        dbus \
        github-cli \
        git \
        gnome-keyring \
        libsecret \
        nodejs \
        npm \
        python3 \
        py3-pip \
        setpriv \
        tini \
        tmux \
        ttyd \
    && npm install --global "@github/copilot@${COPILOT_VERSION}" \
    && npm cache clean --force \
    && rm -f /etc/machine-id /var/lib/dbus/machine-id

COPY rootfs/usr/local/bin/apk /usr/local/bin/apk
COPY rootfs/usr/local/bin/container-init /usr/local/bin/container-init
COPY rootfs/usr/local/bin/start-keyring /usr/local/bin/start-keyring
COPY rootfs/usr/local/bin/start-terminal /usr/local/bin/start-terminal
COPY rootfs/usr/local/bin/terminal-ui.mjs /usr/local/bin/terminal-ui.mjs
COPY rootfs/usr/local/bin/attach-terminal /usr/local/bin/attach-terminal
COPY rootfs/usr/local/lib/terminal-sessions.mjs /usr/local/lib/terminal-sessions.mjs
COPY rootfs/usr/local/share/copilot-terminal /usr/local/share/copilot-terminal
COPY rootfs/etc/profile.d/copilot-tools.sh /etc/profile.d/copilot-tools.sh

RUN chmod 0755 /usr/local/bin/apk /usr/local/bin/container-init /usr/local/bin/start-keyring /usr/local/bin/start-terminal /usr/local/bin/attach-terminal \
    && mkdir -p /config /workspace /Storage/repos

ENV HOME=/config \
    COPILOT_HOME=/config/.copilot \
    COPILOT_CACHE_HOME=/config/cache/copilot \
    COPILOT_AUTO_UPDATE=false \
    GH_CONFIG_DIR=/config/gh \
    XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/config/.local/share \
    XDG_CACHE_HOME=/config/cache \
    XDG_RUNTIME_DIR=/run/copilot \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/copilot/bus \
    GNOME_KEYRING_CONTROL=/run/copilot/keyring \
    VIRTUAL_ENV=/config/python \
    NPM_CONFIG_PREFIX=/config/npm \
    NPM_CONFIG_CACHE=/config/cache/npm \
    PIP_CACHE_DIR=/config/cache/pip \
    TERMINAL_IDLE_TIMEOUT=86400 \
    TERMINAL_UNUSED_TIMEOUT=60 \
    PATH=/config/python/bin:/config/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 \
    COLORTERM=truecolor \
    TERM=xterm-256color

WORKDIR /Storage/repos
VOLUME ["/config", "/Storage/repos"]
EXPOSE 7681

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/container-init"]
CMD ["/usr/local/bin/start-terminal"]
