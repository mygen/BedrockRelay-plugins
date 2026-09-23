import { findPlayer } from "../relay/api.js";

/**
 * Location — a BedrockRelay plugin.
 * /location <player> shows which dimension a player is in and where.
 */

const DIMENSIONS = {
  "minecraft:overworld": { name: "the Overworld", color: 0x57f287 },
  "minecraft:nether": { name: "the Nether", color: 0xed4245 },
  "minecraft:the_end": { name: "the End", color: 0x9b59b6 },
};

export default {
  id: "location",
  name: "Location",
  version: "1.0.0",
  description: "Find where a player is: their dimension and coordinates.",
  privacy: "Coordinates can give away where someone's base is, so keep this to people you trust.",
  commands: [
    {
      name: "location",
      description: "Show where a player is",
      options: [{ name: "player", type: "player", description: "The player's name", required: true }],
      run({ player: name }) {
        const player = findPlayer(name);
        if (!player) return `**${name}** isn't online right now.`;
        const { x, y, z } = player.location;
        const dimension = DIMENSIONS[player.dimension.id] ?? { name: player.dimension.id, color: 0x5865f2 };
        return {
          embed: {
            color: dimension.color,
            description: `**${player.name}** is in ${dimension.name} at **${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}**`,
          },
        };
      },
    },
  ],
};
