@echo off
REM ============================================================
REM  Build + deploy to race-ai EC2 host via OpenSSH (ssh + scp).
REM  Run from PowerShell or cmd:  .\deploy.bat
REM  Requires:
REM    - npm on PATH
REM    - OpenSSH client (ssh/scp) on PATH  (built in to Win10/11)
REM    - ~/.ssh/config entry "race-ai" with the right key
REM ============================================================

setlocal enabledelayedexpansion

set PROJECT_DIR=%~dp0
set REMOTE=race-ai
set REMOTE_PARENT=/home/ec2-user/virtualizationPoc
set REMOTE_DIR=%REMOTE_PARENT%/dist

echo.
echo === [1/3] Building production bundle ===
pushd "%PROJECT_DIR%"
call npm run build
if errorlevel 1 (
    echo.
    echo BUILD FAILED.
    popd
    exit /b 1
)
popd

echo.
echo === [2/3] Preparing remote folder (%REMOTE%:%REMOTE_DIR%) ===
REM Ensure parent exists and wipe the old dist folder so scp can re-create it
REM (Windows cmd doesn't expand globs, so we upload the whole folder, not its contents).
ssh %REMOTE% "mkdir -p %REMOTE_PARENT% && rm -rf %REMOTE_DIR%"
if errorlevel 1 (
    echo.
    echo REMOTE PREP FAILED. Check your SSH config / connectivity.
    exit /b 1
)

echo.
echo === [3/3] Uploading dist/ via scp ===
REM -r  recursive
REM -C  compress on the wire
REM -p  preserve mtimes (helps nginx ETag/If-Modified-Since)
scp -rCp "%PROJECT_DIR%dist" %REMOTE%:%REMOTE_PARENT%/
if errorlevel 1 (
    echo.
    echo UPLOAD FAILED.
    exit /b 1
)

echo.
echo === Deploy complete ===
echo Remote path: %REMOTE%:%REMOTE_DIR%
echo.
endlocal
