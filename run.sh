#!/usr/bin/env bash
set -e

echo ""
echo "  ===================================="
echo "   Project Management System"
echo "   Human-AI Collaborative PM Tool"
echo "  ===================================="
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "  [ERROR] Node.js is not installed."
    echo "  Please install Node.js 22+ from https://nodejs.org"
    exit 1
fi
echo "  Node.js: $(node -v)"

# Check for pnpm
if ! command -v pnpm &> /dev/null; then
    echo "  pnpm not found. Installing..."
    npm install -g pnpm
fi
echo "  pnpm: $(pnpm -v)"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo ""
    echo "  Installing dependencies (first run)..."
    pnpm install
fi

# Build all packages
echo ""
echo "  Building..."
pnpm build

# Start the production server
echo ""
echo "  ===================================="
echo "   Starting server..."
echo "  ===================================="
echo ""
echo "  Web UI:   http://localhost:3000"
echo "  API Docs: http://localhost:3000/api/v1/docs"
echo ""
echo "  First visit? You'll be guided through setup."
echo "  Press Ctrl+C to stop."
echo ""

NODE_ENV=production exec node packages/server/dist/index.js
