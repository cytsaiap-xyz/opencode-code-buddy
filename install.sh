#!/bin/bash

# OpenCode Code Buddy - Installation Script (Full Version)
# Usage: ./install.sh [project_path]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-.}"

echo "🤖 Installing OpenCode Code Buddy (Full Version)..."
echo ""

# Create directories
mkdir -p "$TARGET_DIR/.opencode/plugins/code-buddy"
mkdir -p "$TARGET_DIR/.opencode/commands"

# Copy full version plugin
echo "📦 Copying full version plugin..."
cp -r "$SCRIPT_DIR/src" "$TARGET_DIR/.opencode/plugins/code-buddy/"
cp "$SCRIPT_DIR/package.json" "$TARGET_DIR/.opencode/plugins/code-buddy/"
cp "$SCRIPT_DIR/tsconfig.json" "$TARGET_DIR/.opencode/plugins/code-buddy/"

# Copy slash commands
echo "📝 Copying slash commands..."
cp "$SCRIPT_DIR/.opencode/commands/"*.md "$TARGET_DIR/.opencode/commands/" 2>/dev/null || true

# Install dependencies
echo "📥 Installing dependencies..."
cd "$TARGET_DIR/.opencode/plugins/code-buddy"
npm install --silent

echo ""
echo "✅ Installation complete!"
echo ""
echo "📁 Installed to:"
echo "   Plugin: $TARGET_DIR/.opencode/plugins/code-buddy/"
echo "   Commands: $TARGET_DIR/.opencode/commands/"
echo ""
echo "🚀 Usage:"
echo "   1. cd $TARGET_DIR"
echo "   2. opencode"
echo "   3. Type /buddy-help or buddy_help"
echo ""
echo "📊 Full Version Features:"
echo "   ✓ Persistent memory storage"
echo "   ✓ Knowledge graph"
echo "   ✓ Error learning system"
echo "   ✓ Workflow guidance"
echo "   ✓ Session health monitoring"
echo "   ✓ Optional vLLM AI integration"
echo ""
echo "Happy coding! 🎉"
