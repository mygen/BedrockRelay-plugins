import { EquipmentSlot } from "@minecraft/server";
import { findPlayer, prettyName } from "../relay/api.js";

/**
 * Inventory — a BedrockRelay plugin.
 * /inventory <player> shows what a player is carrying.
 */

const NUMERALS = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

function describe(item) {
  let text = item.nameTag ? `“${item.nameTag}” (${prettyName(item.typeId)})` : prettyName(item.typeId);
  if (item.amount > 1) text += ` ×${item.amount}`;
  const extras = [];
  try {
    const enchantments = item.getComponent("minecraft:enchantable")?.getEnchantments() ?? [];
    if (enchantments.length) extras.push(enchantments.map((e) => `${prettyName(e.type.id)} ${NUMERALS[e.level] ?? e.level}`).join(", "));
  } catch { /* not enchantable */ }
  try {
    const durability = item.getComponent("minecraft:durability");
    if (durability?.maxDurability) extras.push(`${Math.round(100 * (1 - durability.damage / durability.maxDurability))}% durability`);
  } catch { /* no durability */ }
  return extras.length ? `${text} — ${extras.join(" · ")}` : text;
}

/** Discord allows 1024 characters per field; cut politely rather than fail. */
function fit(lines) {
  if (!lines.length) return "_empty_";
  const out = [];
  let length = 0;
  for (let i = 0; i < lines.length; i++) {
    const more = `…and ${lines.length - i} more`;
    if (length + lines[i].length + 1 > 1000 - more.length) { out.push(more); break; }
    out.push(lines[i]);
    length += lines[i].length + 1;
  }
  return out.join("\n");
}

export default {
  id: "inventory",
  name: "Inventory",
  version: "1.0.0",
  description: "See what a player is carrying: armour, hotbar and everything in their inventory.",
  privacy: "This shows everything a player is carrying, so keep it to people you trust.",
  commands: [
    {
      name: "inventory",
      description: "Show what a player is carrying",
      options: [{ name: "player", type: "player", description: "The player's name", required: true }],
      run({ player: name }) {
        const player = findPlayer(name);
        if (!player) return `**${name}** isn't online right now.`;

        const container = player.getComponent("minecraft:inventory")?.container;
        const hotbar = [], backpack = [];
        let used = 0;
        for (let slot = 0; slot < (container?.size ?? 0); slot++) {
          const item = container.getItem(slot);
          if (!item) continue;
          used++;
          if (slot < 9) hotbar.push(`\`${slot + 1}\` ${describe(item)}`);
          else backpack.push(describe(item));
        }
        const held = container?.getItem(player.selectedSlotIndex);
        const equippable = player.getComponent("minecraft:equippable");
        const worn = (slot) => { try { return equippable?.getEquipment(slot); } catch { return undefined; } };
        const armour = [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet].map(worn).filter(Boolean);
        const offhand = worn(EquipmentSlot.Offhand);

        return {
          embed: {
            color: 0x5865f2,
            title: `${player.name}'s inventory`,
            fields: [
              { name: "Holding", value: held ? describe(held) : "_nothing_", inline: true },
              { name: "Off hand", value: offhand ? describe(offhand) : "_nothing_", inline: true },
              { name: "Armour", value: fit(armour.map(describe)) },
              { name: "Hotbar", value: fit(hotbar) },
              { name: "Inventory", value: fit(backpack) },
            ],
            footer: { text: `${used} of ${container?.size ?? 36} slots used` },
          },
        };
      },
    },
  ],
};
