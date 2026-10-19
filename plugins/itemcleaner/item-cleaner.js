import { system, world } from "@minecraft/server";

const KEY = "item-cleaner:minutes";
const MAX_MINUTES = 365 * 1440;
const DIMENSIONS = ["overworld", "nether", "the_end"];
let minutes = 0;
let ready = false;
let due = 0;
let warned = new Set();
let sweep = null;
let last = "No cleanup since this world started.";

function duration(totalSeconds) {
  let remaining = Math.max(0, Math.ceil(totalSeconds));
  const parts = [];
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]]) {
    const count = Math.floor(remaining / size);
    remaining %= size;
    if (count) parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
  }
  return parts.join(", ") || "0 minutes";
}

function announce(message) {
  try { world.sendMessage(`§e[Item Cleaner]§r ${message}`); }
  catch (error) { console.warn(`[item-cleaner] Announcement failed: ${error}`); }
}

function schedule() {
  due = minutes ? Date.now() + minutes * 60000 : 0;
  warned = new Set();
}

// Delay property access until the world is available. Never delete on startup.
system.run(() => {
  try {
    const saved = world.getDynamicProperty(KEY);
    minutes = Number.isInteger(saved) && saved >= 1 && saved <= MAX_MINUTES ? saved : 0;
    schedule();
    ready = true;
  } catch (error) {
    console.warn(`[item-cleaner] Settings unavailable; cleaner disabled: ${error}`);
  }
});

// Spread removals across ticks, and query one dimension at a time.
system.runInterval(() => {
  if (!ready || !minutes) return;
  if (sweep) {
    if (sweep.index >= sweep.items.length) {
      if (sweep.dimension >= DIMENSIONS.length) {
        last = `Removed ${sweep.removed} dropped item stacks; ${sweep.skipped} unavailable entities; ${sweep.errors} dimension errors.`;
        announce(last);
        sweep = null;
        schedule();
        return;
      }
      const dimension = DIMENSIONS[sweep.dimension++];
      sweep.items = [];
      sweep.index = 0;
      try { sweep.items = world.getDimension(dimension).getEntities({ type: "minecraft:item" }); }
      catch (error) {
        sweep.errors++;
        console.warn(`[item-cleaner] Cannot scan ${dimension}: ${error}`);
      }
    }
    const end = Math.min(sweep.index + 100, sweep.items.length);
    while (sweep.index < end) {
      const entity = sweep.items[sweep.index++];
      try {
        if (entity.typeId !== "minecraft:item") continue;
        entity.remove();
        sweep.removed++;
      } catch { sweep.skipped++; } // Picked up, unloaded or despawned since the scan.
    }
    return;
  }
  const left = due - Date.now();
  if (left <= 0) {
    announce("Clearing loaded dropped items now.");
    sweep = { dimension: 0, items: [], index: 0, removed: 0, skipped: 0, errors: 0 };
    return;
  }
  // Choose only the most urgent warning if server ticks were delayed.
  const seconds = left <= 10000 ? 10 : left <= 30000 ? 30 : 0;
  if (seconds && !warned.has(seconds)) {
    warned.add(seconds);
    if (seconds === 10) warned.add(30);
    announce(`Dropped items will be cleared in ${seconds} seconds. Pick up anything you want to keep!`);
  }
}, 1);

function status() {
  if (!ready) return "Settings are not available yet. Check the Minecraft content log.";
  const state = !minutes ? "Disabled." : sweep ? "Cleanup in progress." : `Next cleanup in approximately ${duration(Math.max(1, (due - Date.now()) / 1000))}.`;
  return `Item Cleaner: ${minutes ? `every ${duration(minutes * 60)}.` : "off."} ${state}\n${last}`;
}

export default {
  id: "item-cleaner",
  name: "Item Cleaner",
  version: "1.1.1",
  description: "Automatically deletes loaded dropped items in all three dimensions at an admin-set interval. Warns players first. Disabled until configured; includes death drops and farm output.",
  minPackVersion: "0.4.0",
  platforms: ["server"],
  commands: [
    {
      name: "itemcleaner-set",
      description: "Set cleanup interval, or omit duration to view the saved setting",
      confirm: "Apply the selected days, hours and minutes for automatic item deletion? All zero disables it. Includes death drops.",
      options: [
        { name: "days", type: "integer", description: "Days between cleanups (0-365); omitted means 0", required: false },
        { name: "hours", type: "integer", description: "Hours to add (0-23); omitted means 0", required: false },
        { name: "minutes", type: "integer", description: "Minutes to add (0-1440); omitted means 0", required: false },
      ],
      run(args) {
        if (!ready) return "Settings are not available yet. Check the Minecraft content log.";
        if (args.days === undefined && args.hours === undefined && args.minutes === undefined) return `${status()}\nTo change it, supply days, hours or minutes. Set minutes:0 to disable.`;
        const days = args.days ?? 0;
        const hours = args.hours ?? 0;
        const mins = args.minutes ?? 0;
        if (![days, hours, mins].every(Number.isInteger) || days < 0 || days > 365 || hours < 0 || hours > 23 || mins < 0 || mins > 1440) return "Enter whole numbers: days 0-365, hours 0-23, minutes 0-1440.";
        const value = days * 1440 + hours * 60 + mins;
        if (value > MAX_MINUTES) return "The total interval cannot exceed 365 days.";
        try { world.setDynamicProperty(KEY, value); }
        catch { return "Could not save the setting. The current schedule has not changed."; }
        minutes = value;
        sweep = null;
        schedule();
        announce(minutes ? `Automatic dropped-item cleanup enabled: every ${duration(minutes * 60)}.` : "Automatic dropped-item cleanup disabled.");
        return minutes ? `Saved: clear loaded dropped items every ${duration(minutes * 60)}. First cleanup in ${duration(minutes * 60)}.` : "Saved: automatic cleanup disabled. Any remaining cleanup work was cancelled.";
      },
    },
    {
      name: "itemcleaner-status",
      description: "Show the saved cleanup interval and next cleanup",
      options: [],
      run() {
        if (!ready) return "Settings are not available yet. Check the Minecraft content log.";
        return status();
      },
    },
  ],
};
