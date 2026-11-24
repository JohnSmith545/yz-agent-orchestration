@echo off
rem Keeps Yz Agent Orchestration running (Windows). Starts node server.mjs from the
rem repo root, and starts it again 5 seconds after it stops, for whatever reason.
rem Output is appended to %LOCALAPPDATA%\yz-agent-orchestration\server.log.
rem Stop it by closing its window, or Ctrl+C then Y.
rem To start it at login: put a shortcut to this file in the folder that shell:startup opens.
setlocal
set "ROOT=%~dp0.."
set "LOGDIR=%LOCALAPPDATA%\yz-agent-orchestration"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"
:loop
echo [%date% %time%] starting node server.mjs>>"%LOGDIR%\server.log"
node server.mjs >>"%LOGDIR%\server.log" 2>&1
if %errorlevel%==75 (echo [%date% %time%] restarting at once to switch project>>"%LOGDIR%\server.log" & goto loop)
echo [%date% %time%] stopped with exit code %errorlevel%, starting again in 5 seconds>>"%LOGDIR%\server.log"
rem ping, not timeout: timeout fails at once when there is no console (a hidden or startup window),
rem and the loop would spin. Six pings one second apart wait about 5 seconds.
ping -n 6 127.0.0.1 >nul
goto loop

rem Exit code 75 is the server asking to be started again AT ONCE: it stopped itself to switch project
rem (restart.mjs). Every other exit still waits the 5 seconds, so a server that fails on start never spins.
rem These notes sit below the loop ON PURPOSE: cmd.exe reads a running batch file from where it left off,
rem so every line up to the node line must stay byte for byte as it was for a window already running
rem this file to pick up the new line safely.
