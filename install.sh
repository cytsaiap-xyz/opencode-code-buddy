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

# Copy plugin (single file)
echo "📦 Copying plugin..."
cp "$SCRIPT_DIR/.opencode/plugins/code-buddy.ts" "$GLOBAL_DIR/plugins/"

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

# Clean up old plugin directory if exists (from previous versions)
if [ -d "$GLOBAL_DIR/plugins/code-buddy" ]; then
    echo "🧹 Removing old plugin directory..."
    rm -rf "$GLOBAL_DIR/plugins/code-buddy"
fi

echo ""
echo "✅ Installation complete!"
echo ""
echo "📁 Installed files:"
echo "   Plugin:   $GLOBAL_DIR/plugins/code-buddy.ts"
echo "   Config:   $GLOBAL_DIR/code-buddy/config.json"
echo "   Commands: $GLOBAL_DIR/commands/ ($CMD_COUNT commands)"
echo "   Data:     $GLOBAL_DIR/code-buddy/data/ (shared across projects)"
echo ""
echo "🚀 Usage:"
echo "   1. cd <any-project>"
echo "   2. opencode"
echo "   3. Type /buddy-help or use buddy_help tool"
echo ""
echo "📊 Features (23 Tools):"
echo "   ✓ Persistent memory storage (global, cross-project)"
echo "   ✓ Knowledge graph (entities & relations)"
echo "   ✓ Error learning system"
echo "   ✓ Workflow guidance"
echo "   ✓ Session health monitoring"
echo "   ✓ Full Auto Observer (auto task/decision/error recording)"
echo "   ✓ AI Auto-Tag generation"
echo ""
echo "⚙️  Config: Edit $GLOBAL_DIR/code-buddy/config.json to customize hooks & LLM"
echo ""
echo "Happy coding! 🎉"
