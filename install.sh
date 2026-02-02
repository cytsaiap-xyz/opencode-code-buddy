#!/bin/bash

# OpenCode Code Buddy - Installation Script
# Usage: ./install.sh [project_path]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-.}"

echo "🤖 Installing OpenCode Code Buddy..."
echo ""

# Create directories
mkdir -p "$TARGET_DIR/.opencode/plugins"
mkdir -p "$TARGET_DIR/.opencode/commands"

# Copy plugin file
echo "📦 Copying plugin..."
cp "$SCRIPT_DIR/.opencode/plugins/code-buddy.ts" "$TARGET_DIR/.opencode/plugins/"

# Copy slash commands
echo "📝 Copying slash commands..."
cp "$SCRIPT_DIR/.opencode/commands/"*.md "$TARGET_DIR/.opencode/commands/" 2>/dev/null || true

# Install dependencies if full version is used
if [ -d "$SCRIPT_DIR/src" ]; then
    echo "📥 Installing dependencies..."
    mkdir -p "$TARGET_DIR/.opencode/plugins/code-buddy"
    cp -r "$SCRIPT_DIR/src" "$TARGET_DIR/.opencode/plugins/code-buddy/"
    cp "$SCRIPT_DIR/package.json" "$TARGET_DIR/.opencode/plugins/code-buddy/"
    cp "$SCRIPT_DIR/tsconfig.json" "$TARGET_DIR/.opencode/plugins/code-buddy/"
    
    cd "$TARGET_DIR/.opencode/plugins/code-buddy"
    npm install --silent
fi

echo ""
echo "✅ Installation complete!"
echo ""
echo "📁 Installed to: $TARGET_DIR/.opencode/"
echo ""
echo "🚀 Usage:"
echo "   1. cd $TARGET_DIR"
echo "   2. opencode"
echo "   3. Type /buddy-help or buddy_help"
echo ""
echo "Happy coding! 🎉"
