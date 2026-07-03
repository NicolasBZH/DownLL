#Requires -Version 5
<#
.SYNOPSIS
    Build et lance DownLL dans Docker pour le tester en local sur Windows.

.DESCRIPTION
    L'image Docker embarque yt-dlp et ffmpeg : rien a installer sur Windows.
    Le script construit l'image, demarre le conteneur, attend que l'app
    reponde, puis ouvre le navigateur.

    NB : ce fichier est volontairement en ASCII pur (pas d'emoji ni d'accents),
    pour fonctionner sous Windows PowerShell 5.1 quelle que soit l'encodage.

.PARAMETER Port
    Port hote a exposer (defaut : 3000).

.PARAMETER Down
    Arrete et supprime le conteneur de test.

.PARAMETER Logs
    Affiche les logs du conteneur en direct.

.PARAMETER Rebuild
    Reconstruit l'image sans cache (force un yt-dlp tout neuf dans l'image).

.PARAMETER Tor
    Empile l'override Tor (docker-compose.tor.yml) : demarre un sidecar Tor et
    fait apparaitre la case "Via Tor" dans l'app. Reproduit le futur setup Linux.

.PARAMETER Auth
    Mot de passe d'acces. Active l'ecran de connexion ET le navigateur integre
    (sinon desactive). Ex : -Auth secret

.PARAMETER Token
    Jeton DOWNLL_TOKEN pour l'extension navigateur (bouton "Ajouter l'extension").
    Si -Auth est fourni sans -Token, un jeton local par defaut est utilise.

.EXAMPLE
    .\scripts\docker-test.ps1
    .\scripts\docker-test.ps1 -Port 8080
    .\scripts\docker-test.ps1 -Tor
    .\scripts\docker-test.ps1 -Auth secret      # active login + navigateur
    .\scripts\docker-test.ps1 -Rebuild
    .\scripts\docker-test.ps1 -Logs
    .\scripts\docker-test.ps1 -Down
#>
[CmdletBinding()]
param(
    [int]$Port = 3000,
    [switch]$Down,
    [switch]$Logs,
    [switch]$Rebuild,
    [switch]$Tor,
    [string]$Auth = '',
    [string]$Token = ''
)

$ErrorActionPreference = 'Stop'

# Se placer a la racine du projet (parent du dossier scripts/).
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Assert-Docker {
    try {
        docker version --format '{{.Server.Version}}' | Out-Null
    } catch {
        Write-Host "[X] Docker n'est pas disponible (Docker Desktop est-il lance ?)." -ForegroundColor Red
        Write-Host "    Installe / demarre Docker Desktop : https://www.docker.com/products/docker-desktop/"
        exit 1
    }
}

# Le port hote est lu par docker-compose.yml via HOST_PORT.
$env:HOST_PORT = "$Port"

# Fichiers compose a empiler : base + (optionnel) override Tor. Utilises pour
# TOUTES les commandes (up/down/logs/build) afin de rester coherent.
$composeArgs = @('-f', 'docker-compose.yml')
if ($Tor) {
    $composeArgs += @('-f', 'docker-compose.tor.yml')
    Write-Host "[Tor] Sidecar Tor active + case 'Via Tor' dans l'app." -ForegroundColor Magenta
}
$torSuffix = if ($Tor) { ' -Tor' } else { '' }

# Mot de passe -> active l'auth et le navigateur integre (lu par compose).
$env:AUTH_PASSWORD = $Auth
if ($Auth) {
    Write-Host "[Auth] Connexion + navigateur integre actives (mot de passe fourni)." -ForegroundColor Magenta
}

# Jeton pour l'extension navigateur (defaut local si -Auth sans -Token).
if ($Auth -and -not $Token) { $Token = 'downll-local-token' }
$env:DOWNLL_TOKEN = $Token
if ($Token) {
    Write-Host "[Ext] DOWNLL_TOKEN = $Token (bouton 'Ajouter l'extension' actif)." -ForegroundColor Magenta
}

Assert-Docker

if ($Down) {
    Write-Host ">> Arret et suppression des conteneurs de test..." -ForegroundColor Yellow
    # --remove-orphans nettoie aussi le sidecar Tor meme sans -Down -Tor.
    docker compose @composeArgs down --remove-orphans
    exit 0
}

if ($Logs) {
    docker compose @composeArgs logs -f
    exit 0
}

Write-Host ">> Construction de l'image (yt-dlp nightly + ffmpeg inclus)..." -ForegroundColor Cyan
if ($Rebuild) {
    docker compose @composeArgs build --no-cache
}
docker compose @composeArgs up -d --build --remove-orphans
if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] Echec du demarrage Docker (le port $Port est peut-etre deja pris)." -ForegroundColor Red
    Write-Host "    Reessaie avec un autre port :  .\scripts\docker-test.ps1 -Port 8080"
    exit 1
}

$url = "http://localhost:$Port"
# Le demarrage inclut la maj de yt-dlp (nightly). Avec -Tor, on attend en plus
# que le sidecar soit sain (depends_on) + le bootstrap du circuit.
$maxTries = if ($Tor) { 120 } else { 60 }
Write-Host ">> Attente du demarrage sur $url (jusqu'a $maxTries s)..."

$ready = $false
for ($i = 0; $i -lt $maxTries; $i++) {
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri "$url/api/health" -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        Start-Sleep -Milliseconds 1000
    }
}

if ($ready) {
    Write-Host ""
    Write-Host "[OK] DownLL est pret : $url" -ForegroundColor Green
    Write-Host "     (sur localhost, la PWA est testable et installable depuis Chrome)" -ForegroundColor DarkGray
    if ($Tor) {
        Write-Host "     Coche 'Via Tor' dans l'app pour router via le sidecar Tor." -ForegroundColor Magenta
    }
    if ($Auth) {
        Write-Host "     Connecte-toi avec ton mot de passe, puis onglet 'Navigateur'." -ForegroundColor Magenta
    } else {
        Write-Host "     Pour activer le navigateur integre : -Auth <motdepasse>" -ForegroundColor DarkGray
    }
    Start-Process $url
    Write-Host ""
    Write-Host "Commandes utiles :"
    Write-Host "   Logs en direct : .\scripts\docker-test.ps1 -Logs$torSuffix"
    Write-Host "   Arreter        : .\scripts\docker-test.ps1 -Down"
    if (-not $Tor) {
        Write-Host "   Tester via Tor : .\scripts\docker-test.ps1 -Tor" -ForegroundColor Magenta
    }
} else {
    Write-Host "[X] L'application n'a pas repondu a temps. Derniers logs :" -ForegroundColor Red
    docker compose @composeArgs logs --tail 50
    exit 1
}
