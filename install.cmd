@echo off
rem Double-click to install Excel Autograder (runs install.ps1). Options can be added after the name in a terminal.
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
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
