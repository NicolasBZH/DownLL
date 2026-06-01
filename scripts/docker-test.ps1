#Requires -Version 5
<#
.SYNOPSIS
    Build et lance DownLL dans Docker pour le tester en local sur Windows.

.DESCRIPTION
    L'image Docker embarque yt-dlp et ffmpeg : rien à installer sur Windows.
    Le script construit l'image, démarre le conteneur, attend que l'app
    réponde, puis ouvre le navigateur.

.PARAMETER Port
    Port hôte à exposer (défaut : 3000).

.PARAMETER Down
    Arrête et supprime le conteneur de test.

.PARAMETER Logs
    Affiche les logs du conteneur en direct.

.PARAMETER Rebuild
    Reconstruit l'image sans cache.

.EXAMPLE
    .\scripts\docker-test.ps1
    .\scripts\docker-test.ps1 -Port 8080
    .\scripts\docker-test.ps1 -Logs
    .\scripts\docker-test.ps1 -Down
#>
[CmdletBinding()]
param(
    [int]$Port = 3000,
    [switch]$Down,
    [switch]$Logs,
    [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'

# Se placer à la racine du projet (parent du dossier scripts/).
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Assert-Docker {
    try {
        docker version --format '{{.Server.Version}}' | Out-Null
    } catch {
        Write-Host "❌ Docker n'est pas disponible (Docker Desktop est-il lancé ?)." -ForegroundColor Red
        Write-Host "   Installe / démarre Docker Desktop : https://www.docker.com/products/docker-desktop/"
        exit 1
    }
}

# Le port hôte est lu par docker-compose.yml via HOST_PORT.
$env:HOST_PORT = "$Port"

Assert-Docker

if ($Down) {
    Write-Host "⏹  Arrêt du conteneur de test…" -ForegroundColor Yellow
    docker compose down
    exit 0
}

if ($Logs) {
    docker compose logs -f
    exit 0
}

Write-Host "🐳 Construction de l'image (yt-dlp + ffmpeg inclus)…" -ForegroundColor Cyan
if ($Rebuild) {
    docker compose build --no-cache
}
docker compose up -d --build
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Échec du démarrage Docker (le port $Port est peut-être déjà pris)." -ForegroundColor Red
    Write-Host "   Réessaie avec un autre port :  .\scripts\docker-test.ps1 -Port 8080"
    exit 1
}

$url = "http://localhost:$Port"
Write-Host "⏳ Attente du démarrage sur $url …"

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri "$url/api/health" -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        Start-Sleep -Milliseconds 1000
    }
}

if ($ready) {
    Write-Host ""
    Write-Host "✅ DownLL est prêt : $url" -ForegroundColor Green
    Write-Host "   (sur localhost, la PWA est testable et installable depuis Chrome)" -ForegroundColor DarkGray
    Start-Process $url
    Write-Host ""
    Write-Host "Commandes utiles :"
    Write-Host "   Logs en direct : .\scripts\docker-test.ps1 -Logs"
    Write-Host "   Arrêter        : .\scripts\docker-test.ps1 -Down"
} else {
    Write-Host "❌ L'application n'a pas répondu à temps. Derniers logs :" -ForegroundColor Red
    docker compose logs --tail 50
    exit 1
}
