# LifeLoop Hub — Container Build & Deploy Guide

This document covers building and deploying the LifeLoop Hub Docker image,
including auto-updates in production. The image is multi-architecture
(`linux/amd64` for x86 servers / dev laptops, `linux/arm64` for the
Raspberry Pi 5 that runs the live `loopedeggs.ca` hub).

---

## What's in the box

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage Node 20 Alpine image, non-root user, `tini` PID 1, baked-in `/api/health` healthcheck. |
| `.dockerignore` | Keeps secrets, `node_modules`, `data/`, and docs out of the build context. |
| `docker-compose.yml` | Two services: `lifeloop` (the app) and `watchtower` (auto-updater). Persistent volume for `data/`. |
| `scripts/build.ps1` / `scripts/build.sh` | Build the image (single-arch local, or multi-arch buildx). |
| `scripts/deploy.ps1` / `scripts/deploy.sh` | Pull the published image and roll the stack. |
| `.github/workflows/docker-publish.yml` | CI: builds & pushes multi-arch images to GHCR on every commit to `main` and on `vX.Y.Z` tags. |

---

## Prerequisites

### Windows (development / build host)

1. Install **Docker Desktop for Windows** — <https://www.docker.com/products/docker-desktop/>.
   - Enable the WSL2 backend during install (default).
   - In **Settings → General** make sure *"Use the WSL 2 based engine"* is on.
2. Install **Git for Windows** — <https://git-scm.com/download/win>.
3. PowerShell 5.1 or PowerShell 7+ (built into Windows 10/11).
4. Confirm Docker is healthy:
   ```powershell
   docker version
   docker buildx version
   ```

### Linux / Raspberry Pi (deployment host)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out / back in
docker compose version
```

---

## 1. Build the image (Windows)

From the repo root in PowerShell:

```powershell
# Fast local build, tag = lifeloop-hub:dev
.\scripts\build.ps1

# Tagged build
.\scripts\build.ps1 -Tag v1.0.0

# Multi-arch build & push to GHCR (requires `docker login ghcr.io` first)
.\scripts\build.ps1 -MultiArch -Push `
    -Registry ghcr.io/angads22/loopedeggs-serverside `
    -Tag v1.0.0
```

Equivalent on Linux/macOS:

```bash
./scripts/build.sh
./scripts/build.sh --tag v1.0.0
./scripts/build.sh --multi-arch --push \
    --registry ghcr.io/angads22/loopedeggs-serverside \
    --tag v1.0.0
```

### What the script does

- Sets OCI labels (`org.opencontainers.image.version`, `revision`, `created`).
- For `-MultiArch`, creates a dedicated `lifeloop-builder` buildx builder
  (the default Docker Desktop builder cannot produce multi-arch images).
- Single-arch builds load straight into the local Docker engine so you can
  `docker run` immediately. Multi-arch images must be `--push`ed; without
  `-Push` the script writes them to `lifeloop-hub.oci.tar`.

---

## 2. Run locally (Windows or Linux)

### Quick check (no compose)

```powershell
docker run --rm -p 3000:3000 -v lifeloop-data:/app/data lifeloop-hub:dev
```

Then open <http://localhost:3000> and <http://localhost:3000/api/health>.

### With compose (recommended)

```powershell
# Use a locally-built image
$env:LIFELOOP_IMAGE = "lifeloop-hub:dev"
docker compose up -d lifeloop      # without watchtower

# Or pull from the registry:
docker compose pull
docker compose up -d
```

```bash
LIFELOOP_IMAGE=lifeloop-hub:dev docker compose up -d lifeloop
```

`docker compose ps` should show `lifeloop` as `healthy` after ~15 s.

### Configuration

Compose reads variables from `.env` if present (see `.env.example`):

| Variable | Default | Notes |
| --- | --- | --- |
| `LIFELOOP_IMAGE` | `ghcr.io/angads22/loopedeggs-serverside:latest` | Pin a tag or digest in production. |
| `LIFELOOP_PORT` | `3000` | Host port; container always listens on 3000. |
| `ALLOWED_ORIGINS` | `https://loopedeggs.ca,https://www.loopedeggs.ca` | CSV of CORS origins. |

Persistent state lives in the named volume `lifeloop-data` (`/app/data`
inside the container, holds `contacts.json`).

---

## 3. Deploy to the Raspberry Pi (production)

On the Pi, with a fresh checkout of this repo:

```bash
# First time — log in so the Pi can pull from GHCR
echo "$GHCR_TOKEN" | docker login ghcr.io -u <your-gh-username> --password-stdin

# Roll the stack
./scripts/deploy.sh                  # latest
./scripts/deploy.sh --tag v1.0.0     # pinned
```

The deploy script:
1. Pulls the image for the requested tag.
2. Runs `docker compose up -d lifeloop watchtower`.
3. Polls `docker inspect` until the healthcheck reports `healthy` (60 s budget).

