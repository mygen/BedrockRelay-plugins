import { system, world } from "@minecraft/server";
import { postToDiscord, prettyName } from "../relay/api.js";

/**
 * Audit — a BedrockRelay plugin.
 * Posts when someone does something risky: TNT, end crystals, lava, fire,
 * withers, killing villagers, and (switched off to start with) rare ores,
 * shulker boxes and netherite blocks. The owner switches each kind of post on
 * or off on the dashboard. Repeats within a few seconds become one post, and
 * /audit lists what happened recently. It only watches: it never stops
 * anything happening.
 */

const ID = "audit";

/** Each kind of post: its dashboard switch, its look, and how many seconds of repeats become one post. */
const KINDS = {
  tnt: { name: "TNT placed", emoji: "💣", color: 0xed4245, merge: 10 },
  crystal: { name: "End crystals placed", emoji: "💥", color: 0xed4245, merge: 10 },
  anchor: { name: "Respawn anchors placed outside the Nether", emoji: "⚓", color: 0xed4245, merge: 10 },
  lava: { name: "Lava poured", emoji: "🌋", color: 0xe67e22, merge: 10 },
  fire: { name: "Fire started", emoji: "🔥", color: 0xe67e22, merge: 10 },
  wither: { name: "Withers spawned", emoji: "💀", color: 0x9b59b6, merge: 10 },
  villager: { name: "Villagers killed by players", emoji: "🧑‍🌾", color: 0xfee75c, merge: 10 },
  ores: { name: "Diamonds and ancient debris mined", emoji: "⛏️", color: 0x3498db, merge: 60, off: true },
  shulker: { name: "Shulker boxes broken", emoji: "📦", color: 0x9b59b6, merge: 10, off: true },
  netherite: { name: "Netherite blocks placed", emoji: "🧱", color: 0x5d5d5d, merge: 10, off: true },
};

const ORES = new Set(["minecraft:diamond_ore", "minecraft:deepslate_diamond_ore", "minecraft:ancient_debris"]);
/** Items whose use on a block is watched, or remembered to say who made a crystal or wither appear. */
const USED_ITEMS = new Set(["minecraft:lava_bucket", "minecraft:flint_and_steel", "minecraft:fire_charge", "minecraft:end_crystal", "minecraft:wither_skeleton_skull"]);
/** Things people light all the time: portals, candles, campfires. */
const NORMAL_TO_LIGHT = /obsidian|candle|campfire/;

