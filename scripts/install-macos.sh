#!/bin/zsh
# Starts claude-code-live at login (macOS LaunchAgent) and restarts it if it crashes.
#   ./scripts/install-macos.sh            install / update
#   ./scripts/install-macos.sh uninstall  remove
set -e
LABEL="io.github.claude-code-live"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/claude-code-live.log"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

if [ "$1" = "uninstall" ]; then
  rm -f "$PLIST"
  echo "Removed. claude-code-live will no longer start at login."
  exit 0
fi

chmod +x "$APP_DIR/start.sh"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP_DIR/start.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
$( [ -n "$PORT" ] && echo "  <key>EnvironmentVariables</key><dict><key>PORT</key><string>$PORT</string></dict>" )
  <key>LimitLoadToSessionType</key><array><string>Aqua</string></array>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootstrap "$DOMAIN" "$PLIST"
# launchd sometimes holds the first launch of a freshly loaded agent; start it now.
launchctl kickstart -k "$DOMAIN/$LABEL"
sleep 2
if curl -fs -o /dev/null "http://127.0.0.1:${PORT:-4777}/"; then
  echo "Running at http://127.0.0.1:${PORT:-4777} and set to start at login."
else
  echo "Installed, but the server did not answer yet. Check the log: $LOG"
fi
