# Claude Code Live

Watch your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions live in the browser: every project, every session, updating as Claude works. One click takes you to the Terminal tab where a session is running, or resumes it in a new one.

[Leia em português](README.pt-BR.md)

![Claude Code Live](docs/screenshot.jpg)

> Unofficial community project. Not affiliated with or endorsed by Anthropic.

## Features

- **All sessions in one place.** Reads `~/.claude/projects` and groups sessions by the folder they started in. Search by title, folder or prompt.
- **Live.** Open sessions update as new messages, tool calls and results arrive. Fast even for 100+ MB session files.
- **Tabs.** Open several sessions side by side, close and reopen them. Your tabs come back after a reload.
- **Status.** See which sessions are open in a terminal right now, and whether Claude is *working* or *waiting for you*.
- **Jump to Terminal (macOS).** If the session is running, brings its Terminal.app tab to the front. If not, opens a new Terminal window with `claude --resume <id>`.
- **Zero dependencies.** One Node file and one HTML page. Runs only on `127.0.0.1`.

## Quick start

Requires Node.js 20+.

```bash
git clone https://github.com/andersonbuzzi/claude-code-live.git
cd claude-code-live
npm start
# open http://127.0.0.1:4777
```

Want to see it without your own data? `npm run demo` starts it on port 4778 with made-up sessions, one of them updating live.

### Start at login (macOS)

```bash
./scripts/install-macos.sh            # install as a LaunchAgent, starts now and at every login
./scripts/install-macos.sh uninstall  # remove
```

Logs go to `~/Library/Logs/claude-code-live.log`.

The first time you use "Open in Terminal", macOS asks for permission to let `node` control Terminal. You can change it later in System Settings › Privacy & Security › Automation.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `4777` | Port to listen on (always `127.0.0.1`) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps its data |

The interface follows your browser language (English or Portuguese). Add `?lang=en` or `?lang=pt` to force one.

## How it works

- Claude Code writes each session to `~/.claude/projects/<folder>/<session-id>.jsonl`, one JSON event per line. The server reads only the start and end of each file to build the list, and streams new lines to the browser with Server-Sent Events as the file grows.
- Running sessions are found through `~/.claude/sessions/<pid>.json`, which Claude Code keeps for every open `claude` process (session id and status). The process's TTY identifies its Terminal.app tab, which is focused through AppleScript.
- `claude --resume <id>` keeps writing to the same file, so a resumed session keeps updating in the tab you already have open.

## Limitations

- Read-only: you can't send messages from the browser (yet).
- "Jump to Terminal" supports Terminal.app only. Sessions running in iTerm, VS Code or other apps show a message instead.
- Subagent activity shows as the `Agent` tool call, not its inner steps.
- Very long sessions show the latest 4,000 events.
- The `.jsonl` format is internal to Claude Code and may change between versions. Unknown events are skipped, but a Claude Code update could break parts of the view.

## Security

The server binds to `127.0.0.1` only and rejects requests whose `Host` or `Origin` is not local, so other websites open in your browser can't read your sessions or trigger the Terminal action. Session ids and folders are validated before any file is read. Session folders come from your own session files, never from the browser.

## License

[MIT](LICENSE)
