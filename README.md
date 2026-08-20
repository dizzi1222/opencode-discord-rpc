# opencode-discord-rpc

Discord Rich Presence plugin for [OpenCode](https://opencode.ai) - Show your AI-assisted coding activity in Discord!

![Discord Rich Presence Preview](https://img.shields.io/npm/v/opencode-discord-rpc?style=flat-square&color=5865F2)

## Features

- Shows your current AI provider and model (e.g., "OpenAI gpt-4o", "Anthropic claude-sonnet-4")
- Displays **active session duration** — only counts time when OpenCode is actually running (pauses when closed/hibernated)
- Shows activity status (Coding/Idle/Thinking/Waiting)
- Clickable button to visit OpenCode.ai
- Auto-reconnects if Discord restarts
- **Neovim coexistence**: automatically yields the activity line to
  [presence.nvim](https://github.com/andweeb/presence.nvim) when OpenCode is
  idle, and takes it back when you start working again.

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

> **Fork note**: this repo is a personal fork. The default client id matches
> the one used by `presence.nvim` so both apps share the same activity line
> and alternate. See [Alternancia con neovim](#alternancia-con-neovim).

## How It Works

Once installed, the plugin automatically:

1. Connects to Discord when OpenCode starts
2. Displays your current activity in Discord's Rich Presence
3. Updates in real-time as you code:
   - **Coding...** - When tools are executing or you're actively working
   - **Thinking...** - When the AI is generating a response
   - **Waiting for input...** - When the session is waiting for your input
   - **Idle** - When no session is active

## Alternancia con neovim

OpenCode y Neovim publican con **identidades propias** — cada uno con su
propia Discord Application (título y logo correctos para cada app):

- OpenCode usa su propia app (`1462270555586822206` → "opencode") y
  presence.nvim usa la suya (`793271441293967371` → "Neovim").
- Cuando OpenCode está **activo** (trabajando, respondiendo, ejecutando
  tools), publica su actividad → se ve la tarjeta "opencode".
- Cuando OpenCode queda **idle** (esperando input, sesión idle/borrada, o sin
  actividad real por 2s) el plugin `clearActivity()` → la tarjeta de opencode
  desaparece y solo queda la de presence.nvim ("Neovim").
- Cuando volvés a trabajar en OpenCode (mensaje, tool, streaming) retoma su
  tarjeta de inmediato.

El timer de **tiempo activo** se persiste (`~/.cache/opencode-discord-rpc/session-active-time`
keyed por session id). Solo cuenta tiempo cuando OpenCode está ejecutándose —
se pausa al cerrar/hibernar y reanuda al reabrir. El contador no se reinicia
al alternar con Neovim ni al reconectar Discord.

### Migración desde versiones anteriores

Si actualizás desde una versión que usaba wall-clock time (`session-start`), el plugin
migra automáticamente el timestamp histórico:

1. Lee el archivo legacy `~/.cache/opencode-discord-rpc/session-start`
2. Calcula el tiempo wall-clock transcurrido desde el inicio original
3. Usa ese valor como `accumulatedActiveMs` inicial (aproximación que incluye tiempo cerrado)
4. A partir de ahí, solo cuenta tiempo activo real

Esto preserva tu historial de ~11h en la primera ejecución tras actualizar.

Flujo típico:

```
Tarjeta Neovim "editing foo.ts"            (presence.nvim)
        │  escribís una tarea en OpenCode
        ▼
Tarjeta "opencode" "repo • claude • Coding..."   + Neovim (ambas visibles)
        │  terminás / opencode deja de trabajar (2s sin actividad)
        ▼
opencode hace clearActivity → su tarjeta desaparece
        │
        ▼
Solo queda "Neovim: editing foo.ts"
```

Con `auto_update = true` en presence.nvim, la tarjeta de Neovim se mantiene
fresca mientras editás, así que la alternancia sucede sola. No se toca ningún
archivo de la config de Neovim.

## Rich Presence Display

```
┌─────────────────────────────────────────┐
│ [OpenCode Logo]                         │
│                                         │
│ my-project                              │
│ OpenAI gpt-4o • Coding...               │
│ 01:23:45 elapsed (active time)          │
│                                         │
│ [ Visit OpenCode.ai ]                   │
└─────────────────────────────────────────┘
```

Cuando OpenCode cede la línea a Neovim (idle), esta tarjeta desaparece y la
de presence.nvim queda como única actividad visible.

## Configuration

The plugin works out of the box with no configuration needed.

For advanced users, you can customize behavior with environment variables:

| Variable                              | Description                                       | Default                                          |
| ------------------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| `OPENCODE_DISCORD_ENABLED`            | Set to `"false"` to disable                       | `"true"`                                         |
| `OPENCODE_DISCORD_CLIENT_ID`          | Use your own Discord Application                  | `1462270555586822206` (app "opencode") |
| `OPENCODE_DISCORD_SHOW_SESSION`       | Set to `"false"` to hide the session/project name | `"true"`                                         |
| `OPENCODE_DISCORD_SHOW_PROVIDER`      | Set to `"false"` to hide the provider name        | `"true"`                                         |
| `OPENCODE_DISCORD_RETRY_INTERVAL`     | Reconnect interval (ms)                           | `15000`                                          |
| `OPENCODE_DISCORD_MAX_RETRIES`        | Max reconnection attempts                         | `5`                                              |

> **Tip**: el default usa la app "opencode" separada de la de presence.nvim.
> Si querés que OpenCode y Neovim compartan la **misma** línea (una sola
> actividad que alterna contenido), setea `OPENCODE_DISCORD_CLIENT_ID` al
> mismo id que usa presence.nvim (`793271441293967371`) — en ese caso el
> título/logo serán los de Neovim.

## Session Names

By default the plugin shows the session title in Discord. For new unnamed sessions
(which get auto-generated titles like "New session - tidy-wolf"), it falls back to
the project folder name instead of the random slug.

It filters out common non-project directory names (home, diego, root, Users, user)
so sessions started from `~` won't show your username.

Set `OPENCODE_DISCORD_SHOW_SESSION=false` to hide the session/project name entirely.

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

### Discord muestra el título/logo de Neovim cuando estoy en OpenCode

OpenCode y Neovim son apps separadas por defecto (`1462270555586822206` y
`793271441293967371`). Si ves la tarjeta con identidad de Neovim para
OpenCode, es porque el fork está usando el client id de presence.nvim
(override en `OPENCODE_DISCORD_CLIENT_ID` o build con el id compartido).
Reconstruí con el default o setea la env al id de la app "opencode".

### Discord shows OpenCode even when idle in Neovim

OpenCode cede la tarjeta cuando pasa **2 segundos sin actividad real**
(mensajes, tools o streaming). Si ves OpenCode aún visible, es porque hubo
actividad reciente o el watchdog no corrió (reiniciá OpenCode). El valor se
ajusta en `YIELD_DEBOUNCE_MS` en `src/index.ts`.

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
