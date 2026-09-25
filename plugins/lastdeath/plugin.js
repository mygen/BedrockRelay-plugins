import { system, world } from "@minecraft/server";
import { prettyName } from "../relay/api.js";

/**
 * Last death — a BedrockRelay plugin.
 * /lastdeath [player] shows where and how a player last died, and what they
 * dropped, so they can find their things. It remembers each player's last
 * three deaths in the world itself, so it works while they're offline too.
 */

const KEEP = 3;
const key = (name) => `bedrockrelay:lastdeath:${name.toLowerCase()}`;
const DIMENSIONS = { "minecraft:overworld": "Overworld", "minecraft:nether": "Nether", "minecraft:the_end": "The End" };

const CAUSES = {
  fall: "fell from a high place", lava: "tried to swim in lava", fire: "burned to death", fireTick: "burned to death",
  drowning: "drowned", suffocation: "suffocated in a wall", starve: "starved to death", freezing: "froze to death",
  void: "fell out of the world", blockExplosion: "blew up", entityExplosion: "blew up", magic: "was killed by magic",
  wither: "withered away", lightning: "was struck by lightning", contact: "was pricked to death", flyIntoWall: "hit a wall too fast",
  anvil: "was squashed by an anvil", fallingBlock: "was squashed by a falling block", campfire: "burned to death",
  sonicBoom: "was obliterated by a sonic boom", stalactite: "was skewered by a stalactite", stalagmite: "was impaled on a stalagmite",
};

function describeCause(damageSource) {
  const killer = damageSource?.damagingEntity;
  if (killer) {
    const name = killer.typeId === "minecraft:player" ? killer.name : killer.nameTag || prettyName(killer.typeId);
    return `was killed by ${name}`;
  }
  return CAUSES[damageSource?.cause] ?? "died";
}

function history(name) {
  try { return JSON.parse(String(world.getDynamicProperty(key(name)) ?? "[]")); } catch { return []; }
}

/** Items lying where they died, a tick after the death, when the drop has landed. */
function dropsAt(dimension, location) {
  const counts = new Map();
  let stacks = 0;
  try {
    for (const entity of dimension.getEntities({ type: "minecraft:item", location, maxDistance: 4 })) {
      const item = entity.getComponent("minecraft:item")?.itemStack;
      if (!item) continue;
      stacks++;
      counts.set(item.typeId, (counts.get(item.typeId) ?? 0) + item.amount);
    }
  } catch { /* the area unloaded */ }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([typeId, amount]) => `${prettyName(typeId)} ×${amount}`);
  return { stacks, top, more: Math.max(0, counts.size - top.length) };
}

world.afterEvents.entityDie.subscribe((event) => {
  const player = event.deadEntity;
  if (player?.typeId !== "minecraft:player") return;
  const name = player.name;
  const { x, y, z } = player.location;
  const location = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
  const dimension = player.dimension;
  const death = { at: Date.now(), dimension: dimension.id, ...location, cause: describeCause(event.damageSource) };
  system.runTimeout(() => {
    if (!world.gameRules.keepInventory) death.drops = dropsAt(dimension, { x: x, y: y, z: z });
    else death.kept = true;
    try { world.setDynamicProperty(key(name), JSON.stringify([death, ...history(name)].slice(0, KEEP))); } catch { /* storage full */ }
  }, 2);
});

function field(death, index) {
  const when = `<t:${Math.floor(death.at / 1000)}:R>`;
  const lines = [
    `${when} ${death.cause}`,
    `**${DIMENSIONS[death.dimension] ?? prettyName(death.dimension)}** at **${death.x}, ${death.y}, ${death.z}**`,
  ];
  if (death.kept) lines.push("Keep inventory is on, so nothing was dropped.");
  else if (death.drops?.stacks) {
    lines.push(`Dropped ${death.drops.stacks} ${death.drops.stacks === 1 ? "stack" : "stacks"}: ${death.drops.top.join(", ")}${death.drops.more ? `, and ${death.drops.more} more` : ""}`);
  } else if (death.drops) lines.push("Nothing was dropped.");
  return { name: index === 0 ? "Most recent" : "Before that", value: lines.join("\n") };
}

export default {
  id: "lastdeath",
  name: "Last death",
  version: "1.0.0",
  description: "Where and how a player last died, and what they dropped, so they can get their things back.",
  privacy: "Shows the coordinates of where a player died, which can be near their base.",
  commands: [
    {
      name: "lastdeath",
      description: "Where a player last died and what they dropped",
      options: [{ name: "player", type: "player", description: "Whose death (leave empty for yours, once you've used /relay link)", required: false }],
      run({ player }, { linkedPlayer }) {
        const name = player ?? linkedPlayer;
        if (!name) return "Say which player, or link your own with `/relay link` so this knows who you are.";
        const deaths = history(name);
        const online = world.getAllPlayers().find((item) => item.name.toLowerCase() === name.toLowerCase());
        const shown = online?.name ?? name;
        if (!deaths.length) return `No deaths recorded for **${shown}** since this plugin was installed.`;
        const newest = deaths[0];
        const fresh = !newest.kept && newest.drops?.stacks && Date.now() - newest.at < 5 * 60 * 1000;
        return {
          embed: {
            color: 0xed4245,
            author: { name: `${shown}'s last ${deaths.length === 1 ? "death" : `${deaths.length} deaths`}`, player: shown },
            fields: deaths.map(field),
            footer: { text: fresh
              ? "Dropped items vanish 5 minutes after a death while that area is loaded. Hurry!"
              : "Dropped items vanish 5 minutes after a death while that area is loaded." },
          },
        };
      },
    },
  ],
};
