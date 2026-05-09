# =============================================================================
#  LifeLoop Hub — Windows deploy script (PowerShell)
#
#  Pulls the latest published image and (re)starts the compose stack.
#  Watchtower will keep it up to date afterwards, but you can re-run this
#  any time to force an immediate update.
#
#  Examples:
#    .\scripts\deploy.ps1                       # pull :latest and start
#    .\scripts\deploy.ps1 -Tag v1.0.0           # pin a specific version
#    .\scripts\deploy.ps1 -NoWatchtower         # start without auto-updates
#    .\scripts\deploy.ps1 -Local                # use an image you built locally
# =============================================================================

[CmdletBinding()]
param(
    [string]$Tag      = "latest",
    [string]$Registry = "ghcr.io/angads22/loopedeggs-serverside",
    [switch]$Local,
    [switch]$NoWatchtower
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[ ok ] $msg" -ForegroundColor Green }

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

if ($Local) {
    $env:LIFELOOP_IMAGE = "lifeloop-hub:${Tag}"
} else {
    $env:LIFELOOP_IMAGE = "${Registry}:${Tag}"
}

Write-Step "Deploying $env:LIFELOOP_IMAGE"

if (-not $Local) {
    Write-Step "Pulling image"
    docker compose pull lifeloop
}

$services = @("lifeloop")
if (-not $NoWatchtower) { $services += "watchtower" }

Write-Step "Starting services: $($services -join ', ')"
docker compose up -d @services

Write-Step "Waiting for healthcheck"
$deadline = (Get-Date).AddSeconds(60)
do {
    Start-Sleep -Seconds 2
    $status = docker inspect --format '{{.State.Health.Status}}' lifeloop 2>$null
    Write-Host "  status: $status"
} while ($status -ne "healthy" -and (Get-Date) -lt $deadline)

if ($status -eq "healthy") {
    Write-Ok "lifeloop is healthy"
    Write-Host ""
    Write-Host "  Hub:    http://localhost:3000"
    Write-Host "  Health: http://localhost:3000/api/health"
    Write-Host "  Logs:   docker compose logs -f lifeloop"
} else {
    Write-Host "[warn] lifeloop did not report healthy within 60s. Check: docker compose logs lifeloop" -ForegroundColor Yellow
    exit 1
}
