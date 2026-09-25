import { system, world } from "@minecraft/server";
import { postToDiscord } from "../relay/api.js";

/**
 * Leaderboards — a BedrockRelay plugin.
 * Counts playtime, deaths, kills, blocks and distance for every player, kept
 * in the world itself so offline players stay on the board. /top shows the
 * top ten for one statistic, /stats one player's numbers and ranks. It can
 * also announce playtime milestones in the channels the owner picks.
 */

const ID = "leaderboards";
const PREFIX = "bedrockrelay:lb:";
const MILESTONE_HOURS = [10, 25, 50, 100, 250, 500, 1000];

const hours = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
// By hand: the game's JavaScript has no locale data for toLocaleString.
const whole = (value) => String(Math.floor(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Each statistic: its key in storage, its name, and how to show a value. */
const STATS = {
  playtime: { key: "pt", name: "Playtime", show: hours },
  deaths: { key: "d", name: "Deaths", show: whole },
  kills: { key: "k", name: "Mobs killed", show: whole },
  pvp: { key: "pk", name: "Players killed", show: whole },
  mined: { key: "bm", name: "Blocks mined", show: whole },
  placed: { key: "bp", name: "Blocks placed", show: whole },
  distance: { key: "dist", name: "Distance travelled", show: (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.floor(m)} m`) },
};

/* ---------------- Storage: one record per player, cached, saved every 30 s ---------------- */

const cache = new Map();
const dirty = new Set();

function record(id, name) {
  let entry = cache.get(id);
  if (!entry) {
    try { entry = JSON.parse(String(world.getDynamicProperty(PREFIX + id) ?? "null")); } catch { entry = null; }
    entry ??= { n: name ?? "Unknown" };
    cache.set(id, entry);
  }
  if (name && entry.n !== name) { entry.n = name; dirty.add(id); }
  return entry;
}

function add(player, key, amount = 1) {
  const entry = record(player.id, player.name);
  entry[key] = (entry[key] ?? 0) + amount;
  dirty.add(player.id);
  return entry;
}

function save() {
  for (const id of dirty) {
    try { world.setDynamicProperty(PREFIX + id, JSON.stringify(cache.get(id))); } catch { /* storage full: keep counting in memory */ }
  }
  dirty.clear();
}
system.runInterval(save, 600);

/** Every player ever counted, offline ones included. */
function everyone() {
  for (const property of world.getDynamicPropertyIds()) {
    if (property.startsWith(PREFIX)) record(property.slice(PREFIX.length));
  }
  return [...cache.values()];
}

/* ---------------- Counting ---------------- */

const lastPosition = new Map();
let lastTick = Date.now();
system.runInterval(() => {
  const now = Date.now();
  // Real seconds, capped so a stalled server doesn't hand out free hours.
  const seconds = Math.min(5, (now - lastTick) / 1000);
  lastTick = now;
  for (const player of world.getAllPlayers()) {
    const entry = add(player, "pt", seconds);
    const reached = MILESTONE_HOURS.filter((h) => entry.pt >= h * 3600).pop();
    if (reached && reached > (entry.mh ?? 0)) {
      // A new install counts from zero, so this never announces old history.
      entry.mh = reached;
      postToDiscord({
        plugin: ID,
        embed: {
          color: 0xfee75c,
          author: { name: player.name, player: player.name },
          description: `🎉 **${player.name}** has played for **${reached} hours**!`,
        },
      });
    }
    const { x, y, z } = player.location;
    const before = lastPosition.get(player.id);
    if (before && before.dimension === player.dimension.id) {
      const moved = Math.hypot(x - before.x, y - before.y, z - before.z);
      // Bigger jumps are teleports, not travel.
      if (moved > 0.1 && moved < 100) add(player, "dist", moved);
    }
    lastPosition.set(player.id, { dimension: player.dimension.id, x, y, z });
  }
}, 20);

world.afterEvents.playerLeave.subscribe(({ playerId }) => lastPosition.delete(playerId));
world.afterEvents.playerBreakBlock.subscribe(({ player }) => add(player, "bm"));
world.afterEvents.playerPlaceBlock.subscribe(({ player }) => add(player, "bp"));
world.afterEvents.entityDie.subscribe(({ deadEntity, damageSource }) => {
  if (deadEntity?.typeId === "minecraft:player") add(deadEntity, "d");
  const killer = damageSource?.damagingEntity;
  if (killer?.typeId === "minecraft:player" && killer !== deadEntity) add(killer, deadEntity?.typeId === "minecraft:player" ? "pk" : "k");
});

/* ---------------- Commands ---------------- */

const MEDALS = ["🥇", "🥈", "🥉"];
const ranked = (stat) => everyone().filter((entry) => (entry[stat.key] ?? 0) > 0).sort((a, b) => b[stat.key] - a[stat.key]);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

export default {
  id: "leaderboards",
  name: "Leaderboards",
  version: "1.0.0",
  description: "Top tens for playtime, deaths, kills, blocks mined and placed, and distance travelled, offline players included.",
  posts: "Playtime milestones: when someone reaches 10, 25, 50, 100, 250, 500 or 1,000 hours.",
  commands: [
    {
      name: "top",
      description: "The top ten players for one statistic",
      public: true,
      options: [{
        name: "stat", type: "string", description: "Which statistic", required: true,
        choices: Object.entries(STATS).map(([value, stat]) => ({ name: stat.name, value })),
      }],
      run({ stat: which }, { linkedPlayer }) {
        const stat = STATS[which];
        if (!stat) return `Choose one of: ${Object.values(STATS).map((item) => item.name).join(", ")}.`;
        const board = ranked(stat);
        if (!board.length) return `Nobody has any ${stat.name.toLowerCase()} yet.`;
        const lines = board.slice(0, 10).map((entry, index) => `${MEDALS[index] ?? `\`${String(index + 1).padStart(2)}\``} **${entry.n}** · ${stat.show(entry[stat.key])}`);
        const mine = linkedPlayer ? board.findIndex((entry) => same(entry.n, linkedPlayer)) : -1;
        if (mine >= 10) lines.push(`\nYou: #${mine + 1} · ${stat.show(board[mine][stat.key])}`);
        return {
          embed: {
            color: 0xfee75c,
            title: `🏆 ${stat.name}`,
            description: lines.join("\n"),
            thumbnail: { player: board[0].n },
            footer: { text: `${board.length} ${board.length === 1 ? "player" : "players"} on the board` },
          },
        };
      },
    },
    {
      name: "stats",
      description: "A player's numbers and where they rank",
      public: true,
      options: [{ name: "player", type: "player", description: "Who (leave empty for you, once you've used /relay link)", required: false }],
      run({ player }, { linkedPlayer }) {
        const name = player ?? linkedPlayer;
        if (!name) return "Say which player, or link your own with `/relay link` so this knows who you are.";
        const entry = everyone().find((item) => same(item.n, name));
        if (!entry) return `No statistics for **${name}** yet.`;
        const fields = Object.values(STATS).map((stat) => {
          const value = entry[stat.key] ?? 0;
          const rank = value > 0 ? ranked(stat).indexOf(entry) + 1 : 0;
          return { name: stat.name, value: `${stat.show(value)}${rank ? ` · #${rank}` : ""}`, inline: true };
        });
        return { embed: { color: 0xfee75c, title: entry.n, thumbnail: { player: entry.n }, fields } };
      },
    },
  ],
};
