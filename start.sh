#!/bin/zsh
# Used by the macOS LaunchAgent: finds node (nvm, Homebrew or PATH) and starts the server.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
cd "$(dirname "$0")"
exec node server.mjs
