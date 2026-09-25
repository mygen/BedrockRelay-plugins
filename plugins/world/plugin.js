import { system, world } from "@minecraft/server";
import { prettyName } from "../relay/api.js";

/**
 * World — a BedrockRelay plugin.
 * /world shows the state of the world: day, time, weather, moon, difficulty,
 * game rules, how the server is running and what's loaded in each dimension.
 */

const DIMENSIONS = [["minecraft:overworld", "Overworld"], ["minecraft:nether", "Nether"], ["minecraft:the_end", "The End"]];
// Numbered as the Script API numbers them.
const MOON = ["🌕 Full moon", "🌖 Waning gibbous", "🌓 First quarter", "🌘 Waning crescent", "🌑 New moon", "🌒 Waxing crescent", "🌗 Last quarter", "🌔 Waxing gibbous"];
const WEATHER = { Clear: "☀️ Clear", Rain: "🌧️ Rain", Thunder: "⛈️ Thunderstorm" };

/** Ticks per second, measured over the last ten seconds. 20 is a server keeping up. */
const samples = [];
let last = Date.now();
system.runInterval(() => {
  const now = Date.now();
  samples.push(Math.min(20, 20000 / Math.max(1, now - last)));
  if (samples.length > 10) samples.shift();
  last = now;
}, 20);
const tps = () => (samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 20);

function clock(ticks) {
  // Tick 0 is 6:00 in the morning.
  const minutes = Math.floor(((ticks / 1000 + 6) % 24) * 60);
  const phase = ticks < 12000 ? "Day" : ticks < 13000 ? "Sunset" : ticks < 23000 ? "Night" : "Sunrise";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")} (${phase})`;
}

function loaded(dimensionId) {
  let entities;
  try { entities = world.getDimension(dimensionId).getEntities(); } catch { return null; }
  const counts = new Map();
  let items = 0;
  for (const entity of entities) {
    if (entity.typeId === "minecraft:item") { items++; continue; }
    if (entity.typeId === "minecraft:player") continue;
    counts.set(entity.typeId, (counts.get(entity.typeId) ?? 0) + 1);
  }
  const mobs = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([typeId, amount]) => `${prettyName(typeId)} ${amount}`);
  return { mobs, items, top };
}

const onOff = (value) => (value ? "On" : "Off");
const count = (amount, noun) => `${amount} ${noun}${amount === 1 ? "" : "s"}`;

export default {
  id: "world",
  name: "World",
  version: "1.0.0",
  description: "The state of the world: day, time, weather, moon, difficulty, game rules, server speed and what's loaded in each dimension.",
  commands: [
    {
      name: "world",
      description: "Day, time, weather and how the server is running",
      public: true,
      options: [],
      run() {
        const players = world.getAllPlayers();
        const speed = tps();
        const fields = [
          { name: "Day", value: String(world.getDay()), inline: true },
          { name: "Time", value: clock(world.getTimeOfDay()), inline: true },
          { name: "Weather", value: WEATHER[world.getDimension("minecraft:overworld").getWeather()] ?? "Unknown", inline: true },
          { name: "Moon", value: MOON[world.getMoonPhase()] ?? "Unknown", inline: true },
          { name: "Difficulty", value: String(world.getDifficulty()), inline: true },
          { name: "Server speed", value: `${speed >= 19 ? "🟢" : speed >= 15 ? "🟡" : "🔴"} ${speed.toFixed(1)} TPS`, inline: true },
        ];
        const rules = world.gameRules;
        fields.push({
          name: "Game rules",
          value: [`Keep inventory: **${onOff(rules.keepInventory)}**`, `PvP: **${onOff(rules.pvp)}**`, `Mob griefing: **${onOff(rules.mobGriefing)}**`,
            `Daylight cycle: **${onOff(rules.doDaylightCycle)}**`].join(" · "),
          inline: false,
        });
        for (const [id, label] of DIMENSIONS) {
          const here = players.filter((player) => player.dimension.id === id).length;
          const stats = loaded(id);
          if (!stats) continue;
          const parts = [count(here, "player"), count(stats.mobs, "mob"), count(stats.items, "dropped item")];
          fields.push({ name: label, value: `${parts.join(" · ")}${stats.top.length ? `\nMost common: ${stats.top.join(", ")}` : ""}`, inline: false });
        }
        return {
          embed: {
            color: 0x5865f2,
            title: "The world right now",
            fields,
            footer: { text: "Mobs and items count only what's loaded, near players." },
          },
        };
      },
    },
  ],
};
