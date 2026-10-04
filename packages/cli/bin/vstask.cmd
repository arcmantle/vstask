@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0vstask.ps1" %*
exit /b %errorlevel%