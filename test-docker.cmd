@echo off
REM Lance DownLL dans Docker pour le tester (double-clic possible).
REM Transmet les éventuels arguments au script PowerShell (-Port, -Down, -Logs...).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\docker-test.ps1" %*
echo.
pause
