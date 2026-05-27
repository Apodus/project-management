@echo off
title Project Management System

REM Port is configurable: run.bat [port]
REM Default: 3000
if "%~1"=="" (set PM_PORT=3000) else (set PM_PORT=%~1)

echo.
echo  ====================================
echo   Project Management System
echo   Human-AI Collaborative PM Tool
echo  ====================================
echo.

REM Check for Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js is not installed or not in PATH.
    echo  Please install Node.js 22+ from https://nodejs.org
    pause
    exit /b 1
)
echo  Node.js found

REM Check for pnpm
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo  pnpm not found. Installing...
    call npm install -g pnpm
    if %errorlevel% neq 0 (
        echo  [ERROR] Failed to install pnpm.
        pause
        exit /b 1
    )
)
echo  pnpm found

REM Install dependencies if needed
if not exist "node_modules" (
    echo.
    echo  Installing dependencies...
    call pnpm install
    if %errorlevel% neq 0 (
        echo  [ERROR] pnpm install failed.
        pause
        exit /b 1
    )
)

REM Build all packages
echo.
echo  Building...
call pnpm build
if %errorlevel% neq 0 (
    echo  [ERROR] Build failed.
    pause
    exit /b 1
)

REM Start the production server
echo.
echo  ====================================
echo   Starting server on port %PM_PORT%
echo  ====================================
echo.
echo  Web UI:   http://localhost:%PM_PORT%
echo  API Docs: http://localhost:%PM_PORT%/api/v1/docs
echo  Help:     http://localhost:%PM_PORT%/help
echo.
echo  First visit? You'll be guided through setup.
echo  Press Ctrl+C to stop.
echo.

set NODE_ENV=production
node packages\server\dist\index.js
