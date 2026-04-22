#!/bin/bash

set -e

echo "Setting up Nightshift..."

# Install frontend dependencies
echo "Installing frontend dependencies..."
npm install

# Check if Rust is installed
if ! command -v cargo &> /dev/null; then
    echo "Rust is not installed. Please install Rust from https://rustup.rs/"
    exit 1
fi

# Install Tauri CLI
echo "Installing Tauri CLI..."
npm run tauri dev --help > /dev/null 2>&1 || npm install -D @tauri-apps/cli

echo ""
echo "Setup complete!"
echo ""
echo "To start development:"
echo "  npm run tauri dev"
echo ""
echo "To build for production:"
echo "  npm run tauri build"
