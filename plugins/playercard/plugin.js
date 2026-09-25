import { system, world } from "@minecraft/server";
import { findPlayer, prettyName } from "../relay/api.js";

/**
 * Player card — a BedrockRelay plugin.
 * /player [player] shows how someone is doing right now: health, hunger,
 * level, game mode, effects, device and how long they've been on.
 */

const DIMENSIONS = { "minecraft:overworld": "Overworld", "minecraft:nether": "Nether", "minecraft:the_end": "The End" };
const DEVICES = { Desktop: "PC", Mobile: "Phone or tablet", Console: "Console" };
const NUMERALS = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

/** When each player joined, by id, so the card can say how long they've been on. */
const joinedAt = new Map();
// Players already on when the plugin loads (after a /reload). Not during startup, when the world can't be read yet.
system.run(() => { for (const player of world.getAllPlayers()) if (!joinedAt.has(player.id)) joinedAt.set(player.id, Date.now()); });
world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => { if (initialSpawn) joinedAt.set(player.id, Date.now()); });
world.afterEvents.playerLeave.subscribe(({ playerId }) => joinedAt.delete(playerId));

/** Ten symbols for a value out of a maximum, like the game's own bars. */
function bar(value, max, full, empty) {
  const filled = Math.max(0, Math.min(10, Math.round((value / max) * 10)));
  return full.repeat(filled) + empty.repeat(10 - filled);
}

function duration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just joined";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** A component's current value, or undefined when this player doesn't have it. */
function current(player, id) {
  try { return player.getComponent(id)?.currentValue; } catch { return undefined; }
}

export default {
  id: "playercard",
  name: "Player card",
  version: "1.0.0",
  description: "How a player is doing right now: health, hunger, level, game mode, effects, device and time online.",
  commands: [
    {
      name: "player",
      description: "How a player is doing right now",
      options: [{ name: "player", type: "player", description: "Who (leave empty for you, once you've used /relay link)", required: false }],
      run({ player: typed }, { linkedPlayer }) {
        const name = typed ?? linkedPlayer;
        if (!name) return "Say which player, or link your own with `/relay link` so this knows who you are.";
        const player = findPlayer(name);
        if (!player) return `**${name}** isn't online right now.`;

        const health = current(player, "minecraft:health");
        const hunger = current(player, "minecraft:player.hunger");
        const effects = player.getEffects().map((effect) => {
          const seconds = Math.floor(effect.duration / 20);
          const time = effect.duration < 0 || seconds > 3600 ? "" : ` (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})`;
          return `${effect.displayName || prettyName(effect.typeId)} ${NUMERALS[effect.amplifier + 1] ?? effect.amplifier + 1}${time}`;
        });
        let device;
        try { device = DEVICES[player.clientSystemInfo.platformType]; } catch { /* not reported */ }

        const fields = [];
        if (health !== undefined && health <= 0) fields.push({ name: "Health", value: "💀 Dead, waiting to respawn", inline: false });
        else if (health !== undefined) fields.push({ name: "Health", value: `${bar(health, 20, "❤️", "🖤")} ${Math.ceil(health)}/20`, inline: false });
        if (hunger !== undefined) fields.push({ name: "Hunger", value: `${bar(hunger, 20, "🍗", "▫️")} ${Math.ceil(hunger)}/20`, inline: false });
        fields.push(
          { name: "Level", value: `${player.level} (${Math.floor((player.xpEarnedAtCurrentLevel / Math.max(1, player.totalXpNeededForNextLevel)) * 100)}% to ${player.level + 1})`, inline: true },
          { name: "Game mode", value: prettyName(String(player.getGameMode())), inline: true },
          { name: "Dimension", value: DIMENSIONS[player.dimension.id] ?? prettyName(player.dimension.id), inline: true },
        );
        if (device) fields.push({ name: "Playing on", value: device, inline: true });
        if (joinedAt.has(player.id)) fields.push({ name: "Online for", value: duration(Date.now() - joinedAt.get(player.id)), inline: true });
        if (player.isSleeping) fields.push({ name: "Right now", value: "Sleeping", inline: true });
        fields.push({ name: "Effects", value: effects.length ? effects.join("\n") : "_none_", inline: false });

        return {
          embed: {
            color: 0x57f287,
            title: player.name,
            thumbnail: { player: player.name },
            fields,
          },
        };
      },
    },
  ],
};
