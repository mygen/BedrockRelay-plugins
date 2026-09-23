# BedrockRelay plugins

The public catalog of reviewed [BedrockRelay](https://bedrockrelay.com) plugins.
Everything here appears on the **Plugins** page of the BedrockRelay dashboard,
where server owners install plugins onto their Minecraft servers.

A plugin adds Discord commands for a Minecraft Bedrock world, such as
`/location <player>`. It runs on the Minecraft server with the ordinary
Minecraft Script API; BedrockRelay handles everything Discord.

- **Write a plugin:** see the [developer guide](https://bedrockrelay.com/developers.html).
- **Submit one:** see [CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

```
plugins/<id>/
  plugin.js     the plugin, exactly as installed on a Minecraft server
  plugin.json   how it appears in the catalog
```

Owners install exactly the `plugin.js` that was reviewed and merged here.

## Licence

Every plugin in this repository is published under the [MIT licence](LICENSE),
so anyone can use, change and share it as they like. By submitting a plugin,
you agree to license it under MIT and confirm you have the right to. This
applies to the plugins here only, not to BedrockRelay itself.
