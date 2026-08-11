# opencode-discord-rpc

Discord Rich Presence plugin for [OpenCode](https://opencode.ai) - Show your AI-assisted coding activity in Discord!

![Discord Rich Presence Preview](https://img.shields.io/npm/v/opencode-discord-rpc?style=flat-square&color=5865F2)

## Features

- Shows your current AI model being used (GPT-4, Claude, etc.)
- Displays session duration (elapsed time)
- Shows activity status (Coding/Idle/Thinking)
- Clickable button to visit OpenCode.ai
- Auto-reconnects if Discord restarts
- Zero configuration needed

## Installation

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-discord-rpc"]
}
```

For global installation, add it to `~/.config/opencode/opencode.json`.

That's it! Restart OpenCode and your Discord Rich Presence will appear.

## How It Works

Once installed, the plugin automatically:

1. Connects to Discord when OpenCode starts
2. Displays your current activity in Discord's Rich Presence
3. Updates in real-time as you code:
   - **Coding...** - When tools are executing or you're actively working
   - **Thinking...** - When the AI is generating a response
   - **Waiting for input...** - When the session is waiting for your input
   - **Idle** - When no session is active

## Rich Presence Display

```
┌─────────────────────────────────────────┐
│ [OpenCode Logo]                         │
│                                         │
│ my-project                              │
│ gpt-4o • Coding...                      │
│ 01:23:45 elapsed                        │
│                                         │
│ [ Visit OpenCode.ai ]                   │
└─────────────────────────────────────────┘
```

## Configuration

The plugin works out of the box with no configuration needed.

For advanced users, you can customize behavior with environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCODE_DISCORD_ENABLED` | Set to `"false"` to disable | `"true"` |
| `OPENCODE_DISCORD_CLIENT_ID` | Use your own Discord Application | Built-in |
| `OPENCODE_DISCORD_SHOW_SESSION` | Set to `"false"` to hide the session/project name | `"true"` |
| `OPENCODE_DISCORD_RETRY_INTERVAL` | Reconnect interval (ms) | `15000` |
| `OPENCODE_DISCORD_MAX_RETRIES` | Max reconnection attempts | `5` |

## Privacy

By default this plugin displays the current project folder name (e.g. `my-project`).
It does NOT display file names, paths, or any code content. Set
`OPENCODE_DISCORD_SHOW_SESSION` to `"false"` to hide the project name entirely.

## Requirements

- OpenCode v1.0+
- Discord Desktop App (must be running)

## Troubleshooting

### Rich Presence not showing

1. **Make sure Discord is running** - The desktop app must be open
2. **Check Activity Status is enabled** - In Discord Settings > Activity Privacy, ensure "Display current activity as a status message" is ON
3. **Restart OpenCode** - The plugin connects on startup

### Connection errors in logs

The plugin will automatically retry if Discord isn't available. Common messages:

- `"Discord is not running or not accessible"` - Discord desktop app is closed
- `"Max retry attempts reached"` - Discord wasn't found after multiple attempts; restart OpenCode when Discord is running

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

```bash
# Clone the repository
git clone https://github.com/phoenixak/opencode-discord-rpc.git
cd opencode-discord-rpc

# Install dependencies
npm install

# Build
npm run build

# Watch mode for development
npm run dev
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Credits

- Built for [OpenCode](https://opencode.ai)
- Uses [@xhayper/discord-rpc](https://github.com/xhayper/discord-rpc) for Discord IPC communication
