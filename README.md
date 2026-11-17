# Copilot CLI Web Terminal for Unraid

An Alpine Linux browser terminal with [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli), [GitHub CLI](https://cli.github.com/), Node.js and Python. A lightweight sidebar wraps [ttyd](https://github.com/tsl0922/ttyd), preserving ANSI colors, interactive applications, and browser copy/paste.

## Unraid installation

The Unraid template lives in the separate
[unraid-templates repository](https://github.com/justjoseorg/unraid-templates),
with installation instructions there.

Set `/config` to an Appdata directory. The template maps
`/mnt/user/Storage/repos` to `/Storage/repos`, the default directory for each
new terminal connection. Only this repositories folder is exposed, not the
rest of Storage. The image workflow publishes to GitHub Container Registry as:

```text
ghcr.io/justjoseorg/copilot-cli-unraid:latest
```

The workspace includes a hidden `.copilot-workspace` keep-file so host cleanup
does not unlink an empty bind-mounted repositories folder.

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
  -v /mnt/user/Storage/repos:/Storage/repos \
  -e WEB_TERMINAL_USER='terminal' \
  -e WEB_TERMINAL_PASSWORD='use-a-strong-password' \
  ghcr.io/justjoseorg/copilot-cli-unraid:latest

# Open http://localhost:7681 and sign in as terminal.
```

Use a private environment file (`--env-file`) instead of typing the password
into shell history on a shared host.

Both web terminal credentials are editable in the Unraid template. They control
browser access, not your GitHub account or the root Linux user.

## Multiple terminals, one shared environment

Use **New terminal** in the left sidebar to run additional tasks. Select a
terminal to switch to it, **Rename** to label it, or its **x** button to close it.
Switching keeps the shell and its running task alive.

All terminals use the same Copilot/GitHub sign-in, mounted files, permissions
and installed tools. The sidebar is shared across devices. Selecting the same
terminal from another device attaches to the same shell and running CLI
process, including its current conversation.

Each new browser page initially creates a fresh shell in `/Storage/repos`.
You can then switch to an existing terminal. Untouched shells are automatically
discarded after **60 seconds**, so opening another device does not leave empty
terminals behind. Once you type, paste, rename a terminal or run a job, it is
kept for **24 hours after activity**.

The editable minutes dropdown beside **Unused shells clear automatically**
changes the unused-shell grace period immediately for all devices. Choose a
preset or type any nonnegative number of minutes, including fractions; **0**
disables unused-shell cleanup. The value is saved in
`/config/terminal-settings.json` and survives container updates. Once saved,
it overrides `TERMINAL_UNUSED_TIMEOUT`; delete that file and restart to use
the template/environment default again. Previously used shells still use
`TERMINAL_IDLE_TIMEOUT`, and running jobs remain protected.

Foreground and background jobs prevent automatic cleanup. The retention clock
restarts after a job finishes; inspection failures conservatively keep shells.
These defaults are editable through `TERMINAL_UNUSED_TIMEOUT` and
`TERMINAL_IDLE_TIMEOUT`, in seconds; `0` disables the corresponding expiry.

Closing or reloading a browser page only detaches from its tmux-backed shells.
The **x** button explicitly closes that terminal on all devices and can stop
its programs. Shells survive browser disconnections, not container restarts;
restart/update the container only when its running tasks can be interrupted.

Use **Hide** at the top of the sidebar to give the terminal more space.
Click the circular **>_** button in the header to bring the sidebar back.
Hiding or showing the sidebar does not reconnect or close the active terminal.

## Updates on Unraid

Every push to `main` runs the tests and publishes a new
`ghcr.io/justjoseorg/copilot-cli-unraid:latest` image if they pass. Keep the
Unraid container's **Repository** set to that exact tag, not a commit tag or
digest. Changes on other branches become updates after merging into `main`;
editing the separate XML template alone does not rebuild the image.

After the **Publish container image** workflow succeeds, use **Docker > Check
for Updates** on Unraid, then apply the `copilot-cli` update. The workflow
summary includes the published tags and digest. Unraid checks the registry;
GitHub does not connect to your Unraid host.

For unattended installation, install **CA Auto Update Applications** from
Unraid's Apps tab, enable it for `copilot-cli`, and choose an update schedule.
This is a host-side setting, not something the XML template can enable.
Schedule updates for a time when no terminal work is running: applying an
update restarts the container and ends all its shells and jobs. Retain the
existing `/config` and repositories mappings to preserve files and sign-in.

## Persistent system keyring

The image starts a private D-Bus session and GNOME Keyring Secret Service
before accepting connections. Both browser shells and `docker exec` commands
inherit the same bus address. The encrypted keyring is stored in
`/config/.local/share/keyrings` and unlocked on subsequent starts.

By default, startup generates a random unlock secret at
`/config/.keyring-password` with mode `0600`. Back up this file together with
the keyring directory. Startup refuses to replace a lost unlock secret or
silently continue with an unusable keyring.

The default unlock secret lives on the same persistent volume, so protect
the entire `/config` directory and its backups as credentials. This is not
protection against someone who can read that whole volume or control the
container. To keep the unlock secret separately, mount a private secret file
and set `KEYRING_PASSWORD_FILE` to its container path from the first start,
or supply the existing unlock secret. Do not change the secret independently
of the encrypted keyring. Changing the web terminal password does not rekey it.

No privileged mode or extra container capabilities are required. Container
memory-locking limits can still restrict protection against secrets being
swapped out.

Existing authentication files are not changed or migrated. If you previously
enabled `storeTokenPlaintext`, disable that setting and sign in again after
updating to use the keyring.

## Persistent Python, Node.js and packages

Python and Node.js are included by default. Every terminal automatically uses
the shared Python virtual environment at `/config/python`. Install Python
packages normally:

```sh
pip install requests
python your_script.py
```

The virtual environment, including packages and command-line scripts, survives
container recreation and image updates while `/config` is retained. Global npm
tools are also persistent, under `/config/npm`:

```sh
npm install --global typescript
```

Project-local dependencies also persist when the project is in `/Storage/repos`.
Python environments and compiled Python/Node modules may need rebuilding after
an incompatible interpreter or CPU-architecture change. These directories are
shared by all terminals; use a project-specific environment when isolation is needed.

Use `apk add` normally from the browser terminal:

```sh
apk add build-base
```

The image records explicitly requested packages in `/config/apk-packages` and
reinstalls them when the container starts. Dependencies are resolved afresh
rather than pinned to the previous image. `apk del` also updates that list.
Use `apk add ...` / `apk del ...`, putting options after the subcommand.
Virtual build-only packages (`apk add --virtual`) are not supported for
persistence. Do not invoke `/sbin/apk` directly, as it bypasses this behavior.
Restoring packages requires access to the Alpine repositories.

Authentication, Copilot settings, GitHub CLI settings, and caches are also stored under `/config`.

The container opens in `/Storage/repos`. Keep projects in that mounted directory,
not the disposable container filesystem. It does not mount the Docker socket
or the host filesystem by default.

## Optional Intel/AMD GPU access

Add `--device /dev/dri:/dev/dri` to the Docker command to expose an Intel/AMD
GPU. The Unraid template includes an optional **GPU device** entry for this.
Remove that entry to disable GPU access or install on a host without `/dev/dri`;
do not leave the device value blank. Privileged mode is not needed.

This provides device access, not an installed GPU compute framework. Install
the userspace libraries required by your specific VAAPI, Vulkan, OpenCL or
other workload. Copilot CLI itself does not need or use the GPU.

## Security

The browser terminal has root access to the container, so it requires HTTP basic authentication and has no default password. Use a strong unique password, do not expose port `7681` directly to the internet, and access it through a VPN or a reverse proxy with TLS when connecting outside the local network.

## Publishing

The GitHub Actions workflow checks the authenticated HTTP/WebSocket proxy,
CLI startup, web authentication, and cross-container
configuration/workspace/keyring/APK/pip/npm persistence before building
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
node --test tests/*.test.mjs
sh tests/smoke.sh copilot-cli:test

# Podman is also supported:
CONTAINER_RUNTIME=podman sh tests/smoke.sh localhost/copilot-cli:test
```

## Trademark notice

The Copilot logo is a GitHub trademark and is used only to identify the software this container packages. This project is not affiliated with or endorsed by GitHub.

The template and its logo are maintained in the separate template repository.
