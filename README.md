# Copilot CLI Web Terminal for Unraid

An Alpine Linux browser terminal with [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli) and [GitHub CLI](https://cli.github.com/). It uses [ttyd](https://github.com/tsl0922/ttyd), so the terminal supports ANSI colors, interactive applications, and browser copy/paste.

## Unraid installation

The Unraid template lives in the separate
[unraid-templates repository](https://github.com/justjoseorg/unraid-templates),
with installation instructions there.

Set `/config` to an Appdata directory and `/workspace` to the project directory
you want to work in. The image workflow publishes to GitHub Container Registry as:

```text
ghcr.io/justjoseorg/copilot-cli-unraid:latest
```

Set a strong **Web terminal password** in the template, then click **WebUI**. Authenticate with the configured web terminal username (default: `terminal`) and password. From the terminal, authenticate GitHub:

```sh
copilot login --device-code
copilot
```

For repository operations with GitHub CLI, also run `gh auth login --web`.
A GitHub account with Copilot CLI access is required. No account token is baked
into the image.

## Docker usage

```sh
docker run -d --name copilot-cli \
  -p 7681:7681 \
  -v /path/to/copilot-cli-config:/config \
  -v /path/to/projects:/workspace \
  -e WEB_TERMINAL_PASSWORD='use-a-strong-password' \
  ghcr.io/justjoseorg/copilot-cli-unraid:latest

# Open http://localhost:7681 and sign in as terminal.
```

Use a private environment file (`--env-file`) instead of typing the password
into shell history on a shared host.

## Persistent packages

Use `apk add` normally from the browser terminal:

```sh
apk add python3 py3-pip
```

The image records explicitly requested packages in `/config/apk-packages` and
reinstalls them when the container starts. Dependencies are resolved afresh
rather than pinned to the previous image. `apk del` also updates that list.
Use `apk add ...` / `apk del ...`, putting options after the subcommand.
Virtual build-only packages (`apk add --virtual`) are not supported for
persistence. Do not invoke `/sbin/apk` directly, as it bypasses this behavior.
Restoring packages requires access to the Alpine repositories.

Authentication, Copilot settings, GitHub CLI settings, and caches are also stored under `/config`.

The container opens in `/workspace`. Keep projects in that mounted directory,
not the disposable container filesystem. It does not mount the Docker socket
or the host filesystem by default.

## Security

The browser terminal has root access to the container, so it requires HTTP basic authentication and has no default password. Use a strong unique password, do not expose port `7681` directly to the internet, and access it through a VPN or a reverse proxy with TLS when connecting outside the local network.

## Publishing

The GitHub Actions workflow checks CLI startup, web authentication, and
cross-container configuration/workspace/package persistence before building
`linux/amd64` and `linux/arm64` images. It publishes to GHCR when `main` is
updated or a `v*` tag is pushed. Pull requests run the smoke test without
publishing.

The default Copilot version is pinned in `Dockerfile`. Change `COPILOT_VERSION`
there to update published builds, or supply `--build-arg COPILOT_VERSION=...`
for a local build. Container self-updates are disabled; update the image instead.

Make the package public in GitHub package settings before importing the template
in Unraid. Repository visibility does not automatically make a GHCR package
public.

## Local checks

```sh
docker build -t copilot-cli:test .
sh tests/smoke.sh copilot-cli:test

# Podman is also supported:
CONTAINER_RUNTIME=podman sh tests/smoke.sh localhost/copilot-cli:test
```

## Trademark notice

The Copilot logo is a GitHub trademark and is used only to identify the software this container packages. This project is not affiliated with or endorsed by GitHub.

The template and its logo are maintained in the separate template repository.