// Discord would read a player called Big_Tnt_Fan as italics.
const escape = (text) => String(text).replace(/[\\*_~`|>]/g, "\\$&");

/* ---------------- Merging repeats into one post ---------------- */

const bursts = new Map();
const history = [];
/** Items used on blocks in the last two seconds, to say who made a crystal or wither appear. */
const uses = [];

/** Something happened. `action` follows the player's name, or is the whole sentence when nobody is named. */
function note(kind, { who = null, action, dimension, location }) {
  const key = `${kind}|${who}|${action}|${dimension.id}`;
  const burst = bursts.get(key);
  if (burst) { burst.count++; return; }
  if (bursts.size >= 200) return;
  const { x, y, z } = location;
  bursts.set(key, {
    kind, who, action, count: 1, dimension: dimension.id,
    location: [Math.floor(x), Math.floor(y), Math.floor(z)],
    started: system.currentTick, time: Date.now(),
  });
}

const sentence = (burst) => `${burst.who ? `**${escape(burst.who)}** ` : ""}${burst.action}${burst.count > 1 ? ` ×${burst.count}` : ""}`;
const where = (burst) => `${prettyName(burst.dimension)} · ${burst.location.join(", ")}`;

system.runInterval(() => {
  const now = system.currentTick;
  for (const [key, burst] of bursts) {
    if (now - burst.started < KINDS[burst.kind].merge * 20) continue;
    bursts.delete(key);
    history.push(burst);
    if (history.length > 50) history.shift();
    const kind = KINDS[burst.kind];
    postToDiscord({
      plugin: ID,
      kind: burst.kind,
      embed: {
        color: kind.color,
        ...(burst.who ? { author: { name: burst.who, player: burst.who } } : {}),
        description: `${kind.emoji} ${sentence(burst)}`,
        footer: { text: where(burst) },
      },
    });
  }
  // Uses are only needed for the moment it takes a crystal or wither to appear.
  while (uses.length && now - uses[0].tick > 40) uses.shift();
}, 20);

/* ---------------- Watching ---------------- */

/** Who most recently used this item on a block near here, in the last two seconds. */
function usedNear(item, dimension, location, radius) {
  for (let i = uses.length - 1; i >= 0; i--) {
    const use = uses[i];
    if (use.item !== item || use.dimension !== dimension.id) continue;
    if (Math.hypot(use.location.x - location.x, use.location.y - location.y, use.location.z - location.z) <= radius) return use.player;
  }
  return null;
}

// Read-only here: only remember, never change the world.
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
  if (event.isFirstEvent === false) return; // holding the button down repeats the event
  const item = event.itemStack?.typeId;
  if (!USED_ITEMS.has(item)) return;
  const { player, block } = event;
  uses.push({ item, player: player.name, dimension: block.dimension.id, location: block.location, tick: system.currentTick });
  if (item === "minecraft:lava_bucket") {
    note("lava", { who: player.name, action: "poured **lava**", dimension: block.dimension, location: block.location });
  } else if ((item === "minecraft:flint_and_steel" || item === "minecraft:fire_charge") && !NORMAL_TO_LIGHT.test(block.typeId)) {
    note("fire", { who: player.name, action: `used **${prettyName(item)}** on **${prettyName(block.typeId)}**`, dimension: block.dimension, location: block.location });
  }
});

world.afterEvents.playerPlaceBlock.subscribe(({ player, block, dimension }) => {
  const type = block.typeId;
  const at = { who: player.name, dimension, location: block.location };
  if (type === "minecraft:tnt") note("tnt", { ...at, action: "placed **TNT**" });
  else if (type === "minecraft:netherite_block") note("netherite", { ...at, action: "placed a **Netherite Block**" });
  else if (type === "minecraft:respawn_anchor" && dimension.id !== "minecraft:nether") {
    note("anchor", { ...at, action: "placed a **respawn anchor**" });
  }
});

world.afterEvents.playerBreakBlock.subscribe(({ player, brokenBlockPermutation, block, dimension }) => {
  const type = brokenBlockPermutation.type.id;
  const at = { who: player.name, dimension, location: block.location };
  if (ORES.has(type)) note("ores", { ...at, action: `mined **${prettyName(type)}**` });
  else if (type.endsWith("shulker_box")) note("shulker", { ...at, action: `broke a **${prettyName(type)}**` });
});

world.afterEvents.entitySpawn.subscribe(({ entity, cause }) => {
  if (cause === "Loaded") return; // one that was already there, in a chunk that just loaded
  if (entity.typeId !== "minecraft:wither" && entity.typeId !== "minecraft:ender_crystal") return;
  let dimension, location;
  try { ({ dimension, location } = entity); } catch { return; } // already gone
  if (entity.typeId === "minecraft:ender_crystal") {
    // Only crystals a player placed: the End makes its own.
    const by = usedNear("minecraft:end_crystal", dimension, location, 3);
    if (by) note("crystal", { who: by, action: "placed an **end crystal**", dimension, location });
    return;
  }
  const by = usedNear("minecraft:wither_skeleton_skull", dimension, location, 6);
  if (by) { note("wither", { who: by, action: "spawned a **wither**", dimension, location }); return; }
  // Nobody placed a skull here (a command, perhaps): say who was nearby, not who did it.
  const near = dimension.getPlayers({ location, maxDistance: 32, closest: 1 })[0]?.name;
  note("wither", { action: `A **wither** appeared${near ? ` near **${escape(near)}**` : ""}`, dimension, location });
});

world.afterEvents.entityDie.subscribe(({ deadEntity, damageSource }) => {
  const killer = damageSource?.damagingEntity;
  if (killer?.typeId !== "minecraft:player") return;
  let dimension, location;
  try { ({ dimension, location } = deadEntity); } catch { ({ dimension, location } = killer); }
  note("villager", { who: killer.name, action: "killed a **villager**", dimension, location });
}, { entityTypes: ["minecraft:villager_v2", "minecraft:villager"] });

/* ---------------- The plugin ---------------- */

export default {
  id: "audit",
  name: "Audit",
  version: "1.0.0",
  description: "Posts when someone places TNT or end crystals, pours lava, starts fires, spawns a wither or kills a villager, and optionally mines diamonds, breaks shulker boxes or places netherite. It only watches: nothing is stopped.",
  privacy: "Posts who did what, and where, which can give away where someone's base is.",
  posts: "Risky things players do, each switchable: TNT, end crystals, respawn anchors, lava, fire, withers, villagers, rare ores, shulker boxes, netherite.",
  postKinds: Object.entries(KINDS).map(([id, kind]) => ({ id, name: kind.name, default: !kind.off })),
  commands: [
    {
      name: "audit",
      description: "What happened recently in the world",
      options: [{ name: "player", type: "player", description: "Only what this player did", required: false }],
      run({ player }) {
        const wanted = player?.toLowerCase();
        const recent = [...history, ...bursts.values()]
          .filter((burst) => !wanted || burst.who?.toLowerCase() === wanted)
          .sort((a, b) => b.time - a.time)
          .slice(0, 15);
        if (!recent.length) return player ? `Nothing from **${escape(player)}** since the Minecraft server started.` : "Nothing yet since the Minecraft server started.";
        return {
          embed: {
            color: 0x5865f2,
            title: player ? `Audit · ${player}` : "Audit",
            description: recent.map((burst) => `<t:${Math.floor(burst.time / 1000)}:R> ${KINDS[burst.kind].emoji} ${sentence(burst)} · ${where(burst)}`).join("\n"),
            footer: { text: "Since the Minecraft server started, including kinds switched off for Discord" },
          },
        };
      },
    },
  ],
};
