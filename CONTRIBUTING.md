# Submitting a plugin

Open a pull request that adds one folder, `plugins/<id>/`, containing
`plugin.js` and `plugin.json`. Read the
[developer guide](https://bedrockrelay.com/developers.html) first. It explains
the plugin format, and the best practices your plugin will be reviewed against.

## plugin.json

```json
{
  "id": "health",
  "name": "Health",
  "version": "1.0.0",
  "author": "Your name",
  "description": "Check a player's health from Discord.",
  "privacy": "Shows a player's current health.",
  "homepage": "https://github.com/you/health",
  "minPackVersion": "0.3.0",
  "commands": ["/health <player>"]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Must match the folder name, and the `id` in `plugin.js`. Lowercase letters, numbers and dashes. |
| `name` | yes | Shown in the catalog. |
| `version` | yes | `major.minor.patch`. Must match the `version` in `plugin.js`. |
| `author` | yes | You, or your team. |
| `description` | yes | One or two sentences. |
| `privacy` | if it reveals anything about players | Shown beside the plugin's switch. |
| `homepage` | no | An `https` link to your source or docs. |
| `minPackVersion` | yes | The oldest BedrockRelay pack it works with. `0.3.0` for now. |
| `commands` | yes | How each command is used, for the catalog page. |

## What reviewers check

- It does what its description says, and nothing else.
- It follows the best practices: quick `run()`, handles missing players and bad input, prefixes anything it stores with its id.
- No network access, no `@minecraft/server-net` or `@minecraft/server-admin`, no reading server secrets or variables.
- It declares `privacy` if it reveals anything about players.
- Anything that changes the world is stated in its description.
- The code is readable: no minified, obfuscated or generated code, and a single file.

## Updates

Change `plugin.js`, and raise `version` in both files. Updates are reviewed like
new plugins. Once merged, owners see **Update** on their dashboard.
