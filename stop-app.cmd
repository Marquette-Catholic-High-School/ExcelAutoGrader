@echo off
rem Stops Excel Autograder. Double-click this file, or run .\stop-app.cmd in a terminal.
setlocal
set "EXITCODE=1"
where node >nul 2>nul || goto nonode
node --disable-warning=ExperimentalWarning "%~dp0scripts\service.mjs" stop %*
set "EXITCODE=%ERRORLEVEL%"
goto finish
:nonode
echo Error: Node.js is not installed or not on PATH. Install it from https://nodejs.org
:finish
rem Keep the window open when started by double-click (Explorer runs "cmd /c"), so the messages can be read.
rem Not when options were given or EXCEL_AUTOGRADER_NO_PAUSE is set (scheduled tasks: "update.cmd --yes").
rem Delayed expansion keeps characters such as & in the folder name from breaking the test.
if not "%~1"=="" goto done
if defined EXCEL_AUTOGRADER_NO_PAUSE goto done
setlocal EnableDelayedExpansion
if /i not "!cmdcmdline:/c=!"=="!cmdcmdline!" pause
endlocal
:done
exit /b %EXITCODE%
