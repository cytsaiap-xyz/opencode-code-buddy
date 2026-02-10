#!/bin/bash

# OpenCode Code Buddy - Installation Script
# Usage: ./install.sh [project_path]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-.}"

echo "🤖 Installing OpenCode Code Buddy v2.0..."
echo ""

# Create directories
mkdir -p "$TARGET_DIR/.opencode/plugins"
mkdir -p "$TARGET_DIR/.opencode/commands"
mkdir -p "$TARGET_DIR/.opencode/code-buddy"

# Copy plugin (single file)
echo "📦 Copying plugin..."
cp "$SCRIPT_DIR/.opencode/plugins/code-buddy.ts" "$TARGET_DIR/.opencode/plugins/"

# Copy default config
echo "⚙️  Copying default config..."
cp "$SCRIPT_DIR/.opencode/code-buddy/config.json" "$TARGET_DIR/.opencode/code-buddy/"

# Copy slash commands
echo "📝 Copying slash commands..."
cp "$SCRIPT_DIR/.opencode/commands/"*.md "$TARGET_DIR/.opencode/commands/" 2>/dev/null || true

# Count installed commands
CMD_COUNT=$(ls -1 "$TARGET_DIR/.opencode/commands/"buddy-*.md 2>/dev/null | wc -l | tr -d ' ')

echo ""
echo "✅ Installation complete!"
echo ""
echo "📁 Installed files:"
echo "   Plugin:   $TARGET_DIR/.opencode/plugins/code-buddy.ts"
echo "   Config:   $TARGET_DIR/.opencode/code-buddy/config.json"
echo "   Commands: $TARGET_DIR/.opencode/commands/ ($CMD_COUNT commands)"
echo ""
echo "🚀 Usage:"
echo "   1. cd $TARGET_DIR"
echo "   2. opencode"
echo "   3. Type /buddy-help or use buddy_help tool"
echo ""
echo "📊 Features (23 Tools):"
echo "   ✓ Persistent memory storage + deduplication"
echo "   ✓ Knowledge graph (entities & relations)"
echo "   ✓ Error learning system"
echo "   ✓ Workflow guidance"
echo "   ✓ Session health monitoring"
echo "   ✓ Full Auto Observer (auto task/decision/error recording)"
echo "   ✓ AI Auto-Tag generation"
echo ""
echo "⚙️  Config: Edit .opencode/code-buddy/config.json to customize hooks & LLM"
echo ""
echo "Happy coding! 🎉"
