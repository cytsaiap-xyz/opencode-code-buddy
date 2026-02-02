#!/bin/bash

# OpenCode Code Buddy - Installation Script (Full Version)
# Usage: ./install.sh [project_path]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-.}"

echo "🤖 Installing OpenCode Code Buddy (Full Version)..."
echo ""

# Create directories
mkdir -p "$TARGET_DIR/.opencode/plugins"
mkdir -p "$TARGET_DIR/.opencode/commands"

# Copy full version plugin (single file)
echo "📦 Copying full version plugin..."
cp "$SCRIPT_DIR/.opencode/plugins/code-buddy.ts" "$TARGET_DIR/.opencode/plugins/"

# Copy slash commands
echo "📝 Copying slash commands (12 commands)..."
cp "$SCRIPT_DIR/.opencode/commands/"*.md "$TARGET_DIR/.opencode/commands/" 2>/dev/null || true

echo ""
echo "✅ Installation complete!"
echo ""
echo "📁 Installed to:"
echo "   Plugin: $TARGET_DIR/.opencode/plugins/code-buddy.ts"
echo "   Commands: $TARGET_DIR/.opencode/commands/"
echo ""
echo "🚀 Usage:"
echo "   1. cd $TARGET_DIR"
echo "   2. opencode"
echo "   3. Type /buddy-help or use buddy_help tool"
echo ""
echo "📊 Full Version Features (16 Tools):"
echo "   ✓ Persistent memory storage"
echo "   ✓ Knowledge graph"
echo "   ✓ Error learning system"
echo "   ✓ Workflow guidance"
echo "   ✓ Session health monitoring"
echo ""
echo "📋 Available Slash Commands:"
echo "   /buddy-help     - Display help"
echo "   /buddy-do       - Execute task"
echo "   /buddy-remember - Search memories"
echo "   /buddy-recent   - Recent memories"
echo "   /buddy-stats    - Statistics"
echo "   /buddy-add      - Add memory"
echo "   /buddy-status   - Status"
echo "   /buddy-entity   - Create entity"
echo "   /buddy-mistake  - Record mistake"
echo "   /buddy-patterns - Error analysis"
echo "   /buddy-workflow - Workflow guidance"
echo "   /buddy-health   - Session health"
echo ""
echo "Happy coding! 🎉"
