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
echo [%date% %time%] stopped with exit code %errorlevel%, starting again in 5 seconds>>"%LOGDIR%\server.log"
rem ping, not timeout: timeout fails at once when there is no console (a hidden or startup window),
rem and the loop would spin. Six pings one second apart wait about 5 seconds.
ping -n 6 127.0.0.1 >nul
goto loop
