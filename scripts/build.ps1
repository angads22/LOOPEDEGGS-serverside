# =============================================================================
#  LifeLoop Hub — Windows build script (PowerShell)
#
#  Builds the production Docker image. Defaults to a single-arch local build
#  (fast, loads into Docker Desktop). Use -MultiArch to build & push a
#  multi-platform image (amd64 + arm64 for Raspberry Pi 5) to a registry.
#
#  Examples:
#    # Local build, tag = lifeloop-hub:dev
#    .\scripts\build.ps1
#
#    # Tagged local build
#    .\scripts\build.ps1 -Tag v1.0.0
#
#    # Multi-arch build & push to GHCR
#    .\scripts\build.ps1 -MultiArch -Push -Registry ghcr.io/angads22/loopedeggs-serverside -Tag v1.0.0
# =============================================================================

[CmdletBinding()]
param(
    [string]$Tag       = "dev",
    [string]$Registry  = "lifeloop-hub",
    [switch]$MultiArch,
    [switch]$Push,
    [string]$Platforms = "linux/amd64,linux/arm64"
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[ ok ] $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "[fail] $msg" -ForegroundColor Red }

# Move to repo root regardless of where the script was invoked from.
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

# --- Sanity checks ----------------------------------------------------------
Write-Step "Checking Docker"
try {
    docker version --format '{{.Server.Version}}' | Out-Null
} catch {
    Write-Err "Docker is not running. Start Docker Desktop and try again."
    exit 1
}
Write-Ok "Docker is running"

# --- Build metadata ---------------------------------------------------------
$vcsRef    = (git rev-parse --short HEAD 2>$null); if (-not $vcsRef) { $vcsRef = "local" }
$buildDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$image     = "${Registry}:${Tag}"

Write-Host ""
Write-Host "  Image     : $image"
Write-Host "  Version   : $Tag"
Write-Host "  Revision  : $vcsRef"
Write-Host "  BuildDate : $buildDate"
Write-Host ""

# --- Build ------------------------------------------------------------------
$commonArgs = @(
    "--build-arg", "VERSION=$Tag",
    "--build-arg", "VCS_REF=$vcsRef",
    "--build-arg", "BUILD_DATE=$buildDate",
    "-t",          $image
)

if ($MultiArch) {
    Write-Step "Multi-arch build ($Platforms)"

    # Ensure a buildx builder exists. On Docker Desktop the `default` builder
    # uses the Docker driver which does not support multi-arch — so we use a
    # named builder backed by the docker-container driver.
    $builderName = "lifeloop-builder"
    $existing = (docker buildx ls) -join "`n"
    if ($existing -notmatch [Regex]::Escape($builderName)) {
        Write-Step "Creating buildx builder '$builderName'"
        docker buildx create --name $builderName --driver docker-container --use | Out-Null
        docker buildx inspect --bootstrap | Out-Null
    } else {
        docker buildx use $builderName | Out-Null
    }

    if ($Push) {
        $output = "--push"
    } else {
        Write-Host "[note] Multi-arch images cannot be loaded into the local engine."
        Write-Host "       Pass -Push to publish, or omit -MultiArch for a local-only build."
        $output = "--output=type=oci,dest=lifeloop-hub.oci.tar"
    }

    docker buildx build `
        --platform $Platforms `
        @commonArgs `
        $output `
        .
} else {
    Write-Step "Single-arch local build"
    docker build @commonArgs .

    if ($Push) {
        Write-Step "Pushing $image"
        docker push $image
    }
}

if ($LASTEXITCODE -ne 0) {
    Write-Err "Build failed (exit $LASTEXITCODE)"
    exit $LASTEXITCODE
}

Write-Ok "Built $image"
Write-Host ""
Write-Host "Run it with:"
Write-Host "  docker run --rm -p 3000:3000 -v lifeloop-data:/app/data $image"
Write-Host "Or via compose:"
Write-Host "  `$env:LIFELOOP_IMAGE='$image'; docker compose up -d"
