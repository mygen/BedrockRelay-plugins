# Submitting a plugin

Open a pull request that adds one folder, `plugins/<id>/`, containing
`plugin.js` and `plugin.json`.

**Licence:** everything in this repository is published under the
[MIT licence](LICENSE). By opening a pull request you agree that your
contribution, including every later update to it, is licensed under MIT, and
you confirm that you wrote it or otherwise have the right to license it that
way. Don't submit code copied from somewhere with a different licence.

Read the [developer guide](https://bedrockrelay.com/developers.html) first. It
explains the plugin format, and the best practices your plugin will be
reviewed against.

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
  "commands": ["/health <player>"],
  "screenshots": [
    { "file": "discord.png", "caption": "/health answering in Discord" }
  ]
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
| `posts` | if it posts by itself | What it posts with `postToDiscord`, e.g. "Playtime milestones." Shown in the catalog. Must match `posts` in `plugin.js`. |
| `homepage` | no | An `https` link to your source or docs. |
| `minPackVersion` | yes | The oldest BedrockRelay pack it works with: `0.4.0` if it uses `choices`, `public`, `confirm`, `posts` or `linkedPlayer`, otherwise `0.3.0`. |
| `commands` | yes | How each command is used, for the catalog page. |
| `screenshots` | no | Up to 4 pictures of the plugin in Discord, shown on its catalog card. Each is a `file` in the plugin's folder (PNG, JPEG or WebP, under 1 MB) and a `caption` saying what it shows, which is also its alt text. Crop to the message itself; the card shows the top of each picture, and a click shows it whole. |

## What reviewers check

- It does what its description says, and nothing else.
- It follows the best practices: quick `run()`, handles missing players and bad input, prefixes anything it stores with its id.
- No network access, no `@minecraft/server-net` or `@minecraft/server-admin`, no reading server secrets or variables.
- It declares `privacy` if it reveals anything about players.
- Anything that changes the world is stated in its description and asks first with `confirm`.
- Only answers meant for everyone are `public`, and it only posts by itself when it declares `posts`.
- The code is readable: no minified, obfuscated or generated code, and a single file.
- Screenshots, if any, show the plugin as it really looks, with no personal details or other people's names visible unless they agreed.

## Updates

Change `plugin.js`, and raise `version` in both files. Updates are reviewed like
new plugins. Once merged, owners see **Update** on their dashboard.
