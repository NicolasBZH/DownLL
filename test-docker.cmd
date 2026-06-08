@echo off
REM Lance DownLL dans Docker pour le tester (double-clic possible).
REM L'image embarque yt-dlp (canal nightly, mis a jour au demarrage) + ffmpeg.
REM
REM Transmet les arguments au script PowerShell. Exemples en ligne de commande :
REM   test-docker.cmd              build + demarre + ouvre le navigateur
REM   test-docker.cmd -Port 8080   si le port 3000 est deja pris
REM   test-docker.cmd -Tor         + sidecar Tor (case "Via Tor" dans l'app)
REM   test-docker.cmd -Rebuild     reconstruit l'image sans cache (yt-dlp tout neuf)
REM   test-docker.cmd -Logs        logs en direct
REM   test-docker.cmd -Down        arret + suppression des conteneurs
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\docker-test.ps1" %*
echo.
pause
