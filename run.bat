@echo off
title Project Management System
echo.
echo  ====================================
echo   Project Management System
echo   Human-AI Collaborative PM Tool
echo  ====================================
echo.

:: Check for Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js is not installed or not in PATH.
    echo  Please install Node.js 22+ from https://nodejs.org
    pause
    exit /b 1
)

:: Check Node version
for /f "tokens=1 delims=v" %%a in ('node -v') do set NODE_VERSION=%%a
echo  Node.js: %NODE_VERSION%

:: Check for pnpm
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo  pnpm not found. Installing...
    npm install -g pnpm
    if %errorlevel% neq 0 (
        echo  [ERROR] Failed to install pnpm. Try: npm install -g pnpm
        pause
        exit /b 1
    )
)
echo  pnpm: found

:: Install dependencies if needed
if not exist "node_modules" (
    echo.
    echo  Installing dependencies (first run)...
    call pnpm install
    if %errorlevel% neq 0 (
        echo  [ERROR] pnpm install failed.
        pause
        exit /b 1
    )
)

:: Build all packages
echo.
echo  Building...
call pnpm build
if %errorlevel% neq 0 (
    echo  [ERROR] Build failed.
    pause
    exit /b 1
)

:: Start the production server
echo.
echo  ====================================
echo   Starting server...
echo  ====================================
echo.
echo  Web UI:   http://localhost:3000
echo  API Docs: http://localhost:3000/api/v1/docs
echo.
echo  First visit? You'll be guided through setup.
echo  Press Ctrl+C to stop.
echo.

set NODE_ENV=production
node packages\server\dist\index.js
