#!/bin/bash

# OpenCode Code Buddy - Installation Script (Global)
# Installs to ~/.config/opencode/ for cross-project memory persistence
# Usage: ./install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL_DIR="$HOME/.config/opencode"

echo "🤖 Installing OpenCode Code Buddy v2.0 (Global)..."
echo ""

# Create directories
mkdir -p "$GLOBAL_DIR/plugins"
mkdir -p "$GLOBAL_DIR/commands"
mkdir -p "$GLOBAL_DIR/code-buddy"

# Copy plugin entry point + modules
echo "📦 Copying plugin..."
cp "$SCRIPT_DIR/.opencode/plugins/code-buddy.ts" "$GLOBAL_DIR/plugins/"
rm -rf "$GLOBAL_DIR/plugins/code-buddy-src"
cp -r "$SCRIPT_DIR/.opencode/plugins/code-buddy-src" "$GLOBAL_DIR/plugins/code-buddy-src"

# Copy default config (don't overwrite if exists)
if [ ! -f "$GLOBAL_DIR/code-buddy/config.json" ]; then
    echo "⚙️  Creating default config..."
    cp "$SCRIPT_DIR/.opencode/code-buddy/config.json" "$GLOBAL_DIR/code-buddy/"
else
    echo "⚙️  Config already exists, skipping (won't overwrite)"
fi

# Copy slash commands
echo "📝 Copying slash commands..."
cp "$SCRIPT_DIR/.opencode/commands/"*.md "$GLOBAL_DIR/commands/" 2>/dev/null || true

# Count installed commands
CMD_COUNT=$(ls -1 "$GLOBAL_DIR/commands/"buddy-*.md 2>/dev/null | wc -l | tr -d ' ')

echo ""
echo "✅ Installation complete!"
echo ""
echo "📁 Installed files:"
echo "   Plugin:   $GLOBAL_DIR/plugins/code-buddy.ts"
echo "   Modules:  $GLOBAL_DIR/plugins/code-buddy-src/ (8 files)"
echo "   Config:   $GLOBAL_DIR/code-buddy/config.json"
echo "   Commands: $GLOBAL_DIR/commands/ ($CMD_COUNT commands)"
echo "   Data:     $GLOBAL_DIR/code-buddy/data/ (shared across projects)"
echo ""
echo "🚀 Usage:"
echo "   1. cd <any-project>"
echo "   2. opencode"
echo "   3. Type /buddy-help or use buddy_help tool"
echo ""
echo "⚙️  Config: Edit $GLOBAL_DIR/code-buddy/config.json to customize hooks & LLM"
echo ""
echo "Happy coding! 🎉"