### Behind nginx + Let's Encrypt

The existing `nginx/loopedeggs.conf` and `setup.sh` already terminate TLS
on the host and proxy to `127.0.0.1:3000`. The container publishes the
same port, so nothing in the nginx config changes — just stop the old
systemd unit before bringing up compose:

```bash
sudo systemctl disable --now lifeloop.service
./scripts/deploy.sh
```

If you'd rather front the container with nginx in another container, add
an `nginx` service to the compose file and remove the host port mapping
from `lifeloop`.

---

## 4. Auto-updates

Auto-updates are handled by **Watchtower** (`containrrr/watchtower`),
included as a service in `docker-compose.yml`.

How it works:
- CI publishes a new image to `ghcr.io/angads22/loopedeggs-serverside:latest`
  (and a `vX.Y.Z` tag) on every push to `main`.
- Watchtower polls the registry every **5 minutes**.
- When the digest of the running tag changes, Watchtower:
  1. Pulls the new image.
  2. Stops the `lifeloop` container with `SIGTERM` (handled by `tini` →
     graceful Express + WebSocket shutdown).
  3. Recreates the container with the new image, preserving the
     `lifeloop-data` volume so contacts/state survive.
  4. Removes the old image (`WATCHTOWER_CLEANUP=true`).

Only containers with `com.centurylinklabs.watchtower.enable=true` are
touched, so Watchtower will not update arbitrary containers on the host.

### Force an update right now

```bash
docker compose pull lifeloop && docker compose up -d lifeloop
# or:
docker exec lifeloop-watchtower /watchtower --run-once lifeloop
```

### Pin a specific version (and stop chasing `latest`)

Set `LIFELOOP_IMAGE` to a digest or semver tag in `.env` and Watchtower
will keep the same digest pinned:

```env
LIFELOOP_IMAGE=ghcr.io/angads22/loopedeggs-serverside:v1.0.0
```

### Disable auto-updates

```bash
docker compose stop watchtower
docker compose rm -f watchtower
# or deploy without it:
./scripts/deploy.sh --no-watchtower
```

### Private images

If the GHCR package is private, mount a Docker config that has the
credentials. The compose file already mounts `~/.docker` into Watchtower
read-only, so a single `docker login ghcr.io` on the host is enough.

---

## 5. CI/CD

`.github/workflows/docker-publish.yml`:

| Trigger | Tags produced |
| --- | --- |
| Push to `main` | `latest`, `sha-<short>`, `main` |
| Push of `vX.Y.Z` tag | `vX.Y.Z`, `X.Y`, `X`, `latest` |
| Pull request | (build only — not pushed) |
| `workflow_dispatch` | optional `tag` input |

The workflow uses `docker/build-push-action` with QEMU + Buildx for
multi-arch (`linux/amd64,linux/arm64`), GitHub Actions cache, and emits
an SBOM and provenance attestation.

The first time the image is published you may need to mark the GHCR
package as public (or grant the Pi a PAT) — go to
**github.com/users/<you>/packages/container/loopedeggs-serverside →
Package settings → Change visibility**.

---

## 6. Operations cheat-sheet

```bash
# Logs
docker compose logs -f lifeloop
docker compose logs -f watchtower

# Status / health
docker compose ps
docker inspect --format '{{.State.Health.Status}}' lifeloop

# Restart only the app (e.g. after .env change)
docker compose up -d --force-recreate lifeloop

# Shell into the container (read-only filesystem mostly, /app/data is RW)
docker exec -it lifeloop sh

# Back up persistent data
docker run --rm -v lifeloop-data:/data -v "$PWD":/backup alpine \
    tar czf /backup/lifeloop-data-$(date +%F).tar.gz -C /data .

# Restore
docker run --rm -v lifeloop-data:/data -v "$PWD":/backup alpine \
    sh -c 'cd /data && tar xzf /backup/lifeloop-data-YYYY-MM-DD.tar.gz'

# Tear it all down (keeps the data volume)
docker compose down

# Tear it all down INCLUDING the data volume — destructive
docker compose down -v
```

---

## 7. Security notes

- Container runs as **uid 10001** (`lifeloop`), never root.
- `no-new-privileges` is set on the lifeloop container.
- `tini` is PID 1 so signals propagate cleanly and zombies are reaped.
- The healthcheck speaks only to `127.0.0.1`; no extra ports exposed.
- `helmet`, `cors`, and `express-rate-limit` are configured in `server.js`.
- Watchtower mounts the Docker socket — only run it on hosts you trust.
  The `WATCHTOWER_LABEL_ENABLE=true` flag scopes it to opted-in
  containers only.
- `package-lock.json` is committed; CI uses `npm ci` so builds are
  reproducible.
