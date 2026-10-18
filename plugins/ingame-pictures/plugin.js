import { system, world } from "@minecraft/server";
import { findPlayer } from "../relay/api.js";

/*
 * Paintings, by PPTribalize: a picture of what your player is looking at.
 *
 * Every pixel is a ray from the player's eyes. The plugin only says what each
 * ray hit (which block, which face, where on the face, how brightly lit) and
 * BedrockRelay draws it with the game's own textures: the `image.blocks`
 * picture in the developer guide. Mobs and players are simple coloured boxes
 * (MOB_MODELS, at the end of the file).
 *
 * The rays are spread over game ticks and each tick stops after TICK_BUDGET_MS,
 * so a picture never holds up the server. To fit in the time, every fourth
 * pixel across and down is cast first; a pixel between four that saw open sky,
 * or the same kind of block on one flat surface, is worked out without a ray of
 * its own (fillPixel). A picture takes five or six seconds.
 */

const WIDTH = 256, HEIGHT = 144, RANGE = 96;
const TICK_BUDGET_MS = 15;
const DEADLINE_MS = 9000;
/** BedrockRelay draws at most this many see-through things (glass, plants, rails) over the picture. */
const MAX_OVER = 16384;
/** Block faces as the picture numbers them. */
const FACES = ["Up", "Down", "North", "South", "East", "West"];
let busy = false;
let lastAt = 0;

/** Blocks you can see through, drawn over whatever is behind them: by part of their name, or by name. */
const SEE_THROUGH = /glass|_pane$|iron_bars|rail$|vine|chain$|_sapling$|propagule|torch$|_tulip$|_mushroom$/;
const SEE_THROUGH_NAMES = new Set([
  "ladder", "web", "cobweb", "short_grass", "tall_grass", "tallgrass", "fern", "large_fern", "deadbush", "dead_bush",
  "short_dry_grass", "tall_dry_grass", "bush", "firefly_bush", "seagrass", "kelp", "reeds", "sugar_cane", "sweet_berry_bush",
  "wheat", "carrots", "potatoes", "beetroot", "nether_wart", "pink_petals", "wildflowers", "leaf_litter",
  "poppy", "dandelion", "blue_orchid", "allium", "azure_bluet", "oxeye_daisy", "cornflower", "lily_of_the_valley",
  "wither_rose", "torchflower", "sunflower", "lilac", "rose_bush", "peony", "open_eyeblossom", "closed_eyeblossom",
  "cactus_flower", "crimson_roots", "warped_roots", "nether_sprouts", "hanging_roots", "glow_lichen", "sculk_vein",
]);
/** Blocks whose glow depends on their state (lit, charged, alive), and those that always glow. */
const GLOWS_IF_LIT = /copper_bulb|redstone_lamp|candle|campfire|^(lit_)?(furnace|blast_furnace|smoker)$|^respawn_anchor$|^sea_pickle$/;
const GLOWS = new RegExp([
  "torch$", "lantern", "glowstone", "shroomlight", "froglight", "^(flowing_)?lava$", "^fire$", "soul_fire", "magma", "end_rod", "beacon",
  "conduit", "^portal$", "end_portal", "end_gateway", "crying_obsidian", "glow_lichen", "amethyst_cluster", "_amethyst_bud",
  "^lit_.*redstone_ore$", "firefly_bush",
].join("|"));
/** Blocks that can lie on their side: logs, stems, pillars and the like have a pillar_axis. */
const PILLARS = /_log$|_wood$|_stem$|_hyphae$|pillar|basalt|bone_block|hay_block|bamboo_block|^chain$|_chain$|^deepslate$|muddy_mangrove_roots|froglight/;

/**
 * What a kind of block is, worked out once per kind: reading a block's states is slow enough to
 * matter thousands of times a picture, so it's only done for the kinds where it changes anything.
 */
const kinds = new Map();
function kindOf(typeId) {
  let kind = kinds.get(typeId);
  if (!kind) {
    const id = typeId.replace(/^minecraft:/, "").replace(/^waxed_/, "");
    kind = {
      seeThrough: SEE_THROUGH.test(id) || SEE_THROUGH_NAMES.has(id),
      // See-through, but not something you walk through: rays stop at it whatever they're told.
      solid: /glass|_pane$|iron_bars|chain$/.test(id),
      glow: id === "unlit_redstone_torch" ? false : GLOWS_IF_LIT.test(id) ? "states" : GLOWS.test(id),
      pillar: PILLARS.test(id),
      id,
    };
    kinds.set(typeId, kind);
  }
  return kind;
}
const seeThrough = (block) => kindOf(block.typeId).seeThrough;

function statesOf(block) {
  try { return block.permutation.getAllStates(); } catch { return {}; }
}

/** Blocks that give off light: drawn at full brightness, however they face. */
function glows(block) {
  const kind = kindOf(block.typeId);
  if (kind.glow !== "states") return kind.glow;
  const id = kind.id, states = statesOf(block);
  const lit = states.lit === true || states.lit === 1;
  if (/campfire/.test(id)) return !states.extinguished;
  if (id === "respawn_anchor") return states.respawn_anchor_charge > 0;
  if (id === "sea_pickle") return !states.dead_bit;
  return lit || id.startsWith("lit_");
}

/** Which of its six faces the ray sees, turned for a log or pillar lying on its side (its end faces sideways). */
function faceIndex(block, face) {
  const index = FACES.indexOf(face);
  const axis = kindOf(block.typeId).pillar ? statesOf(block).pillar_axis : undefined;
  if (axis === "x") return index >= 4 ? 0 : 2;
  if (axis === "z") return index === 2 || index === 3 ? 0 : 4;
  return index < 0 ? 2 : index;
}

/**
 * A rail, seen from above. The game's textures give a rail's top face its other look (curved, or
 * powered) and its other faces the plain one, so the face picks the look; and a straight rail's
 * texture runs north–south, so one running east–west is turned.
 */
function railLook(hit, light) {
  const states = statesOf(hit.block);
  const direction = Number(states.rail_direction ?? 0);
  const other = hit.block.typeId === "minecraft:rail" ? direction >= 6 : states.rail_data_bit === true || states.rail_data_bit === 1;
  const pos = hit.faceLocation ?? { x: 0.5, y: 0.5, z: 0.5 };
  const t = (n) => Math.max(0, Math.min(15, Math.floor(n * 16)));
  const eastWest = direction === 1 || direction === 2 || direction === 3;
  return [eastWest ? t(pos.z) * 16 + t(pos.x) : t(pos.x) * 16 + t(pos.z), (other ? 0 : 1) * 32 + light];
}

/** Where on the face the ray landed, as the picture wants it: u across (0–15) times 16, plus v down (0–15). */
function texelOf(face, pos) {
  pos = pos ?? { x: 0.5, y: 0.5, z: 0.5 };
  const t = (n) => Math.max(0, Math.min(15, Math.floor(n * 16)));
  switch (face) {
    case "Up": return t(pos.x) * 16 + t(pos.z);
    case "Down": return t(pos.x) * 16 + t(1 - pos.z);
    case "North": return t(1 - pos.x) * 16 + t(1 - pos.y);
    case "South": return t(pos.x) * 16 + t(1 - pos.y);
    case "East": return t(1 - pos.z) * 16 + t(1 - pos.y);
    default: return t(pos.z) * 16 + t(1 - pos.y);
  }
}

/** How a face is lit: the sun from above, the sides a little darker, as in game. */
const FACE_SHADE = { Up: 1, Down: 0.5, North: 0.82, South: 0.82, East: 0.68, West: 0.68 };

function boxRay(origin, direction, low, high, maximum = RANGE) {
  let near = 0, far = maximum, axisHit = 1;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < 1e-9) {
      if (origin[axis] < low[axis] || origin[axis] > high[axis]) return null;
      continue;
    }
    const t1 = (low[axis] - origin[axis]) / direction[axis], t2 = (high[axis] - origin[axis]) / direction[axis];
    const entry = Math.min(t1, t2), exit = Math.max(t1, t2);
    if (entry > near) { near = entry; axisHit = axis; }
    far = Math.min(far, exit);
    if (far < near) return null;
  }
  return { distance: Math.max(0.001, near), shade: axisHit === 1 ? 1 : axisHit === 0 ? 0.75 : 0.86 };
}

function equipmentColour(id) {
  if (/netherite/.test(id)) return [63, 56, 61];
  if (/diamond/.test(id)) return [73, 203, 197];
  if (/gold/.test(id)) return [233, 190, 55];
  if (/chainmail/.test(id)) return [135, 140, 148];
  if (/iron/.test(id)) return [210, 215, 218];
  if (/turtle/.test(id)) return [51, 119, 51];
  return [143, 94, 60];
}

/** Entities left out of pictures: dropped items, orbs and things in flight, which would only be clutter. */
const NOT_DRAWN = new RegExp(`^minecraft:(${[
  "item", "xp_orb", "arrow", "thrown_trident", "snowball", "egg", "ender_pearl", "fishing_hook",
  "splash_potion", "lingering_potion", "area_effect_cloud", "lightning_bolt", "leash_knot", "wind_charge_projectile",
].join("|")})$`);

function safeComponent(entity, id) { try { return entity.getComponent?.(id); } catch { return undefined; } }

/** An armor stand's gear: its equippable component is empty, so ask with testfor, a few times at most per picture. */
function standEquipment(entity, slot, budget) {
  if (entity.typeId !== "minecraft:armor_stand") return;
  const suffix = { Head: ["helmet"], Chest: ["chestplate"], Legs: ["leggings"], Feet: ["boots"], Mainhand: ["sword"] }[slot] ?? [];
  for (const material of ["iron", "diamond", "netherite", "golden"]) for (const part of suffix) {
    if (budget.count++ >= 32) return;
    const id = "minecraft:" + material + "_" + part;
    const location = slot === "Mainhand" ? "slot.weapon.mainhand" : "slot.armor." + slot.toLowerCase();
    try { if (entity.runCommand(`testfor @s[hasitem={item=${id},location=${location}}]`).successCount) return { typeId: id }; } catch {}
  }
}

/** The nearest 64 mobs and players in view, as boxes, sorted into 8×8-pixel tiles so each ray only tries those near it. */
function captureEntities(dimension, origin, settings, forward, right, up, fov) {
  let list = [];
  try { list = dimension.getEntities?.({ location: origin, maxDistance: RANGE }) ?? []; } catch { return { grid: [], count: 0, omitted: 0 }; }
  list = list.filter((entity) => {
    try { return entity.id !== settings.playerId && !NOT_DRAWN.test(entity.typeId) && !entity.hasTag?.("bedrockrelay:bot"); } catch { return false; }
  }).sort((a, b) => Math.hypot(a.location.x - origin.x, a.location.y - origin.y, a.location.z - origin.z)
    - Math.hypot(b.location.x - origin.x, b.location.y - origin.y, b.location.z - origin.z));
  const budget = { count: 0 };
  const omitted = Math.max(0, list.length - 64); list = list.slice(0, 64);
  const grid = Array.from({ length: Math.ceil(WIDTH / 8) * Math.ceil(HEIGHT / 8) }, () => []);
  const half = Math.tan(fov * Math.PI / 360), aspect = HEIGHT / WIDTH;
  let count = 0;
  for (const entity of list) try {
    const location = { ...entity.location };
    const angle = (entity.getRotation?.().y ?? 0) * Math.PI / 180, c = Math.cos(angle), sn = Math.sin(angle);
    const component = safeComponent(entity, "minecraft:scale");
    const scale = component?.value ?? (safeComponent(entity, "minecraft:is_baby") ? 0.5 : 1);
    const parts = (ENTITY_MODELS[entity.typeId] ?? [[-.3, 0, -.3, .3, 1, .3, 135, 116, 97]]).map((part) => [...part]);
    const equipped = safeComponent(entity, "minecraft:equippable");
    const gear = new Map();
    const add = (slot, bounds) => {
      let item = gear.get(slot);
      if (!gear.has(slot)) {
        try { item = equipped?.getEquipment(slot); } catch {}
        item ??= standEquipment(entity, slot, budget);
        gear.set(slot, item);
      }
      if (item) parts.push([...bounds, ...equipmentColour(item.typeId)]);
    };
    if (/armor_stand|player|zombie|skeleton|piglin|drowned|husk|stray|bogged/.test(entity.typeId)) {
      add("Head", [-.27, 1.48, -.27, .27, 1.99, .27]);
      add("Chest", [-.29, .87, -.16, .29, 1.51, .16]);
      add("Legs", [-.25, .28, -.14, -.025, .9, .14]);
      add("Legs", [.025, .28, -.14, .25, .9, .14]);
      add("Feet", [-.26, 0, -.17, -.025, .3, .19]);
      add("Feet", [.025, 0, -.17, .26, .3, .19]);
      add("Mainhand", [-.48, .4, -.37, -.40, 1.4, -.29]);
    }
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (const part of parts) for (let axis = 0; axis < 3; axis++) {
      part[axis] *= scale; part[axis + 3] *= scale;
      low[axis] = Math.min(low[axis], part[axis]); high[axis] = Math.max(high[axis], part[axis + 3]);
    }
    let minX = WIDTH, minY = HEIGHT, maxX = 0, maxY = 0, behind = false;
    for (const x of [low[0], high[0]]) for (const y of [low[1], high[1]]) for (const z of [low[2], high[2]]) {
      const delta = { x: location.x + c * x - sn * z - origin.x, y: location.y + y - origin.y, z: location.z + sn * x + c * z - origin.z };
      const depth = delta.x * forward.x + delta.y * forward.y + delta.z * forward.z;
      if (depth <= 0.05) { behind = true; continue; }
      const px = (1 + (delta.x * right.x + delta.y * right.y + delta.z * right.z) / (depth * half)) * WIDTH / 2;
      const py = (1 - (delta.x * up.x + delta.y * up.y + delta.z * up.z) / (depth * half * aspect)) * HEIGHT / 2;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    if (behind && maxX === 0) continue;
    if (behind) { minX = 0; maxX = WIDTH - 1; minY = 0; maxY = HEIGHT - 1; }
    if (maxX < 0 || minX >= WIDTH || maxY < 0 || minY >= HEIGHT) continue;
    const boxes = parts.map((part) => ({ low: part.slice(0, 3), high: part.slice(3, 6), rgb: part.slice(6, 9) }));
    const snapshot = { location, c, sn, boxes, low, high }; count++;
    for (let gy = Math.max(0, Math.floor(minY / 8)); gy <= Math.min(Math.ceil(HEIGHT / 8) - 1, Math.floor(maxY / 8)); gy++)
      for (let gx = Math.max(0, Math.floor(minX / 8)); gx <= Math.min(Math.ceil(WIDTH / 8) - 1, Math.floor(maxX / 8)); gx++) grid[gy * Math.ceil(WIDTH / 8) + gx].push(snapshot);
  } catch {}
  return { grid, count, omitted };
}

function entityRay(candidates, origin, direction, maximum) {
  let best = null;
  for (const entity of candidates ?? []) {
    const dx = origin.x - entity.location.x, dz = origin.z - entity.location.z;
    const o = [entity.c * dx + entity.sn * dz, origin.y - entity.location.y, -entity.sn * dx + entity.c * dz];
    const d = [entity.c * direction.x + entity.sn * direction.z, direction.y, -entity.sn * direction.x + entity.c * direction.z];
    if (!boxRay(o, d, entity.low, entity.high, best?.distance ?? maximum)) continue;
    for (const part of entity.boxes) {
      const hit = boxRay(o, d, part.low, part.high, best?.distance ?? maximum);
      if (hit && hit.distance < maximum && (!best || hit.distance < best.distance)) best = { ...hit, rgb: part.rgb };
    }
  }
  return best;
}

function blockDistance(hit, origin, direction) {
  if (!hit?.block) return RANGE;
  const position = hit.block.location;
  if (!position) return RANGE;
  const face = hit.faceLocation ?? { x: .5, y: .5, z: .5 };
  return Math.max(0, (position.x + face.x - origin.x) * direction.x + (position.y + face.y - origin.y) * direction.y + (position.z + face.z - origin.z) * direction.z);
}

/** A ray that falls back to shorter ones where the full range reaches unloaded chunks. */
function loadedRay(dimension, origin, direction, options, maximum = RANGE) {
  let limited = false;
  for (const distance of [maximum, 48, 24, 12].filter((d) => d <= maximum)) {
    try {
      return { hit: dimension.getBlockFromRay(origin, direction, { ...options, maxDistance: distance }), limited };
    } catch {
      limited = true;
    }
  }
  return { hit: undefined, limited: true };
}

function daylightAt(time) {
  time = ((time % 24000) + 24000) % 24000;
  if (time < 12000) return 1;
  if (time < 14000) return 1 - (time - 12000) / 2000;
  if (time < 22000) return 0;
  return (time - 22000) / 2000;
}

function base64(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += alphabet[a >> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]
      + (b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)])
      + (c === undefined ? "=" : alphabet[c & 63]);
  }
  return out;
}

const hex = (rgb) => "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v / 8) * 8)).toString(16).padStart(2, "0").slice(-2)).join("");

/** The picture's palette: block ids and colours, 256 at most; anything past that is drawn grey. */
function makePalette() {
  const entries = ["#888888"], index = new Map([["#888888", 0]]);
  return {
    entries,
    of(key) {
      let i = index.get(key);
      if (i === undefined) {
        if (entries.length >= 256) return 0;
        i = entries.length; entries.push(key); index.set(key, i);
      }
      return i;
    },
  };
}

function render(dimension, origin, forward, settings = {}) {
  const fov = settings.fov ?? 85;
  const overworld = dimension.id === "minecraft:overworld";
  const daylight = overworld ? daylightAt(settings.time ?? 6000) : 1;
  const ambient = 0.58 + 0.42 * daylight;
  const lightOf = (shade) => Math.max(0, Math.min(31, Math.round(31 * shade * ambient)));
  const length = Math.hypot(forward.x, forward.y, forward.z);
  forward = { x: forward.x / length, y: forward.y / length, z: forward.z / length };
  const horizontal = Math.hypot(forward.x, forward.z);
  const right = horizontal > 0.0001 ? { x: -forward.z / horizontal, y: 0, z: forward.x / horizontal } : { x: 1, y: 0, z: 0 };
  const up = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  };
  const entities = captureEntities(dimension, origin, settings, forward, right, up, fov);
  const palette = makePalette();
  const cells = new Uint8Array(WIDTH * HEIGHT * 3);
  const over = [];
  const half = Math.tan(fov * Math.PI / 360);
  let unavailable = 0;

  /** One block a ray hit, as the picture's three bytes. */
  const blockCell = (hit) => {
    const light = glows(hit.block) ? 31 : lightOf(FACE_SHADE[hit.face] ?? 0.8);
    if (/rail$/.test(hit.block.typeId)) return [palette.of(hit.block.typeId), ...railLook(hit, light)];
    return [palette.of(hit.block.typeId), texelOf(hit.face, hit.faceLocation), faceIndex(hit.block, hit.face) * 32 + light];
  };

  /**
   * What each corner pixel saw (below), so the pixels between corners can often skip their ray:
   * "sky", or a flat surface (the block kind, its face and the plane it lies in) where nothing
   * see-through or alive was in the way, else null.
   */
  const seen = new Array(WIDTH * HEIGHT).fill(null);
  const PLANES = { Up: ["y", 1], Down: ["y", 0], North: ["z", 0], South: ["z", 1], East: ["x", 1], West: ["x", 0] };

  function directionOf(i) {
    const px = i % WIDTH, py = Math.floor(i / WIDTH);
    const x = (2 * (px + 0.5) / WIDTH - 1) * half;
    const y = (1 - 2 * (py + 0.5) / HEIGHT) * half * HEIGHT / WIDTH;
    const direction = { x: forward.x + right.x * x + up.x * y, y: forward.y + right.y * x + up.y * y, z: forward.z + right.z * x + up.z * y };
    const norm = Math.hypot(direction.x, direction.y, direction.z);
    direction.x /= norm; direction.y /= norm; direction.z /= norm;
    return direction;
  }

  function skyCell(direction) {
    const skyRgb = overworld
      ? [110 + (1 - Math.max(0, direction.y)) * 40, 165 + (1 - Math.max(0, direction.y)) * 35, 235].map((v, axis) => v * daylight + [13, 17, 29][axis] * (1 - daylight))
      : [40, 30, 40];
    return [palette.of(hex(skyRgb.map((v) => Math.round(v / 16) * 16))), 0, 31];
  }

  /** Draws one pixel with its own ray. */
  function drawPixel(i) {
    const px = i % WIDTH, py = Math.floor(i / WIDTH);
    const direction = directionOf(i);
    let cell = null;
    const layers = [];
    try {
      const options = { includeLiquidBlocks: true, includePassableBlocks: true };
      let ray = loadedRay(dimension, origin, direction, options), limited = ray.limited;
      // Up to two see-through things in front (a window, then a plant), each drawn over what's behind it.
      // Behind something you walk through (a plant, a rail), the next ray leaves such blocks out, from the
      // same place. Behind glass, it leaves out that kind of block: slower, and windows are rarer.
      const excluded = [];
      while (ray.hit?.block && seeThrough(ray.hit.block) && layers.length < 2 && over.length / 5 < MAX_OVER - 2) {
        layers.push({ cell: blockCell(ray.hit), distance: blockDistance(ray.hit, origin, direction) });
        if (kindOf(ray.hit.block.typeId).solid) excluded.push(ray.hit.block.typeId);
        const past = blockDistance(ray.hit, origin, direction);
        const from = { x: origin.x + direction.x * past, y: origin.y + direction.y * past, z: origin.z + direction.z * past };
        const next = excluded.length
          ? { includeLiquidBlocks: true, includePassableBlocks: !kindOf(ray.hit.block.typeId).solid, excludeTypes: excluded }
          : { includeLiquidBlocks: true, includePassableBlocks: false };
        ray = loadedRay(dimension, from, direction, next, Math.max(1, RANGE - past));
        limited ||= ray.limited;
      }
      if (limited) unavailable++;
      if (ray.hit?.block) cell = blockCell(ray.hit);
      const tile = Math.floor(py / 8) * Math.ceil(WIDTH / 8) + Math.floor(px / 8);
      const entityHit = entityRay(entities.grid[tile], origin, direction, blockDistance(ray.hit, origin, direction));
      if (entityHit) cell = [palette.of(hex(entityHit.rgb)), 0, lightOf(entityHit.shade)];
      else if (!layers.length && !limited) {
        if (!ray.hit) seen[i] = "sky";
        else {
          const [axis, side] = PLANES[ray.hit.face] ?? [];
          if (axis) seen[i] = { key: ray.hit.block.typeId + ray.hit.face + (ray.hit.block.location[axis] + side), axis, plane: ray.hit.block.location[axis] + side, face: ray.hit.face, cell };
        }
      }
      // Farthest first, so the nearest is drawn last, on top; nothing behind a mob shows in front of it.
      for (const layer of layers.reverse()) {
        if (entityHit && entityHit.distance < layer.distance) continue;
        over.push(i & 255, i >> 8, ...layer.cell);
      }
    } catch {
      unavailable++;
    }
    cells.set(cell ?? skyCell(direction), i * 3);
  }

  /**
   * A pixel between four corners that all saw the same thing, drawn without a ray: open sky, or
   * the same kind of block on one flat surface (a field, a wall), where its texel is where its own
   * ray meets that surface. False when it needs a ray after all.
   */
  function fillPixel(i) {
    const px = i % WIDTH, py = Math.floor(i / WIDTH);
    const x0 = px - (px % STEP), y0 = py - (py % STEP), x1 = Math.min(x0 + STEP, WIDTH - 1), y1 = Math.min(y0 + STEP, HEIGHT - 1);
    const around = [seen[y0 * WIDTH + x0], seen[y0 * WIDTH + x1], seen[y1 * WIDTH + x0], seen[y1 * WIDTH + x1]];
    if (around.some((item) => item === null)) return false;
    const direction = directionOf(i);
    if (around.every((item) => item === "sky")) { cells.set(skyCell(direction), i * 3); return true; }
    const surface = around[0];
    if (surface === "sky" || around.some((item) => item === "sky" || item.key !== surface.key)) return false;
    if (entities.grid[Math.floor(py / 8) * Math.ceil(WIDTH / 8) + Math.floor(px / 8)]?.length) return false;
    const t = (surface.plane - origin[surface.axis]) / direction[surface.axis];
    if (!(t > 0 && t < RANGE)) return false;
    const point = { x: origin.x + direction.x * t, y: origin.y + direction.y * t, z: origin.z + direction.z * t };
    const inBlock = { x: point.x - Math.floor(point.x), y: point.y - Math.floor(point.y), z: point.z - Math.floor(point.z) };
    cells.set([surface.cell[0], texelOf(surface.face, inBlock), surface.cell[2]], i * 3);
    return true;
  }

  // Every fourth pixel across and down first (and the last row and column), each with its own ray;
  // then the rest, most of which fillPixel draws without one.
  const STEP = 4;
  const corner = (p, size) => p % STEP === 0 || p === size - 1;
  const order = [];
  for (let n = 0; n < WIDTH * HEIGHT; n++) if (corner(n % WIDTH, WIDTH) && corner(Math.floor(n / WIDTH), HEIGHT)) order.push(n);
  const corners = order.length;
  for (let n = 0; n < WIDTH * HEIGHT; n++) if (!(corner(n % WIDTH, WIDTH) && corner(Math.floor(n / WIDTH), HEIGHT))) order.push(n);

  let i = 0;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const job = system.runInterval(() => {
      try {
        if (Date.now() - started > DEADLINE_MS) throw new Error("Render deadline exceeded");
        const until = Date.now() + TICK_BUDGET_MS;
        for (let n = 0; i < order.length && (n < 64 || Date.now() < until); n++, i++) {
          const pixel = order[i];
          if (i < corners || !fillPixel(pixel)) drawPixel(pixel);
        }
        if (i === order.length) {
          system.clearRun(job);
          resolve({
            blocks: { width: WIDTH, height: HEIGHT, palette: palette.entries, data: base64(cells), ...(over.length ? { over: base64(over) } : {}) },
            unavailable, entities: entities.count, omittedEntities: entities.omitted, took: Date.now() - started,
          });
        }
      } catch (error) {
        system.clearRun(job);
        reject(error);
      }
    }, 1);
  });
}

export default {
  id: "ingame-pictures",
  name: "Paintings",
  version: "2.0.0",
  description: "Draws a picture of what your player is looking at, with the game's own textures, and shows it in Discord.",
  privacy: "Pictures reveal nearby builds, players and entities. Pictures are posted publicly in the command Discord channel.",
  platforms: ["server"],
  minPackVersion: "0.4.0",
  commands: [{
    name: "paintings",
    description: "Draw a picture of what your linked player is looking at",
    public: true,
    options: [{
      name: "view", type: "string", required: false,
      description: "Framing: normal by default, close for more detail, wide for more surroundings",
      choices: [{ name: "Normal", value: "normal" }, { name: "Close", value: "close" }, { name: "Wide", value: "wide" }, { name: "Inspect block", value: "inspect" }],
    }],
    async run(args, { linkedPlayer }) {
      if (!linkedPlayer) return "Link your Minecraft player first with `/relay link`.";
      const player = findPlayer(linkedPlayer);
      if (!player || player.hasTag("bedrockrelay:bot")) return "Your Minecraft player must be online to take a picture.";
      if (args.view === "inspect") {
        const hit = player.dimension.getBlockFromRay(player.getHeadLocation(), player.getViewDirection(), { maxDistance: 16, includePassableBlocks: true, includeLiquidBlocks: true });
        return hit ? hit.block.typeId + " " + JSON.stringify(hit.block.permutation.getAllStates()) : "No block within 16 blocks.";
      }
      if (busy) return "A picture is being drawn. Try again shortly.";
      if (Date.now() - lastAt < 15000) return "Please wait 15 seconds between pictures.";
      busy = true;
      try {
        const name = player.name;
        const fov = { normal: 85, close: 65, wide: 100 }[args.view ?? "normal"] ?? 85;
        const picture = await render(player.dimension, player.getHeadLocation(), player.getViewDirection(), { fov, time: world.getTimeOfDay(), playerId: player.id });
        const notes = [`${fov}° view`, `${RANGE}-block range`, `${picture.entities} mobs and players`];
        if (picture.omittedEntities) notes.push("nearest 64 only");
        if (picture.unavailable) notes.push("distant or unloaded areas left out");
        return { embed: { title: `Painting by ${name}`, image: { blocks: picture.blocks }, footer: { text: notes.join(" · ") } } };
      } catch {
        return "The picture could not be drawn. Try again while your player is in a loaded area.";
      } finally {
        busy = false;
        lastAt = Date.now();
      }
    },
  }],
};

/*
 * Mobs and players as boxes: [x1, y1, z1, x2, y2, z2] in thousandths of a
 * block around the mob's feet, facing south, then the box's colour [r, g, b].
 * Anything not listed is a plain brown box.
 */
const MOB_MODELS = {
  "minecraft:allay": [
    [-156, 313, -156, 156, 626, 156, 111, 237, 251],
    [-94, 62, -62, 94, 312, 62, 30, 117, 153],
    [-81, 13, -50, 81, 300, 50, 36, 107, 169],
    [-156, 62, -62, -94, 312, 62, 65, 208, 255],
    [94, 62, -62, 156, 312, 62, 65, 208, 255],
    [31, -62, 62, 41, 250, 562, 0, 0, 0],
    [-31, -62, 62, -21, 250, 562, 0, 0, 0],
  ],
  "minecraft:armadillo": [
    [-269, 106, -394, 269, 644, 394, 122, 76, 74],
    [-250, 125, -375, 250, 625, 375, 114, 62, 62],
    [-31, 19, 138, 31, 377, 375, 212, 140, 123],
    [-94, 58, -519, 94, 394, -284, 191, 124, 118],
    [-209, 252, -544, -94, 568, -442, 66, 39, 37],
    [94, 252, -544, 209, 568, -442, 83, 51, 45],
    [-188, 0, 188, -62, 188, 312, 213, 150, 136],
    [62, 0, 188, 188, 188, 312, 213, 150, 136],
    [-188, 0, -312, -62, 188, -188, 213, 150, 136],
    [62, 0, -312, 188, 188, -188, 213, 150, 136],
    [-312, 0, -375, 312, 625, 250, 149, 92, 90],
  ],
  "minecraft:armor_stand": [
    [-375, 0, -375, 375, 62, 375, 171, 171, 171],
    [-375, 1312, -94, 375, 1500, 94, 170, 138, 84],
    [-188, 875, -62, -62, 1312, 62, 173, 140, 86],
    [62, 875, -62, 188, 1312, 62, 171, 139, 83],
    [-250, 750, -62, 250, 875, 62, 170, 137, 84],
    [-62, 1500, -62, 62, 1938, 62, 158, 128, 76],
    [-250, 1500, -250, 250, 2000, 250, 0, 0, 0],
    [312, 750, -62, 438, 1500, 62, 169, 136, 83],
    [56, 62, -62, 181, 750, 62, 166, 133, 81],
    [-438, 750, -62, -312, 1500, 62, 165, 134, 80],
    [-181, 62, -62, -56, 750, 62, 159, 129, 77],
  ],
  "minecraft:arrow": [
    [-66, -92, -188, 155, 129, 812, 16, 15, 15],
    [-155, -92, -188, 66, 129, 812, 16, 15, 15],
    [-177, -203, 750, 265, 239, 760, 16, 15, 15],
  ],
  "minecraft:axolotl": [
    [-250, 0, -312, 250, 250, 312, 108, 120, 233],
    [0, 0, -312, 10, 312, 250, 0, 0, 0],
    [-250, -250, -375, -240, 62, -188, 45, 42, 93],
    [-250, -250, 125, -240, 62, 312, 45, 42, 93],
    [250, -250, -375, 260, 62, -188, 45, 42, 93],
    [250, -250, 125, 260, 62, 312, 45, 42, 93],
    [0, 0, 250, 10, 312, 1000, 0, 0, 0],
    [-250, 0, -625, 250, 312, -312, 165, 161, 246],
    [250, 0, -375, 438, 438, -365, 65, 36, 21],
    [-438, 0, -375, -250, 438, -365, 66, 38, 19],
    [-250, 312, -375, 250, 500, -365, 58, 33, 17],
  ],
  "minecraft:bat": [
    [-125, 438, -62, 125, 625, 62, 54, 43, 43],
    [-250, 500, 0, -62, 812, 10, 37, 29, 32],
    [62, 500, 0, 250, 812, 10, 49, 38, 45],
    [-94, 125, -62, 94, 438, 62, 43, 36, 32],
    [-94, 0, 0, 94, 125, 10, 13, 11, 10],
    [-219, 125, 0, -94, 562, 10, 26, 22, 20],
    [-594, 62, 0, -219, 562, 10, 32, 27, 24],
    [94, 125, 0, 219, 562, 10, 23, 19, 17],
    [219, 62, 0, 594, 562, 10, 35, 29, 26],
  ],
  "minecraft:bee": [
    [-188, 125, -312, 250, 562, 312, 181, 148, 74],
    [125, 438, -500, 188, 562, -312, 0, 0, 0],
    [-125, 438, -500, -62, 562, -312, 0, 0, 0],
    [31, 312, 312, 41, 375, 438, 0, 0, 0],
    [-700, 465, -333, -62, 562, 162, 0, 0, 0],
    [125, 465, -333, 762, 562, 162, 0, 0, 0],
    [-188, 0, -125, 250, 125, -115, 17, 9, 7],
    [-188, 0, 0, 250, 125, 10, 17, 9, 7],
    [-188, 0, 125, 250, 125, 135, 14, 7, 5],
  ],
  "minecraft:blaze": [
    [0, 1000, 0, 125, 1500, 125, 212, 141, 14],
    [0, 1000, 0, 125, 1500, 125, 212, 141, 14],
    [0, 1000, 0, 125, 1500, 125, 212, 141, 14],
    [0, 1000, 0, 125, 1500, 125, 212, 141, 14],
    [0, 1000, 0, 125, 1500, 125, 212, 141, 14],
    [0, 1000, 0, 125, 1500, 125, 212, 141, 14],
    [0, 1000, 0, 125, 1500, 125, 212, 141, 14],
    [0, 1000, 0, 125, 1500, 125, 212, 141, 14],
    [0, 1000, 0, 125, 1500, 125, 212, 141, 14],
    [0, 1000, 0, 125, 1500, 125, 212, 141, 14],
    [0, 1000, 0, 125, 1500, 125, 212, 141, 14],
    [0, 1000, 0, 125, 1500, 125, 212, 141, 14],
    [-250, 1250, -250, 250, 1750, 250, 191, 144, 44],
  ],
  "minecraft:bogged": [
    [-250, 750, -125, 250, 1500, 125, 88, 92, 69],
    [-250, 1500, -250, 250, 2000, 250, 146, 132, 80],
    [-320, 1938, -320, -55, 2188, -55, 36, 27, 21],
    [-320, 1938, -320, -55, 2188, -55, 36, 27, 21],
    [55, 1938, 55, 320, 2188, 320, 101, 31, 27],
    [55, 1938, 55, 320, 2188, 320, 101, 31, 27],
    [-258, 1430, -125, 8, 1695, 188, 54, 40, 32],
    [-258, 1430, -125, 8, 1695, 188, 54, 40, 32],
    [-263, 1488, -263, 263, 2013, 263, 0, 0, 0],
    [-375, 750, -62, -250, 1500, 62, 90, 96, 60],
    [250, 750, -62, 375, 1500, 62, 90, 96, 60],
    [-188, 0, -62, -62, 750, 62, 127, 128, 104],
    [62, 0, -62, 188, 750, 62, 127, 128, 104],
  ],
  "minecraft:breeze": [
    [-62, 749, -552, 62, 1259, -245, 131, 134, 184],
    [-509, 749, 68, -181, 1259, 330, 131, 134, 184],
    [181, 749, 68, 509, 1259, 330, 131, 134, 184],
    [-250, 1250, -250, 250, 1750, 250, 124, 130, 171],
    [-312, 1375, -263, 312, 1562, -13, 94, 95, 99],
  ],
  "minecraft:breeze_wind_charge_projectile": [
    [-188, 16, -188, 188, 266, 188, 97, 100, 117],
    [-250, 78, -250, 250, 203, 250, 92, 96, 112],
    [-125, 16, -125, 125, 266, 125, 178, 184, 193],
  ],
  "minecraft:camel": [
    [-469, 1250, -875, 469, 2000, 812, 221, 163, 70],
    [-287, 1994, -381, 287, 2319, 319, 186, 89, 41],
    [-225, 2306, -381, 225, 2506, 319, 0, 0, 0],
    [-475, 1244, -881, 475, 2006, 819, 28, 13, 5],
    [-94, 938, 812, 94, 1812, 823, 54, 43, 24],
    [-219, 1375, -1562, 219, 1875, -375, 214, 156, 61],
    [-219, 1875, -1562, 219, 2750, -1125, 218, 161, 69],
    [-156, 2438, -1938, 156, 2750, -1562, 153, 120, 66],
    [-225, 1369, -1569, 225, 1881, -369, 0, 0, 0],
    [-225, 1869, -1569, 225, 2756, -1119, 3, 1, 1],
    [-163, 2431, -1950, 163, 2756, -1562, 0, 0, 0],
    [156, 2500, -1750, 219, 2625, -1625, 152, 132, 118],
    [-219, 2500, -1750, -156, 2625, -1625, 152, 132, 118],
    [188, 2656, -1281, 375, 2719, -1156, 241, 182, 87],
    [-375, 2656, -1281, -188, 2719, -1156, 241, 182, 87],
    [231, 2125, -1688, 241, 2562, -750, 0, 0, 0],
    [-231, 2125, -750, 231, 2562, -740, 27, 13, 5],
    [-231, 2125, -1688, -221, 2562, -750, 0, 0, 0],
    [-281, 2000, -375, 281, 2312, 312, 237, 178, 84],
    [-463, 0, -812, -150, 1312, -500, 217, 162, 72],
    [150, 0, -812, 463, 1312, -500, 217, 162, 72],
    [150, 0, 438, 463, 1312, 750, 217, 162, 72],
    [-463, 0, 438, -150, 1312, 750, 217, 162, 72],
  ],
  "minecraft:camel_husk": [
    [-469, 1250, -875, 469, 2000, 812, 60, 52, 41],
    [-287, 1994, -381, 287, 2319, 319, 145, 76, 35],
    [-225, 2306, -381, 225, 2506, 319, 0, 0, 0],
    [-475, 1244, -881, 475, 2006, 819, 23, 12, 5],
    [-94, 938, 812, 94, 1812, 823, 24, 21, 17],
    [-219, 1375, -1562, 219, 1875, -375, 55, 48, 38],
    [-219, 1875, -1562, 219, 2750, -1125, 63, 54, 42],
    [-156, 2438, -1938, 156, 2750, -1562, 54, 47, 37],
    [-225, 1369, -1569, 225, 1881, -369, 0, 0, 0],
    [-225, 1869, -1569, 225, 2756, -1119, 2, 1, 0],
    [-163, 2431, -1950, 163, 2756, -1562, 0, 0, 0],
    [156, 2500, -1750, 219, 2625, -1625, 106, 106, 106],
    [-219, 2500, -1750, -156, 2625, -1625, 106, 106, 106],
    [188, 2656, -1281, 375, 2719, -1156, 65, 55, 42],
    [-375, 2656, -1281, -188, 2719, -1156, 84, 73, 55],
    [231, 2125, -1688, 241, 2562, -750, 0, 0, 0],
    [-231, 2125, -750, 231, 2562, -740, 22, 11, 5],
    [-231, 2125, -1688, -221, 2562, -750, 0, 0, 0],
    [-281, 2000, -375, 281, 2312, 312, 74, 64, 49],
    [-463, 0, -812, -150, 1312, -500, 61, 53, 41],
    [150, 0, -812, 463, 1312, -500, 61, 53, 41],
    [150, 0, 438, 463, 1312, 750, 55, 47, 38],
    [-463, 0, 438, -150, 1312, 750, 55, 47, 38],
  ],
  "minecraft:cat": [
    [-125, -62, -125, 125, 938, 250, 207, 208, 208],
    [-156, 438, -750, 156, 688, -438, 220, 218, 220],
    [-94, 438, -812, 94, 563, -688, 239, 226, 235],
    [-125, 688, -562, -62, 750, -438, 234, 237, 240],
    [62, 688, -562, 125, 750, -438, 234, 237, 240],
    [-31, 62, 500, 31, 562, 562, 231, 231, 233],
    [-31, 62, 1000, 31, 562, 1062, 253, 249, 251],
    [6, 0, 375, 131, 375, 500, 232, 232, 234],
    [-131, 0, 375, -6, 375, 500, 232, 232, 234],
    [12, 12, -312, 138, 637, -188, 236, 235, 236],
    [-138, 12, -312, -13, 637, -188, 236, 235, 236],
  ],
  "minecraft:cave_spider": [
    [-250, 312, -688, 250, 812, -188, 71, 45, 39],
    [-188, 375, -188, 188, 750, 188, 4, 22, 19],
    [-312, 312, 188, 312, 812, 938, 9, 32, 28],
    [-1188, 500, 62, -188, 625, 188, 9, 30, 26],
    [188, 500, 62, 1188, 625, 188, 9, 30, 26],
    [-1188, 500, 0, -188, 625, 125, 9, 30, 26],
    [188, 500, 0, 1188, 625, 125, 9, 30, 26],
    [-1188, 500, -62, -188, 625, 62, 9, 30, 26],
    [188, 500, -62, 1188, 625, 62, 9, 30, 26],
    [-1188, 500, -125, -188, 625, 0, 9, 30, 26],
    [188, 500, -125, 1188, 625, 0, 9, 30, 26],
  ],
  "minecraft:chest_minecart": [
    [-625, 1188, -500, 625, 1312, 500, 86, 92, 94],
    [-625, 1312, -500, -500, 1812, 500, 95, 102, 104],
    [500, 1312, -500, 625, 1812, 500, 95, 102, 104],
    [-500, 1312, -500, 500, 1812, -375, 95, 102, 104],
    [-500, 1312, 375, 500, 1812, 500, 95, 102, 104],
  ],
  "minecraft:chicken": [
    [-188, 250, -188, 188, 750, 188, 209, 209, 209],
    [-125, 562, -375, 125, 938, -188, 213, 171, 171],
    [-62, 562, -438, 62, 688, -312, 255, 0, 0],
    [-125, 688, -500, 125, 812, -375, 172, 130, 60],
    [-188, 0, -125, 0, 312, 62, 0, 0, 0],
    [0, 0, -125, 188, 312, 62, 0, 0, 0],
    [-250, 438, -188, -188, 688, 188, 237, 237, 237],
    [188, 438, -188, 250, 688, 188, 237, 237, 237],
  ],
  "minecraft:cod": [
    [-62, 0, 62, 62, 250, 500, 174, 146, 118],
    [0, 250, 0, 10, 312, 375, 194, 168, 133],
    [0, -62, 188, 10, 0, 312, 194, 168, 133],
    [-62, 63, -188, 63, 250, -125, 185, 159, 132],
    [-62, 0, -125, 62, 250, 62, 187, 162, 132],
    [62, 11, 0, 201, 134, 125, 188, 159, 120],
    [-201, 11, 0, -62, 134, 125, 182, 150, 107],
    [0, 0, 500, 10, 250, 875, 194, 173, 150],
  ],
  "minecraft:command_block_minecart": [
    [-625, 1188, -500, 625, 1312, 500, 86, 92, 94],
    [-625, 1312, -500, -500, 1812, 500, 95, 102, 104],
    [500, 1312, -500, 625, 1812, 500, 95, 102, 104],
    [-500, 1312, -500, 500, 1812, -375, 95, 102, 104],
    [-500, 1312, 375, 500, 1812, 500, 95, 102, 104],
  ],
  "minecraft:copper_golem": [
    [-250, 312, -188, 250, 688, 188, 175, 96, 71],
    [-250, 688, -312, 250, 1000, 312, 152, 80, 56],
    [-62, 625, -375, 62, 812, -250, 196, 112, 82],
    [-62, 1001, -62, 62, 1249, 62, 179, 100, 73],
    [-124, 1251, -124, 124, 1499, 124, 212, 121, 94],
    [-438, 125, -125, -250, 750, 125, 195, 109, 84],
    [250, 125, -125, 438, 750, 125, 196, 109, 85],
    [-244, 0, -124, 6, 312, 126, 169, 90, 65],
    [-6, 0, -125, 244, 312, 125, 168, 89, 65],
  ],
  "minecraft:cow": [
    [-375, 688, -312, 375, 1812, 312, 98, 79, 71],
    [-125, 688, -375, 125, 1062, -312, 219, 155, 155],
    [-250, 1000, -875, 250, 1500, -500, 114, 107, 101],
    [-312, 1375, -750, -250, 1562, -688, 77, 77, 77],
    [250, 1375, -750, 312, 1562, -688, 77, 77, 77],
    [-375, 0, 312, -125, 750, 562, 71, 59, 49],
    [125, 0, 312, 375, 750, 562, 71, 59, 49],
    [-375, 0, -438, -125, 750, -188, 71, 59, 49],
    [125, 0, -438, 375, 750, -188, 71, 59, 49],
  ],
  "minecraft:creaking": [
    [-438, 1875, -188, -62, 2500, 188, 117, 92, 75],
    [-438, 2500, -188, -62, 2688, 188, 27, 24, 23],
    [-62, 1812, 0, 500, 2688, 10, 11, 11, 10],
    [-1000, 1875, 0, -438, 2750, 10, 13, 14, 13],
    [-62, 1000, -125, 312, 1812, 188, 92, 83, 80],
    [-438, 1438, -125, -62, 1875, 188, 90, 80, 77],
    [-625, 562, 0, -438, 1875, 188, 97, 92, 87],
    [-625, 312, 0, -438, 562, 188, 28, 28, 27],
    [312, 812, -62, 500, 1812, 125, 99, 94, 89],
    [312, 1812, -62, 500, 2062, 125, 54, 47, 46],
    [312, 562, -62, 500, 812, 125, 37, 38, 35],
    [0, 0, -62, 188, 1000, 125, 95, 91, 86],
    [0, 19, -250, 312, 29, 312, 19, 17, 16],
    [-250, 0, -62, -62, 1188, 125, 92, 89, 85],
    [-375, 19, -250, -62, 29, 312, 41, 37, 36],
    [-250, 1188, -62, -62, 1375, 125, 31, 27, 26],
  ],
  "minecraft:creeper": [
    [-250, 375, -125, 250, 1125, 125, 93, 169, 84],
    [-250, 1125, -250, 250, 1625, 250, 87, 147, 79],
    [-250, 0, 125, 0, 375, 375, 67, 135, 62],
    [0, 0, 125, 250, 375, 375, 67, 135, 62],
    [-250, 0, -375, 0, 375, -125, 67, 135, 62],
    [0, 0, -375, 250, 375, -125, 67, 135, 62],
  ],
  "minecraft:cushion": [
    [-499, -7, -499, 499, 242, 499, 33, 32, 46],
  ],
  "minecraft:dolphin": [
    [-250, 0, -188, 250, 438, 625, 164, 185, 206],
    [-250, 0, -562, 250, 438, -188, 158, 174, 196],
    [-62, 0, -812, 62, 125, -562, 162, 182, 203],
    [-125, 0, 625, 125, 312, 1312, 163, 180, 199],
    [-312, 125, 1188, 312, 188, 1562, 144, 160, 184],
    [-31, 366, -62, 31, 761, 311, 176, 193, 205],
    [104, 40, -147, 651, 290, 290, 172, 190, 204],
    [-651, 40, -147, -104, 290, 290, 172, 190, 204],
  ],
  "minecraft:donkey": [
    [-312, 688, -688, 312, 1312, 688, 115, 99, 85],
    [-94, 404, 204, 94, 1303, 801, 24, 24, 24],
    [62, 0, 438, 312, 688, 688, 106, 94, 82],
    [-312, 0, 438, -62, 688, 688, 106, 94, 82],
    [62, 0, -688, 312, 688, -438, 106, 94, 82],
    [-312, 0, -688, -62, 688, -438, 106, 94, 82],
    [-125, 883, -694, 125, 1752, 60, 99, 85, 72],
    [-188, 1533, -319, 188, 2022, 217, 94, 81, 68],
    [-125, 1752, -589, 125, 2179, -162, 173, 169, 158],
    [-129, 1744, 127, 12, 1947, 280, 83, 71, 60],
    [-12, 1744, 127, 129, 1947, 280, 83, 71, 60],
    [-537, 1680, 90, -303, 2105, 372, 166, 157, 144],
    [303, 1680, 90, 537, 2105, 372, 166, 157, 144],
    [194, 1874, -353, 204, 2148, 660, 54, 36, 22],
    [-194, 1874, -353, -184, 2148, 660, 54, 36, 22],
    [-141, 1730, -448, 141, 2106, -141, 34, 24, 17],
    [-203, 1512, -340, 203, 2044, 238, 22, 13, 7],
    [125, 1837, -450, 188, 2008, -279, 81, 81, 81],
    [-188, 1837, -450, -125, 2008, -279, 81, 81, 81],
    [-62, 873, -281, 62, 1802, 327, 0, 0, 0],
    [312, 812, 125, 500, 1312, 625, 103, 79, 42],
    [-500, 812, 125, -312, 1312, 625, 103, 79, 42],
    [-344, 719, -250, 344, 1344, 375, 1, 1, 0],
  ],
  "minecraft:dragon_fireball": [
    [-500, -250, 0, 500, 750, 10, 84, 46, 94],
  ],
  "minecraft:drowned": [
    [-250, 750, -125, 250, 1500, 125, 72, 128, 123],
    [-281, 719, -156, 281, 1531, 156, 64, 46, 32],
    [-281, 1469, -281, 281, 2031, 281, 58, 125, 126],
    [-312, 1438, -312, 312, 2062, 312, 63, 109, 87],
    [-438, 750, -125, -188, 1500, 125, 39, 81, 75],
    [250, 750, -125, 500, 1500, 125, 39, 83, 77],
    [-469, 719, -156, -156, 1531, 156, 89, 110, 94],
    [219, 719, -156, 531, 1531, 156, 82, 114, 101],
    [-253, 0, -125, -3, 750, 125, 39, 84, 79],
    [3, 0, -125, 253, 750, 125, 39, 81, 75],
    [-281, -16, -141, 0, 766, 141, 86, 95, 80],
    [0, -16, -141, 281, 766, 141, 90, 94, 80],
  ],
  "minecraft:egg": [
    [-250, -125, 0, 250, 375, 10, 87, 81, 62],
  ],
  "minecraft:elder_guardian": [
    [-375, 125, -500, 375, 875, 500, 108, 141, 128],
    [-500, 125, -375, -375, 875, 375, 90, 117, 103],
    [375, 125, -375, 500, 875, 375, 90, 117, 103],
    [-375, 875, -375, 375, 1000, 375, 89, 112, 98],
    [-375, 0, -375, 375, 125, 375, 89, 112, 98],
    [-62, 438, 0, 62, 562, 62, 121, 11, 18],
    [-125, 375, 438, 125, 625, 938, 78, 120, 103],
    [0, 438, 0, 188, 625, 438, 74, 118, 99],
    [0, 500, 0, 125, 625, 375, 88, 126, 112],
    [62, 281, 188, 125, 844, 750, 255, 255, 255],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
  ],
  "minecraft:enderman": [
    [-219, 2375, -219, 219, 2812, 219, 3, 3, 3],
    [-250, 1500, -250, 250, 2000, 250, 28, 15, 31],
    [-250, 1625, -125, 250, 2375, 125, 15, 15, 15],
    [-250, 500, -62, -125, 2375, 62, 14, 14, 14],
    [250, 500, -62, 375, 2375, 62, 14, 14, 14],
    [-188, -250, -62, -62, 1625, 62, 14, 14, 14],
    [62, -250, -62, 188, 1625, 62, 14, 14, 14],
  ],
  "minecraft:endermite": [
    [-125, 0, -275, 125, 188, -150, 61, 36, 68],
    [-188, 0, -150, 188, 250, 163, 60, 42, 77],
    [-94, 0, 156, 94, 188, 219, 61, 43, 79],
    [-31, 0, 219, 31, 125, 281, 70, 50, 92],
  ],
  "minecraft:ender_crystal": [
    [-500, -500, -500, 500, 500, 500, 66, 77, 86],
    [-500, -500, -500, 500, 500, 500, 66, 77, 86],
    [-500, -500, -500, 500, 500, 500, 222, 109, 238],
    [-750, 500, -750, 750, 1000, 750, 92, 95, 97],
  ],
  "minecraft:ender_dragon": [
    [-375, 1250, -1500, 375, 1562, -500, 24, 24, 24],
    [-500, 1000, -625, 500, 2000, 375, 53, 33, 57],
    [-312, 2000, -250, -188, 2250, 125, 96, 96, 96],
    [-312, 1562, -1375, -188, 1688, -1125, 23, 23, 23],
    [188, 2000, -250, 312, 2250, 125, 96, 96, 96],
    [188, 1562, -1375, 312, 1688, -1125, 23, 23, 23],
    [-375, 1000, -1500, 375, 1250, -500, 24, 24, 24],
    [-312, 1188, -312, 312, 1812, 312, 25, 25, 25],
    [-62, 1812, -188, 62, 2062, 188, 96, 96, 96],
    [-750, -250, -500, 750, 1250, 3500, 26, 26, 26],
    [-62, 1250, -125, 62, 1625, 625, 96, 96, 96],
    [-62, 1250, 1125, 62, 1625, 1875, 96, 96, 96],
    [-62, 1250, 2375, 62, 1625, 3125, 96, 96, 96],
    [-4250, 938, -125, -750, 1438, 375, 122, 122, 122],
    [-4250, 1188, 250, -750, 1198, 3750, 2, 2, 2],
    [-7000, 1375, -125, -3500, 1625, 125, 117, 117, 117],
    [-7000, 1500, 125, -3500, 1510, 3625, 0, 0, 0],
    [-2750, 938, -125, 750, 1438, 375, 122, 122, 122],
    [-2750, 1188, 250, 750, 1198, 3750, 2, 2, 2],
    [-7000, 1375, -125, -3500, 1625, 125, 117, 117, 117],
    [-7000, 1500, 125, -3500, 1510, 3625, 0, 0, 0],
    [-1500, -1250, 2125, -500, 750, 3125, 26, 26, 26],
    [500, -1250, 2125, 1500, 750, 3125, 26, 26, 26],
    [-1000, -1000, -125, -500, 500, 375, 25, 25, 25],
    [500, -1000, -125, 1000, 500, 375, 25, 25, 25],
    [-375, -2375, -250, 375, -375, 500, 26, 26, 26],
    [-375, -2375, -250, 375, -375, 500, 26, 26, 26],
    [-188, -1188, -250, 188, 312, 125, 25, 25, 25],
    [-188, -1188, -250, 188, 312, 125, 25, 25, 25],
    [-562, -812, -1000, 562, -438, 500, 26, 26, 26],
    [-562, -812, -1000, 562, -438, 500, 26, 26, 26],
    [-250, -188, -750, 250, 62, 250, 26, 26, 26],
    [-250, -188, -750, 250, 62, 250, 26, 26, 26],
  ],
  "minecraft:eye_of_ender_signal": [
    [-250, -125, 0, 250, 375, 10, 51, 79, 56],
  ],
  "minecraft:ender_pearl": [
    [-250, -125, 0, 250, 375, 10, 18, 61, 54],
  ],
  "minecraft:evocation_fang": [
    [-94, -1, -251, 157, 876, 251, 186, 179, 172],
    [-94, 0, -250, 156, 875, 250, 186, 179, 172],
    [-312, 0, -312, 312, 750, 312, 89, 83, 78],
  ],
  "minecraft:evocation_illager": [
    [-250, 1500, -250, 250, 2125, 250, 125, 131, 130],
    [-62, 1438, -375, 62, 1688, -250, 104, 110, 110],
    [-250, 750, -188, 250, 1500, 188, 68, 78, 80],
    [-281, 344, -219, 281, 1531, 219, 73, 68, 47],
    [0, 0, -125, 250, 750, 125, 68, 76, 77],
    [-250, 0, -125, 0, 750, 125, 68, 76, 77],
    [-500, 1000, -125, -250, 1500, 125, 30, 28, 26],
    [250, 1000, -125, 500, 1500, 125, 30, 28, 26],
    [-250, 1000, -125, 250, 1250, 125, 57, 55, 48],
    [-500, 750, -125, -250, 1500, 125, 59, 59, 54],
    [250, 750, -125, 500, 1500, 125, 59, 59, 54],
  ],
  "minecraft:xp_bottle": [
    [-250, -125, 0, 250, 375, 10, 65, 69, 28],
  ],
  "minecraft:xp_orb": [
    [0, 0, 0, 1000, 1000, 10, 103, 99, 99],
  ],
  "minecraft:fireball": [
    [-500, -250, 0, 500, 750, 10, 40, 29, 18],
  ],
  "minecraft:fireworks_rocket": [
    [0, -500, -500, 10, 500, 500, 7, 4, 4],
    [-500, 0, -500, 500, 10, 500, 7, 4, 4],
  ],
  "minecraft:fishing_hook": [
    [-94, -94, -94, 94, 94, 94, 171, 147, 147],
    [0, -281, -31, 10, -94, 156, 171, 147, 147],
    [0, 94, -94, 10, 281, 94, 171, 147, 147],
    [-94, 94, 0, 94, 281, 10, 171, 147, 147],
  ],
  "minecraft:fox": [
    [-188, 0, -188, 188, 688, 188, 194, 158, 140],
    [-250, 250, -562, 250, 625, -188, 210, 133, 72],
    [-250, 625, -500, -125, 750, -438, 232, 219, 216],
    [125, 625, -500, 250, 750, -438, 232, 219, 216],
    [-125, 250, -750, 125, 375, -562, 184, 177, 178],
    [-250, 250, -562, 250, 625, -188, 204, 127, 65],
    [-250, 625, -500, -125, 750, -438, 232, 219, 216],
    [125, 625, -500, 250, 750, -438, 232, 219, 216],
    [-125, 250, -750, 125, 375, -562, 184, 177, 178],
    [-188, 0, 312, -63, 375, 438, 159, 78, 30],
    [63, 0, 312, 188, 375, 438, 159, 78, 30],
    [-188, 0, -125, -63, 375, 0, 159, 78, 30],
    [63, 0, -125, 188, 375, 0, 159, 78, 30],
    [-125, -125, 297, 125, 438, 609, 186, 112, 74],
  ],
  "minecraft:frog": [
    [-219, 62, -250, 219, 250, 312, 187, 142, 91],
    [-219, 188, -250, 219, 198, 312, 0, 0, 0],
    [-219, 312, -250, 219, 323, 312, 93, 46, 21],
    [-219, 188, -250, 219, 375, 312, 161, 94, 59],
    [-219, 375, -188, -31, 500, 0, 152, 106, 72],
    [31, 375, -188, 219, 500, 0, 152, 106, 72],
    [-212, 75, -237, 212, 188, -62, 217, 165, 106],
    [-125, 194, -131, 125, 204, 306, 0, 0, 0],
    [188, 0, -219, 312, 188, -31, 209, 120, 73],
    [0, -1, -469, 500, 9, 31, 0, 0, 0],
    [-312, 0, -219, -188, 188, -31, 209, 120, 73],
    [-500, -1, -469, 0, 9, 31, 0, 0, 0],
    [156, 0, 125, 344, 188, 375, 192, 111, 69],
    [94, -1, 0, 594, 9, 500, 0, 0, 0],
    [-344, 0, 125, -156, 188, 375, 192, 111, 69],
    [-594, -1, 0, -94, 9, 500, 0, 0, 0],
  ],
  "minecraft:ghast": [
    [-2250, -250, -2250, 2250, 4250, 2250, 191, 190, 190],
    [-1350, -2250, -1688, -788, 281, -1125, 191, 190, 190],
    [84, -2812, -1688, 647, 281, -1125, 191, 190, 190],
    [1491, -1969, -1688, 2053, 281, -1125, 191, 190, 190],
    [-2053, -2250, -281, -1491, 281, 281, 191, 190, 190],
    [-647, -3375, -281, -84, 281, 281, 191, 190, 190],
    [787, -2812, -281, 1350, 281, 281, 191, 190, 190],
    [-1350, -3094, 1125, -788, 281, 1688, 191, 190, 190],
    [84, -3094, 1125, 647, 281, 1688, 191, 190, 190],
    [1491, -3375, 1125, 2053, 281, 1688, 191, 190, 190],
  ],
  "minecraft:glow_squid": [
    [-375, -500, -375, 375, 500, 375, 46, 146, 143],
    [250, -1562, -62, 375, -438, 62, 45, 136, 129],
    [130, -1562, 130, 307, -438, 307, 45, 136, 129],
    [-62, -1562, 250, 62, -438, 375, 45, 136, 129],
    [-307, -1562, 130, -130, -438, 307, 45, 136, 129],
    [-375, -1562, -62, -250, -438, 62, 45, 136, 129],
    [-307, -1562, -307, -130, -438, -130, 45, 136, 129],
    [-63, -1562, -375, 63, -438, -250, 45, 136, 129],
    [130, -1562, -307, 307, -438, -130, 45, 136, 129],
  ],
  "minecraft:goat": [
    [62, 0, 250, 250, 375, 438, 204, 199, 187],
    [-188, 0, 250, 0, 375, 438, 204, 199, 187],
    [-188, 0, -375, 0, 625, -188, 215, 210, 200],
    [62, 0, -375, 250, 625, -188, 215, 210, 200],
    [-250, 375, -438, 312, 1062, 562, 208, 198, 181],
    [-312, 250, -500, 375, 1125, 188, 221, 219, 214],
    [-125, 915, -940, 188, 1678, -224, 225, 221, 210],
    [188, 1188, -625, 375, 1312, -562, 224, 218, 204],
    [-312, 1188, -625, -125, 1312, -562, 224, 218, 204],
    [31, 375, -875, 41, 812, -562, 101, 90, 76],
    [-124, 1188, -625, 1, 1625, -500, 103, 103, 103],
    [62, 1188, -625, 187, 1625, -500, 103, 103, 103],
  ],
  "minecraft:guardian": [
    [-375, 125, -500, 375, 875, 500, 108, 141, 128],
    [-500, 125, -375, -375, 875, 375, 90, 117, 103],
    [375, 125, -375, 500, 875, 375, 90, 117, 103],
    [-375, 875, -375, 375, 1000, 375, 89, 112, 98],
    [-375, 0, -375, 375, 125, 375, 89, 112, 98],
    [-62, 438, 0, 62, 562, 62, 121, 11, 18],
    [-125, 375, 438, 125, 625, 938, 78, 120, 103],
    [0, 438, 0, 188, 625, 438, 74, 118, 99],
    [0, 500, 0, 125, 625, 375, 88, 126, 112],
    [62, 281, 188, 125, 844, 750, 255, 255, 255],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
    [-62, 1219, -62, 62, 1781, 62, 217, 101, 42],
  ],
  "minecraft:happy_ghast": [
    [-2000, 0, -2000, 2000, 4000, 2000, 181, 142, 137],
    [-1875, 125, -1875, 1875, 3875, 1875, 181, 142, 137],
    [-1200, -1000, -1500, -700, 250, -1000, 181, 142, 137],
    [75, -1500, -1500, 575, 250, -1000, 181, 142, 137],
    [1325, -750, -1500, 1825, 250, -1000, 181, 142, 137],
    [-1825, -1000, -250, -1325, 250, 250, 181, 142, 137],
    [-575, -1000, -250, -75, 250, 250, 181, 142, 137],
    [700, -1500, -250, 1200, 250, 250, 181, 142, 137],
    [-1200, -1750, 1000, -700, 250, 1500, 181, 142, 137],
    [75, -1750, 1000, 575, 250, 1500, 181, 142, 137],
    [1325, -1000, 1000, 1825, 250, 1500, 181, 142, 137],
  ],
  "minecraft:hoglin": [
    [-501, 686, -439, 501, 1564, 1189, 179, 112, 89],
    [-1, 1374, -626, 9, 2001, 564, 75, 82, 85],
    [-438, 1335, -1124, 438, 2486, -73, 199, 131, 102],
    [-500, 1950, -875, -375, 2487, -268, 232, 217, 139],
    [375, 1950, -875, 500, 2487, -268, 232, 217, 139],
    [-726, 1598, -305, -438, 2000, 107, 180, 109, 87],
    [438, 1598, -305, 726, 2000, 107, 180, 109, 87],
    [-500, 0, 812, -188, 688, 1125, 188, 126, 99],
    [188, 0, 812, 500, 688, 1125, 184, 122, 96],
    [-500, 0, -375, -125, 875, 0, 176, 117, 92],
    [125, 0, -375, 500, 875, 0, 178, 118, 92],
  ],
  "minecraft:hopper_minecart": [
    [-625, 1188, -500, 625, 1312, 500, 86, 92, 94],
    [-625, 1312, -500, -500, 1812, 500, 95, 102, 104],
    [500, 1312, -500, 625, 1812, 500, 95, 102, 104],
    [-500, 1312, -500, 500, 1812, -375, 95, 102, 104],
    [-500, 1312, 375, 500, 1812, 500, 95, 102, 104],
  ],
  "minecraft:horse": [
    [-312, 688, -688, 312, 1312, 688, 68, 29, 8],
    [-94, 404, 204, 94, 1303, 801, 12, 1, 0],
    [62, 0, 438, 312, 688, 688, 61, 30, 14],
    [-312, 0, 438, -62, 688, 688, 61, 30, 14],
    [62, 0, -688, 312, 688, -438, 61, 30, 14],
    [-312, 0, -688, -62, 688, -438, 61, 30, 14],
    [-125, 883, -694, 125, 1752, 60, 55, 23, 5],
    [-188, 1533, -319, 188, 2022, 217, 49, 20, 5],
    [-125, 1752, -589, 125, 2179, -162, 23, 11, 4],
    [-129, 1744, 127, 12, 1947, 280, 36, 15, 3],
    [-12, 1744, 127, 129, 1947, 280, 36, 15, 3],
    [-537, 1680, 90, -303, 2105, 372, 0, 0, 0],
    [303, 1680, 90, 537, 2105, 372, 0, 0, 0],
    [194, 1874, -353, 204, 2148, 660, 26, 15, 6],
    [-194, 1874, -353, -184, 2148, 660, 26, 15, 6],
    [-141, 1730, -448, 141, 2106, -141, 0, 0, 0],
    [-203, 1512, -340, 203, 2044, 238, 22, 13, 7],
    [125, 1837, -450, 188, 2008, -279, 81, 81, 81],
    [-188, 1837, -450, -125, 2008, -279, 81, 81, 81],
    [-62, 873, -281, 62, 1802, 327, 35, 12, 1],
    [312, 812, 125, 500, 1312, 625, 104, 79, 42],
    [-500, 812, 125, -312, 1312, 625, 104, 79, 42],
    [-344, 719, -250, 344, 1344, 375, 0, 0, 0],
  ],
  "minecraft:husk": [
    [-250, 750, -125, 250, 1500, 125, 168, 146, 100],
    [-250, 1500, -250, 250, 2000, 250, 102, 90, 68],
    [-281, 1469, -281, 281, 2031, 281, 0, 0, 0],
    [-500, 750, -125, -250, 1500, 125, 125, 111, 84],
    [250, 750, -125, 500, 1500, 125, 125, 111, 84],
    [-244, 0, -125, 6, 750, 125, 72, 61, 41],
    [-6, 0, -125, 244, 750, 125, 72, 61, 41],
  ],
  "minecraft:iron_golem": [
    [-562, 1312, -375, 562, 2062, 312, 183, 172, 142],
    [-312, 969, -219, 312, 1344, 219, 170, 167, 133],
    [-250, 2062, -469, 250, 2688, 31, 179, 157, 147],
    [-62, 2000, -594, 62, 2250, -469, 147, 132, 124],
    [-812, 219, -188, -562, 2094, 188, 204, 197, 189],
    [562, 219, -188, 812, 2094, 188, 197, 193, 177],
    [-469, 0, -188, -94, 1000, 125, 172, 170, 128],
    [94, 0, -188, 469, 1000, 125, 194, 183, 170],
  ],
  "minecraft:leash_knot": [
    [-188, 125, -188, 188, 625, 188, 37, 30, 21],
  ],
  "minecraft:lingering_potion": [
    [-250, -125, 0, 250, 375, 10, 19, 18, 21],
  ],
  "minecraft:llama": [
    [-125, 1688, -1000, 125, 1938, -438, 205, 182, 145],
    [-250, 938, -750, 250, 2062, -375, 235, 213, 167],
    [-250, 2062, -625, -62, 2250, -500, 232, 210, 166],
    [62, 2062, -625, 250, 2250, -500, 232, 210, 166],
    [-531, 812, -125, -344, 1312, 375, 104, 79, 42],
    [344, 812, -125, 531, 1312, 375, 104, 76, 35],
    [-375, 688, -312, 375, 1812, 312, 227, 202, 149],
    [-344, 0, 250, -94, 875, 500, 238, 215, 167],
    [94, 0, 250, 344, 875, 500, 238, 215, 167],
    [-344, 0, -438, -94, 875, -188, 238, 215, 167],
    [94, 0, -438, 344, 875, -188, 238, 215, 167],
  ],
  "minecraft:llama_spit": [
    [-250, 1375, 0, -125, 1500, 125, 224, 255, 252],
    [0, 1625, 0, 125, 1750, 125, 224, 255, 252],
    [0, 1375, -250, 125, 1500, -125, 224, 255, 252],
    [0, 1375, 0, 125, 1500, 125, 224, 255, 252],
    [125, 1375, 0, 250, 1500, 125, 224, 255, 252],
    [0, 1250, 0, 125, 1375, 125, 224, 255, 252],
    [0, 1375, 125, 125, 1500, 250, 224, 255, 252],
  ],
  "minecraft:magma_cube": [
    [-250, 438, -250, 250, 500, 250, 30, 0, 0],
    [-250, 375, -250, 250, 438, 250, 37, 2, 0],
    [-250, 312, -250, 250, 375, 250, 110, 30, 4],
    [-250, 250, -250, 250, 312, 250, 134, 106, 47],
    [-250, 188, -250, 250, 250, 250, 39, 0, 0],
    [-250, 125, -250, 250, 188, 250, 42, 2, 0],
    [-250, 62, -250, 250, 125, 250, 37, 2, 0],
    [-250, 0, -250, 250, 62, 250, 35, 0, 0],
    [-125, 125, -125, 125, 375, 125, 224, 130, 41],
  ],
  "minecraft:minecart": [
    [-625, 1188, -500, 625, 1312, 500, 86, 92, 94],
    [-625, 1312, -500, -500, 1812, 500, 95, 102, 104],
    [500, 1312, -500, 625, 1812, 500, 95, 102, 104],
    [-500, 1312, -500, 500, 1812, -375, 95, 102, 104],
    [-500, 1312, 375, 500, 1812, 500, 95, 102, 104],
  ],
  "minecraft:mooshroom": [
    [-375, 688, -312, 375, 1812, 312, 162, 58, 59],
    [-125, 688, -375, 125, 1062, -312, 219, 155, 155],
    [-250, 1000, -875, 250, 1500, -500, 140, 70, 71],
    [-312, 1375, -750, -250, 1562, -688, 77, 77, 77],
    [250, 1375, -750, 312, 1562, -688, 77, 77, 77],
    [-375, 0, 312, -125, 750, 562, 150, 32, 33],
    [125, 0, 312, 375, 750, 562, 150, 32, 33],
    [-375, 0, -438, -125, 750, -188, 150, 32, 33],
    [125, 0, -438, 375, 750, -188, 150, 32, 33],
  ],
  "minecraft:mule": [
    [-312, 688, -688, 312, 1312, 688, 58, 32, 23],
    [-94, 404, 204, 94, 1303, 801, 24, 24, 24],
    [62, 0, 438, 312, 688, 688, 63, 40, 31],
    [-312, 0, 438, -62, 688, 688, 63, 40, 31],
    [62, 0, -688, 312, 688, -438, 63, 40, 31],
    [-312, 0, -688, -62, 688, -438, 63, 40, 31],
    [-125, 883, -694, 125, 1752, 60, 44, 22, 19],
    [-188, 1533, -319, 188, 2022, 217, 55, 30, 22],
    [-125, 1752, -589, 125, 2179, -162, 132, 118, 100],
    [-129, 1744, 127, 12, 1947, 280, 62, 36, 24],
    [-12, 1744, 127, 129, 1947, 280, 62, 36, 24],
    [-537, 1680, 90, -303, 2105, 372, 114, 89, 72],
    [303, 1680, 90, 537, 2105, 372, 114, 89, 72],
    [194, 1874, -353, 204, 2148, 660, 26, 15, 6],
    [-194, 1874, -353, -184, 2148, 660, 26, 15, 6],
    [-141, 1730, -448, 141, 2106, -141, 0, 0, 0],
    [-203, 1512, -340, 203, 2044, 238, 22, 13, 7],
    [125, 1837, -450, 188, 2008, -279, 81, 81, 81],
    [-188, 1837, -450, -125, 2008, -279, 81, 81, 81],
    [-62, 873, -281, 62, 1802, 327, 0, 0, 0],
    [312, 812, 125, 500, 1312, 625, 103, 79, 42],
    [-500, 812, 125, -312, 1312, 625, 103, 79, 42],
    [-344, 719, -250, 344, 1344, 375, 0, 0, 0],
  ],
  "minecraft:nautilus": [
    [-438, 500, -500, 438, 1125, 500, 229, 158, 138],
    [-438, 0, -500, 438, 500, 750, 199, 112, 92],
    [-438, 0, 312, 438, 500, 323, 111, 78, 53],
    [-312, 1, 206, 312, 501, 1081, 255, 255, 255],
    [-312, 1, 831, 312, 501, 841, 144, 62, 60],
    [-312, 251, 831, 312, 500, 1081, 0, 0, 0],
    [-188, 126, 831, 188, 376, 1081, 0, 0, 0],
    [-312, -1, 831, 312, 249, 1081, 0, 0, 0],
  ],
  "minecraft:npc": [
    [-250, 1500, -250, 250, 2125, 250, 138, 120, 104],
    [-281, 1469, -281, 281, 2031, 281, 255, 255, 255],
    [-62, 1438, -375, 62, 1688, -250, 223, 191, 149],
    [-250, 750, -188, 250, 1500, 188, 123, 107, 67],
    [-281, 344, -219, 281, 1531, 219, 211, 208, 208],
    [-250, 1000, -125, 250, 1250, 125, 189, 163, 131],
    [-500, 1000, -125, -250, 1500, 125, 202, 170, 125],
    [250, 1000, -125, 500, 1500, 125, 202, 170, 125],
    [-250, 0, -125, 0, 750, 125, 75, 107, 103],
    [0, 0, -125, 250, 750, 125, 75, 107, 103],
    [-22, -16, -141, 259, 766, 141, 255, 255, 255],
    [-259, -16, -141, 22, 766, 141, 111, 105, 104],
    [-266, 734, -141, 266, 1516, 141, 153, 161, 159],
  ],
  "minecraft:ocelot": [
    [-156, 438, -750, 156, 688, -438, 55, 58, 56],
    [-94, 438, -812, 94, 563, -688, 148, 134, 139],
    [-125, 688, -562, -62, 750, -438, 36, 36, 49],
    [62, 688, -562, 125, 750, -438, 36, 36, 49],
    [-125, -438, -1125, 125, 562, -750, 221, 221, 222],
    [-31, 193, 117, 31, 562, 540, 28, 24, 39],
    [-31, -250, 812, 31, 250, 875, 76, 73, 84],
    [6, 0, 375, 131, 375, 500, 113, 111, 120],
    [-131, 0, 375, -6, 375, 500, 113, 111, 120],
    [12, 12, -312, 138, 637, -188, 78, 75, 86],
    [-138, 12, -312, -13, 637, -188, 78, 75, 86],
  ],
  "minecraft:panda": [
    [-406, 469, -1312, 406, 1094, -750, 125, 125, 127],
    [-219, 469, -1438, 219, 781, -1312, 177, 177, 178],
    [-531, 1031, -1125, -219, 1281, -1062, 14, 14, 18],
    [219, 1031, -1125, 531, 1281, -1062, 14, 14, 18],
    [-594, 62, -406, 594, 1688, 406, 79, 79, 79],
    [-531, 0, 375, -156, 562, 750, 18, 18, 23],
    [156, 0, 375, 531, 562, 750, 18, 18, 23],
    [-531, 0, -750, -156, 562, -375, 18, 18, 23],
    [156, 0, -750, 531, 562, -375, 18, 18, 23],
  ],
  "minecraft:parched": [
    [-250, 750, -125, 250, 1500, 125, 83, 76, 63],
    [-250, 812, -125, 250, 875, 125, 0, 0, 0],
    [-252, 748, -127, 252, 1502, 127, 83, 73, 51],
    [-250, 1500, -250, 250, 2000, 250, 118, 112, 101],
    [-263, 1488, -263, 263, 2013, 263, 52, 46, 33],
    [-406, 750, -62, -281, 1500, 62, 96, 93, 80],
    [-441, 752, -94, -253, 1502, 94, 99, 87, 61],
    [281, 750, -62, 406, 1500, 62, 95, 92, 80],
    [253, 752, -94, 441, 1502, 94, 108, 95, 66],
    [-188, 0, -62, -62, 750, 62, 95, 92, 77],
    [-219, 0, -94, -31, 750, 94, 98, 86, 61],
    [62, 0, -62, 188, 750, 62, 95, 92, 77],
    [31, 0, -94, 219, 750, 94, 113, 99, 68],
  ],
  "minecraft:parrot": [
    [-62, 425, -237, 62, 613, -112, 93, 99, 148],
    [-62, 613, -362, 62, 675, -112, 12, 32, 220],
    [-31, 488, -294, 31, 613, -231, 26, 26, 26],
    [-31, 506, -356, 31, 613, -294, 15, 15, 15],
    [-94, 94, -281, 94, 469, -94, 13, 36, 207],
    [-94, -6, 13, 94, 244, 75, 10, 34, 166],
    [62, 131, -269, 125, 444, -81, 11, 33, 177],
    [-125, 131, -269, -62, 444, -81, 11, 33, 177],
    [0, 569, -306, 10, 881, -56, 0, 0, 0],
    [31, -31, -94, 94, 94, -31, 0, 0, 0],
    [-94, -31, -94, -31, 94, -31, 0, 0, 0],
  ],
  "minecraft:phantom": [
    [-188, 1438, -500, 125, 1625, 62, 96, 85, 101],
    [125, 1500, -500, 500, 1625, 62, 124, 112, 128],
    [500, 1562, -500, 1312, 1625, 62, 183, 172, 150],
    [-562, 1500, -500, -188, 1625, 62, 124, 112, 128],
    [-1375, 1562, -500, -562, 1625, 62, 183, 172, 150],
    [-250, 1375, -750, 188, 1562, -438, 78, 111, 142],
    [-125, 1500, 62, 62, 1625, 438, 61, 62, 76],
    [-62, 1531, 438, 0, 1594, 812, 121, 110, 96],
  ],
  "minecraft:pig": [
    [-312, 438, -312, 312, 1438, 188, 220, 105, 103],
    [-250, 500, -875, 250, 1000, -375, 227, 146, 142],
    [-125, 562, -938, 125, 750, -875, 222, 138, 134],
    [-312, 0, 312, -62, 375, 562, 228, 144, 139],
    [62, 0, 312, 312, 375, 562, 228, 144, 139],
    [-312, 0, -438, -62, 375, -188, 228, 144, 139],
    [62, 0, -438, 312, 375, -188, 228, 144, 139],
  ],
  "minecraft:piglin": [
    [-250, 750, -125, 250, 1500, 125, 134, 78, 47],
    [-266, 734, -141, 266, 1516, 141, 0, 0, 0],
    [-311, 1501, -249, 311, 1999, 249, 204, 132, 94],
    [-125, 1500, -312, 125, 1750, -250, 203, 140, 101],
    [125, 1500, -312, 188, 1625, -250, 230, 220, 150],
    [-188, 1500, -312, -125, 1625, -250, 230, 220, 150],
    [102, 1604, -125, 312, 1906, 125, 220, 148, 110],
    [-312, 1604, -125, -102, 1906, 125, 220, 148, 110],
    [-500, 750, -125, -250, 1500, 125, 184, 122, 90],
    [-516, 734, -141, -234, 1516, 141, 0, 0, 0],
    [250, 750, -125, 500, 1500, 125, 184, 122, 90],
    [234, 734, -141, 516, 1516, 141, 0, 0, 0],
    [-250, 0, -125, 0, 750, 125, 164, 105, 77],
    [-266, -16, -141, 16, 766, 141, 0, 0, 0],
    [0, 0, -125, 250, 750, 125, 164, 105, 77],
    [-16, -16, -141, 266, 766, 141, 0, 0, 0],
  ],
  "minecraft:piglin_brute": [
    [-250, 750, -125, 250, 1500, 125, 134, 78, 47],
    [-266, 734, -141, 266, 1516, 141, 63, 48, 24],
    [-311, 1501, -249, 311, 1999, 249, 203, 129, 93],
    [-125, 1500, -312, 125, 1750, -250, 203, 140, 101],
    [125, 1500, -312, 188, 1625, -250, 230, 220, 150],
    [-188, 1500, -312, -125, 1625, -250, 230, 220, 150],
    [102, 1604, -125, 312, 1906, 125, 220, 148, 110],
    [-312, 1604, -125, -102, 1906, 125, 220, 148, 110],
    [-500, 750, -125, -250, 1500, 125, 138, 99, 80],
    [-516, 734, -141, -234, 1516, 141, 0, 0, 0],
    [250, 750, -125, 500, 1500, 125, 131, 95, 48],
    [234, 734, -141, 516, 1516, 141, 0, 0, 0],
    [-250, 0, -125, 0, 750, 125, 162, 103, 75],
    [-266, -16, -141, 16, 766, 141, 22, 18, 14],
    [0, 0, -125, 250, 750, 125, 164, 105, 77],
    [-16, -16, -141, 266, 766, 141, 22, 19, 12],
  ],
  "minecraft:pillager": [
    [-250, 1500, -250, 250, 2125, 250, 125, 131, 130],
    [-62, 1438, -375, 62, 1688, -250, 104, 110, 110],
    [-250, 750, -188, 250, 1500, 188, 64, 44, 45],
    [-281, 344, -219, 281, 1531, 219, 23, 20, 19],
    [0, 0, -125, 250, 750, 125, 56, 45, 35],
    [-250, 0, -125, 0, 750, 125, 56, 45, 35],
    [-500, 750, -125, -250, 1500, 125, 72, 63, 62],
    [250, 750, -125, 500, 1500, 125, 72, 63, 62],
  ],
  "minecraft:player": [
    [-250, 750, -125, 250, 1500, 125, 18, 145, 158],
    [-250, 1500, -250, 250, 2000, 250, 124, 87, 69],
    [-281, 1469, -281, 281, 2031, 281, 0, 0, 0],
    [250, 750, -125, 500, 1500, 125, 110, 137, 122],
    [234, 734, -141, 516, 1516, 141, 0, 0, 0],
    [-500, 750, -125, -250, 1500, 125, 110, 137, 122],
    [-516, 734, -141, -234, 1516, 141, 0, 0, 0],
    [-6, 0, -125, 244, 750, 125, 76, 66, 154],
    [-22, -16, -141, 259, 766, 141, 0, 0, 0],
    [-244, 0, -125, 6, 750, 125, 76, 66, 154],
    [-259, -16, -141, 22, 766, 141, 0, 0, 0],
    [-266, 734, -141, 266, 1516, 141, 0, 0, 0],
  ],
  "minecraft:polar_bear": [
    [-219, 625, -1188, 219, 1062, -750, 197, 198, 193],
    [-156, 625, -1375, 156, 812, -1188, 106, 108, 100],
    [-281, 1000, -1062, -156, 1125, -1000, 176, 172, 164],
    [156, 1000, -1062, 281, 1125, -1000, 176, 172, 164],
    [-438, 875, 312, 438, 1750, 1000, 218, 217, 210],
    [-375, 1750, 312, 375, 2500, 938, 219, 218, 211],
    [-406, 0, 250, -156, 625, 750, 230, 230, 226],
    [156, 0, 250, 406, 625, 750, 230, 230, 226],
    [-344, 0, -625, -94, 625, -250, 230, 230, 226],
    [94, 0, -625, 344, 625, -250, 230, 230, 226],
  ],
  "minecraft:pufferfish": [
    [-94, 0, -94, 94, 125, 94, 216, 189, 144],
    [31, 125, -94, 94, 188, -31, 29, 44, 38],
    [-94, 125, -94, -31, 188, -31, 29, 44, 38],
    [-94, 62, 94, 94, 72, 281, 191, 132, 27],
    [94, 0, -93, 156, 62, 32, 255, 255, 255],
    [-156, 0, -93, -94, 62, 32, 255, 255, 255],
  ],
  "minecraft:rabbit": [
    [125, 0, 0, 250, 62, 438, 82, 72, 57],
    [-250, 0, 0, -125, 62, 438, 82, 72, 57],
    [125, 171, 231, 250, 513, 610, 139, 117, 90],
    [-250, 171, 231, -125, 513, 610, 146, 123, 96],
    [-188, -77, -130, 188, 430, 564, 133, 113, 84],
    [125, -4, -124, 250, 448, 75, 120, 102, 76],
    [-250, -4, -124, -125, 448, 75, 127, 108, 82],
    [-156, 500, -375, 156, 750, -62, 136, 115, 90],
    [-151, 750, -163, -14, 1062, -71, 155, 135, 111],
    [14, 750, -163, 151, 1062, -71, 154, 133, 108],
    [-94, 162, 405, 94, 381, 587, 147, 125, 97],
    [-31, 594, -406, 31, 656, -344, 241, 206, 231],
  ],
  "minecraft:ravager": [
    [-438, 188, -438, 438, 1438, 562, 73, 71, 69],
    [-375, 312, -1250, 375, 1438, -438, 69, 64, 64],
    [-500, 812, -1500, 500, 1000, -500, 43, 41, 38],
    [-312, 1312, -625, 312, 1938, 500, 80, 71, 66],
    [-500, 875, -1500, 500, 2125, -500, 81, 78, 73],
    [-125, 750, -1750, 125, 1250, -1500, 50, 50, 44],
    [-750, 0, 1062, -250, 2312, 1562, 100, 102, 98],
    [250, 0, 1062, 750, 2312, 1562, 100, 102, 98],
    [-750, 0, -500, -250, 2312, 0, 105, 111, 108],
    [250, 0, -500, 750, 2312, 0, 105, 111, 108],
    [-625, 1525, -1219, -500, 2179, -336, 96, 98, 91],
    [500, 1525, -1219, 625, 2179, -336, 96, 98, 91],
  ],
  "minecraft:salmon": [
    [-94, 219, -250, 94, 531, 250, 130, 110, 66],
    [-94, 219, 250, 94, 531, 750, 183, 88, 87],
    [0, 531, 125, 10, 656, 250, 178, 100, 75],
    [0, 531, 250, 10, 656, 438, 164, 122, 70],
    [0, 219, 750, 10, 531, 1125, 203, 140, 138],
    [-62, 281, -438, 62, 531, -250, 138, 157, 132],
    [-112, 137, -250, -9, 209, -125, 171, 53, 51],
    [9, 137, -250, 112, 209, -125, 171, 53, 51],
  ],
  "minecraft:shulker": [
    [-500, 250, -500, 500, 1000, 500, 116, 81, 116],
    [-500, 0, -500, 500, 500, 500, 105, 74, 105],
    [-188, 375, -188, 188, 750, 188, 208, 213, 156],
  ],
  "minecraft:shulker_bullet": [
    [-250, -250, -62, 250, 250, 62, 214, 188, 152],
    [-62, -250, -250, 62, 250, 250, 243, 221, 160],
    [-250, -62, -250, 250, 62, 250, 243, 221, 160],
  ],
  "minecraft:silverfish": [
    [-94, 0, -281, 94, 125, -156, 86, 86, 86],
    [-125, 0, -156, 125, 188, -31, 127, 127, 127],
    [-188, 0, -31, 188, 250, 156, 126, 126, 126],
    [-94, 0, 156, 94, 188, 344, 128, 128, 128],
    [-62, 0, 344, 62, 125, 531, 130, 130, 130],
    [-62, 0, 531, 62, 62, 656, 128, 128, 128],
    [-31, 0, 656, 31, 62, 781, 0, 0, 0],
    [-312, 0, -31, 312, 500, 156, 98, 186, 195],
    [-188, 0, 344, 188, 250, 531, 152, 65, 162],
    [-188, 0, -188, 188, 312, -62, 103, 60, 109],
  ],
  "minecraft:skeleton": [
    [-250, 750, -125, 250, 1500, 125, 92, 91, 92],
    [-250, 1500, -250, 250, 2000, 250, 174, 174, 174],
    [-281, 1469, -281, 281, 2031, 281, 0, 0, 0],
    [-375, 750, -62, -250, 1500, 62, 168, 168, 168],
    [250, 750, -62, 375, 1500, 62, 168, 168, 168],
    [-188, 0, -62, -62, 750, 62, 170, 169, 170],
    [62, 0, -62, 188, 750, 62, 170, 169, 170],
  ],
  "minecraft:skeleton_horse": [
    [-312, 688, -688, 312, 1312, 688, 64, 64, 64],
    [-94, 404, 204, 94, 1303, 801, 0, 0, 0],
    [62, 0, 438, 312, 688, 688, 102, 102, 97],
    [-312, 0, 438, -62, 688, 688, 102, 102, 97],
    [62, 0, -688, 312, 688, -438, 102, 102, 97],
    [-312, 0, -688, -62, 688, -438, 102, 102, 97],
    [-125, 883, -694, 125, 1752, 60, 0, 0, 0],
    [-188, 1533, -319, 188, 2022, 217, 37, 36, 36],
    [-125, 1752, -589, 125, 2179, -162, 128, 128, 128],
    [-129, 1744, 127, 12, 1947, 280, 0, 0, 0],
    [-12, 1744, 127, 129, 1947, 280, 0, 0, 0],
    [-537, 1680, 90, -303, 2105, 372, 0, 0, 0],
    [303, 1680, 90, 537, 2105, 372, 0, 0, 0],
    [194, 1874, -353, 204, 2148, 660, 101, 62, 31],
    [-194, 1874, -353, -184, 2148, 660, 101, 62, 31],
    [-141, 1730, -448, 141, 2106, -141, 104, 73, 48],
    [-203, 1512, -340, 203, 2044, 238, 125, 94, 65],
    [125, 1837, -450, 188, 2008, -279, 81, 81, 81],
    [-188, 1837, -450, -125, 2008, -279, 81, 81, 81],
    [-62, 873, -281, 62, 1802, 327, 126, 126, 107],
    [312, 812, 125, 500, 1312, 625, 103, 79, 42],
    [-500, 812, 125, -312, 1312, 625, 103, 79, 42],
    [-344, 719, -250, 344, 1344, 375, 100, 67, 41],
  ],
  "minecraft:slime": [
    [-188, 62, -188, 188, 438, 188, 100, 173, 82],
    [-206, 250, -219, -81, 375, -94, 19, 32, 14],
    [81, 250, -219, 206, 375, -94, 19, 32, 14],
    [0, 125, -219, 62, 188, -156, 10, 10, 10],
  ],
  "minecraft:small_fireball": [
    [-500, -250, 0, 500, 750, 10, 40, 29, 18],
  ],
  "minecraft:sniffer": [
    [-812, 531, -1281, 812, 2094, 1281, 25, 76, 54],
    [-781, 250, -1250, 781, 2062, 1250, 91, 14, 12],
    [-781, 500, -1250, 781, 510, 1250, 80, 8, 8],
    [-406, 188, -1931, 406, 1312, -1244, 5, 13, 10],
    [-406, 375, -1931, 406, 385, -1244, 137, 40, 26],
    [400, 125, -1681, 463, 1312, -1244, 93, 43, 30],
    [-463, 125, -1681, -400, 1312, -1244, 98, 47, 32],
    [-406, 1125, -2494, 406, 1250, -1931, 203, 159, 43],
    [-406, 375, -2494, 406, 1125, -1931, 232, 170, 40],
    [-688, 0, -1188, -250, 625, -688, 102, 37, 37],
    [-688, 0, -250, -250, 625, 250, 101, 33, 32],
    [-688, 0, 688, -250, 625, 1188, 100, 37, 37],
    [250, 0, -1188, 688, 625, -688, 96, 32, 34],
    [250, 0, -250, 688, 625, 250, 100, 34, 34],
    [250, 0, 688, 688, 625, 1188, 98, 33, 35],
  ],
  "minecraft:snowball": [
    [-250, -125, 0, 250, 375, 10, 143, 153, 153],
  ],
  "minecraft:snow_golem": [
    [-219, 1281, -219, 219, 1719, 219, 215, 224, 224],
    [-31, 1031, -31, 656, 1094, 31, 122, 92, 35],
    [-31, 1031, -31, 656, 1094, 31, 122, 92, 35],
    [-281, 719, -281, 281, 1281, 281, 223, 231, 231],
    [-344, 31, -344, 344, 719, 344, 229, 238, 238],
  ],
  "minecraft:spider": [
    [-250, 312, -688, 250, 812, -188, 101, 54, 47],
    [-188, 375, -188, 188, 750, 188, 43, 37, 32],
    [-312, 312, 188, 312, 812, 938, 54, 46, 40],
    [-1188, 500, 62, -188, 625, 188, 51, 43, 38],
    [188, 500, 62, 1188, 625, 188, 51, 43, 38],
    [-1188, 500, 0, -188, 625, 125, 51, 43, 38],
    [188, 500, 0, 1188, 625, 125, 51, 43, 38],
    [-1188, 500, -62, -188, 625, 62, 51, 43, 38],
    [188, 500, -62, 1188, 625, 62, 51, 43, 38],
    [-1188, 500, -125, -188, 625, 0, 51, 43, 38],
    [188, 500, -125, 1188, 625, 0, 51, 43, 38],
  ],
  "minecraft:splash_potion": [
    [-250, -125, 0, 250, 375, 10, 16, 19, 24],
  ],
  "minecraft:squid": [
    [-375, -500, -375, 375, 500, 375, 60, 83, 101],
    [250, -1562, -62, 375, -438, 62, 18, 39, 55],
    [130, -1562, 130, 307, -438, 307, 18, 39, 55],
    [-62, -1562, 250, 62, -438, 375, 18, 39, 55],
    [-307, -1562, 130, -130, -438, 307, 18, 39, 55],
    [-375, -1562, -62, -250, -438, 62, 18, 39, 55],
    [-307, -1562, -307, -130, -438, -130, 18, 39, 55],
    [-63, -1562, -375, 63, -438, -250, 18, 39, 55],
    [130, -1562, -307, 307, -438, -130, 18, 39, 55],
  ],
  "minecraft:stray": [
    [-250, 750, -125, 250, 1500, 125, 95, 106, 105],
    [-250, 1500, -250, 250, 2000, 250, 172, 188, 189],
    [-281, 1469, -281, 281, 2031, 281, 0, 0, 0],
    [-375, 750, -62, -250, 1500, 62, 151, 168, 168],
    [250, 750, -62, 375, 1500, 62, 151, 168, 168],
    [-188, 0, -62, -62, 750, 62, 154, 171, 170],
    [62, 0, -62, 188, 750, 62, 154, 171, 170],
  ],
  "minecraft:strider": [
    [-375, 0, -125, -125, 1000, 125, 109, 69, 74],
    [125, 0, -125, 375, 1000, 125, 109, 69, 74],
    [-500, 875, -500, 500, 1750, 500, 151, 53, 55],
    [500, 1188, -500, 757, 1892, 500, 0, 0, 0],
    [500, 1500, -500, 817, 2180, 500, 0, 0, 0],
    [500, 1750, -500, 982, 2325, 500, 0, 0, 0],
    [-982, 1750, -500, -500, 2325, 500, 0, 0, 0],
    [-817, 1500, -500, -500, 2180, 500, 0, 0, 0],
    [-757, 1188, -500, -500, 1892, 500, 0, 0, 0],
  ],
  "minecraft:sulfur_cube": [
    [-562, 0, -562, 562, 1125, 562, 0, 0, 0],
    [-497, 66, -497, 497, 1059, 497, 227, 222, 171],
  ],
  "minecraft:tadpole": [
    [-94, 188, -156, 94, 312, 31, 72, 51, 33],
    [0, 188, -31, 10, 312, 406, 0, 0, 0],
  ],
  "minecraft:thrown_trident": [
    [-32, -188, -32, 32, 1751, 32, 106, 166, 152],
    [-94, 1375, -31, 94, 1500, 31, 90, 150, 135],
    [-156, 1438, -31, -94, 1688, 31, 182, 211, 200],
    [94, 1438, -31, 156, 1688, 31, 182, 211, 200],
  ],
  "minecraft:tnt_minecart": [
    [-625, 1188, -500, 625, 1312, 500, 86, 92, 94],
    [-625, 1312, -500, -500, 1812, 500, 95, 102, 104],
    [500, 1312, -500, 625, 1812, 500, 95, 102, 104],
    [-500, 1312, -500, 500, 1812, -375, 95, 102, 104],
    [-500, 1312, 375, 500, 1812, 500, 95, 102, 104],
  ],
  "minecraft:trader_llama": [
    [-125, 1688, -1000, 125, 1938, -438, 205, 182, 145],
    [-250, 938, -750, 250, 2062, -375, 235, 213, 167],
    [-250, 2062, -625, -62, 2250, -500, 232, 210, 166],
    [62, 2062, -625, 250, 2250, -500, 232, 210, 166],
    [-531, 812, -125, -344, 1312, 375, 104, 79, 42],
    [344, 812, -125, 531, 1312, 375, 104, 76, 35],
    [-375, 688, -312, 375, 1812, 312, 227, 202, 149],
    [-344, 0, 250, -94, 875, 500, 238, 215, 167],
    [94, 0, 250, 344, 875, 500, 238, 215, 167],
    [-344, 0, -438, -94, 875, -188, 238, 215, 167],
    [94, 0, -438, 344, 875, -188, 238, 215, 167],
  ],
  "minecraft:tripod_camera": [
    [-250, -250, -312, 250, 250, 312, 128, 122, 113],
    [-31, -1625, -31, 31, -250, 31, 101, 74, 33],
    [-31, -1625, -31, 31, -250, 31, 101, 74, 33],
    [-31, -1625, -31, 31, -250, 31, 101, 74, 33],
    [-31, -1625, -31, 31, -250, 31, 101, 74, 33],
  ],
  "minecraft:tropicalfish": [
    [-62, 0, -188, 62, 188, 188, 223, 223, 223],
    [0, 188, -187, 10, 438, 188, 255, 255, 255],
    [0, 0, 188, 10, 188, 438, 170, 170, 170],
    [21, 0, -7, 146, 125, 3, 255, 255, 255],
    [-146, 0, -7, -21, 125, 3, 234, 234, 234],
  ],
  "minecraft:turtle": [
    [-188, 62, -812, 188, 375, -438, 84, 167, 77],
    [-281, -500, -1500, 281, 625, -1438, 192, 190, 134],
    [-594, -625, -1250, 594, 625, -875, 145, 144, 95],
    [-344, -500, -1438, 344, 625, -1250, 192, 189, 134],
    [-344, 62, 688, -94, 125, 1312, 123, 133, 90],
    [94, 62, 688, 344, 125, 1312, 123, 133, 90],
    [-1125, 125, -375, -312, 188, -62, 65, 171, 68],
    [312, 125, -375, 1125, 188, -62, 65, 171, 68],
  ],
  "minecraft:vex": [
    [-94, 125, -62, 94, 375, 62, 115, 135, 155],
    [-81, 12, -50, 81, 300, 50, 86, 108, 129],
    [-156, 375, -156, 156, 688, 156, 153, 173, 192],
    [-181, 147, -56, -69, 384, 56, 134, 156, 178],
    [69, 147, -56, 181, 384, 56, 134, 156, 178],
    [31, 0, 62, 531, 312, 72, 104, 107, 111],
    [-531, 0, 62, -31, 312, 72, 104, 107, 111],
  ],
  "minecraft:villager": [
    [-250, 1500, -250, 250, 2125, 250, 165, 120, 95],
    [-62, 1438, -375, 62, 1688, -250, 144, 94, 67],
    [-250, 750, -188, 250, 1500, 188, 91, 64, 54],
    [-281, 344, -219, 281, 1531, 219, 92, 68, 63],
    [-250, 1000, -125, 250, 1250, 125, 107, 79, 73],
    [-500, 1000, -125, -250, 1500, 125, 110, 81, 75],
    [250, 1000, -125, 500, 1500, 125, 110, 81, 75],
    [-250, 0, -125, 0, 750, 125, 91, 69, 61],
    [0, 0, -125, 250, 750, 125, 91, 69, 61],
  ],
  "minecraft:villager_v2": [
    [-250, 1500, -250, 250, 2125, 250, 166, 122, 96],
    [-281, 1469, -281, 281, 2156, 281, 0, 0, 0],
    [-506, 994, -381, 506, 2006, -306, 0, 0, 0],
    [-62, 1438, -375, 62, 1688, -250, 144, 94, 67],
    [-250, 750, -188, 250, 1500, 188, 116, 101, 94],
    [-281, 344, -219, 281, 1531, 219, 28, 28, 28],
    [-250, 1000, -125, 250, 1250, 125, 183, 129, 104],
    [-500, 1000, -125, -250, 1500, 125, 186, 132, 108],
    [250, 1000, -125, 500, 1500, 125, 186, 132, 108],
    [-250, 0, -125, 0, 750, 125, 159, 123, 106],
    [0, 0, -125, 250, 750, 125, 159, 123, 106],
  ],
  "minecraft:vindicator": [
    [-250, 1500, -250, 250, 2125, 250, 125, 130, 131],
    [-62, 1438, -375, 62, 1688, -250, 104, 110, 110],
    [-250, 750, -188, 250, 1500, 188, 69, 46, 48],
    [-281, 344, -219, 281, 1531, 219, 100, 95, 91],
    [-500, 1000, -125, -250, 1500, 125, 61, 57, 53],
    [250, 1000, -125, 500, 1500, 125, 61, 57, 53],
    [-250, 1000, -125, 250, 1250, 125, 106, 108, 107],
    [-250, 0, -125, 0, 750, 125, 38, 77, 78],
    [0, 0, -125, 250, 750, 125, 38, 77, 78],
    [-500, 750, -125, -250, 1500, 125, 71, 68, 65],
    [250, 750, -125, 500, 1500, 125, 71, 68, 65],
  ],
  "minecraft:wandering_trader": [
    [-250, 1500, -250, 250, 2125, 250, 90, 64, 66],
    [-281, 1469, -281, 281, 2156, 281, 45, 31, 12],
    [-506, 994, -381, 506, 2006, -306, 0, 0, 0],
    [-62, 1438, -375, 62, 1688, -250, 144, 94, 67],
    [-250, 750, -188, 250, 1500, 188, 70, 73, 45],
    [-281, 344, -219, 281, 1531, 219, 64, 48, 32],
    [-250, 1000, -125, 250, 1250, 125, 174, 111, 63],
    [-500, 1000, -125, -250, 1500, 125, 60, 88, 135],
    [250, 1000, -125, 500, 1500, 125, 60, 88, 135],
    [-250, 0, -125, 0, 750, 125, 115, 76, 61],
    [0, 0, -125, 250, 750, 125, 115, 76, 61],
  ],
  "minecraft:warden": [
    [-562, 812, -250, 562, 2125, 438, 14, 22, 28],
    [-562, 812, -256, 0, 2125, -246, 22, 26, 24],
    [0, 812, -256, 562, 2125, -246, 22, 26, 24],
    [-500, 2125, -312, 500, 3125, 312, 11, 29, 37],
    [-1500, 2688, 0, -500, 3688, 10, 2, 22, 23],
    [500, 2688, 0, 1500, 3688, 10, 2, 22, 23],
    [-1062, 375, -188, -562, 2125, 312, 54, 72, 71],
    [562, 375, -188, 1062, 2125, 312, 54, 71, 70],
    [-562, 0, -188, -188, 812, 188, 31, 46, 50],
    [188, 0, -188, 562, 812, 188, 31, 46, 50],
  ],
  "minecraft:wind_charge_projectile": [
    [-188, 16, -188, 188, 266, 188, 97, 100, 117],
    [-250, 78, -250, 250, 203, 250, 92, 96, 112],
    [-125, 16, -125, 125, 266, 125, 178, 184, 193],
  ],
  "minecraft:wither": [
    [-625, 1069, -31, 625, 1256, 156, 26, 26, 26],
    [-125, 444, -31, 62, 1069, 156, 30, 31, 31],
    [-375, 850, 0, 312, 975, 125, 44, 46, 46],
    [-375, 694, 0, 312, 819, 125, 44, 46, 46],
    [-375, 537, 0, 312, 662, 125, 44, 46, 46],
    [0, 1125, 0, 188, 1500, 188, 26, 26, 26],
    [-250, 1250, -250, 250, 1750, 250, 62, 63, 63],
    [-750, 1125, -250, -375, 1500, 125, 76, 78, 78],
    [375, 1125, -250, 750, 1500, 125, 76, 78, 78],
  ],
  "minecraft:wither_skeleton": [
    [-250, 750, -125, 250, 1500, 125, 25, 25, 25],
    [-250, 1500, -250, 250, 2000, 250, 45, 46, 46],
    [-281, 1469, -281, 281, 2031, 281, 0, 0, 0],
    [-375, 750, -62, -250, 1500, 62, 37, 37, 37],
    [250, 750, -62, 375, 1500, 62, 37, 37, 37],
    [-188, 0, -62, -62, 750, 62, 38, 39, 39],
    [62, 0, -62, 188, 750, 62, 38, 39, 39],
  ],
  "minecraft:wither_skull": [
    [-250, 0, -250, 250, 500, 250, 89, 93, 93],
  ],
  "minecraft:wither_skull_dangerous": [
    [-250, 0, -250, 250, 500, 250, 117, 149, 187],
  ],
  "minecraft:wolf": [
    [-188, 469, -562, 188, 844, -312, 175, 164, 158],
    [-188, 844, -438, -62, 969, -375, 216, 212, 213],
    [62, 844, -438, 188, 969, -375, 216, 212, 213],
    [-94, 470, -750, 94, 657, -500, 148, 142, 144],
    [-188, 188, -62, 188, 750, 312, 199, 196, 196],
    [-250, 438, -62, 250, 812, 375, 210, 207, 207],
    [-156, 0, 375, -31, 500, 500, 191, 187, 186],
    [31, 0, 375, 156, 500, 500, 191, 187, 186],
    [-156, 0, -312, -31, 500, -188, 191, 187, 186],
    [31, 0, -312, 156, 500, -188, 191, 187, 186],
    [-62, 250, 438, 62, 750, 562, 207, 204, 204],
  ],
  "minecraft:zoglin": [
    [-501, 686, -439, 501, 1564, 1189, 202, 106, 103],
    [-1, 1374, -626, 9, 2001, 564, 0, 0, 0],
    [-438, 1335, -1124, 438, 2486, -73, 191, 137, 130],
    [-500, 1950, -875, -375, 2487, -268, 187, 186, 187],
    [375, 1950, -875, 500, 2487, -268, 187, 186, 187],
    [-726, 1598, -305, -438, 2000, 107, 218, 108, 104],
    [438, 1598, -305, 726, 2000, 107, 218, 108, 104],
    [-500, 0, 812, -188, 688, 1125, 124, 116, 113],
    [188, 0, 812, 500, 688, 1125, 207, 119, 115],
    [-500, 0, -375, -125, 875, 0, 200, 114, 109],
    [125, 0, -375, 500, 875, 0, 152, 114, 92],
  ],
  "minecraft:zombie": [
    [-250, 750, -125, 250, 1500, 125, 12, 149, 158],
    [-250, 1500, -250, 250, 2000, 250, 77, 112, 60],
    [-281, 1469, -281, 281, 2031, 281, 0, 0, 0],
    [-500, 750, -125, -250, 1500, 125, 70, 152, 115],
    [250, 750, -125, 500, 1500, 125, 70, 152, 115],
    [-244, 0, -125, 6, 750, 125, 76, 66, 152],
    [-6, 0, -125, 244, 750, 125, 76, 66, 152],
  ],
  "minecraft:zombie_horse": [
    [-312, 688, -688, 312, 1312, 688, 69, 87, 49],
    [-94, 404, 204, 94, 1303, 801, 16, 19, 10],
    [62, 0, 438, 312, 688, 688, 52, 69, 37],
    [-312, 0, 438, -62, 688, 688, 52, 69, 37],
    [62, 0, -688, 312, 688, -438, 52, 69, 37],
    [-312, 0, -688, -62, 688, -438, 52, 69, 37],
    [-125, 883, -694, 125, 1752, 60, 38, 54, 40],
    [-188, 1533, -319, 188, 2022, 217, 69, 89, 44],
    [-125, 1752, -589, 125, 2179, -162, 26, 32, 17],
    [-129, 1744, 127, 12, 1947, 280, 83, 102, 48],
    [-12, 1744, 127, 129, 1947, 280, 83, 102, 48],
    [-537, 1680, 90, -303, 2105, 372, 0, 0, 0],
    [303, 1680, 90, 537, 2105, 372, 0, 0, 0],
    [194, 1874, -353, 204, 2148, 660, 26, 15, 6],
    [-194, 1874, -353, -184, 2148, 660, 26, 15, 6],
    [-141, 1730, -448, 141, 2106, -141, 0, 0, 0],
    [-203, 1512, -340, 203, 2044, 238, 22, 13, 7],
    [125, 1837, -450, 188, 2008, -279, 81, 81, 81],
    [-188, 1837, -450, -125, 2008, -279, 81, 81, 81],
    [-62, 873, -281, 62, 1802, 327, 26, 30, 16],
    [312, 812, 125, 500, 1312, 625, 104, 79, 42],
    [-500, 812, 125, -312, 1312, 625, 104, 79, 42],
    [-344, 719, -250, 344, 1344, 375, 0, 0, 0],
  ],
  "minecraft:zombie_nautilus": [
    [-438, 500, -500, 438, 1125, 500, 168, 178, 129],
    [-438, 0, -500, 438, 500, 750, 143, 155, 104],
    [-438, 0, 312, 438, 500, 323, 107, 100, 72],
    [-312, 1, 206, 312, 501, 1081, 255, 255, 255],
    [-312, 1, 831, 312, 501, 841, 50, 59, 57],
    [-312, 251, 831, 312, 500, 1081, 0, 0, 0],
    [-188, 126, 831, 188, 376, 1081, 0, 0, 0],
    [-312, -1, 831, 312, 249, 1081, 0, 0, 0],
  ],
  "minecraft:zombie_pigman": [
    [-250, 750, -125, 250, 1500, 125, 163, 118, 91],
    [-266, 734, -141, 266, 1516, 141, 0, 0, 0],
    [-311, 1501, -249, 311, 1999, 249, 169, 149, 131],
    [-125, 1500, -312, 125, 1750, -250, 150, 130, 111],
    [125, 1500, -312, 188, 1625, -250, 213, 213, 213],
    [-188, 1500, -312, -125, 1625, -250, 213, 213, 213],
    [102, 1604, -125, 312, 1906, 125, 229, 129, 126],
    [-312, 1604, -125, -102, 1906, 125, 0, 0, 0],
    [-500, 750, -125, -250, 1500, 125, 182, 119, 100],
    [-516, 734, -141, -234, 1516, 141, 0, 0, 0],
    [250, 750, -125, 500, 1500, 125, 182, 119, 100],
    [234, 734, -141, 516, 1516, 141, 0, 0, 0],
    [-250, 0, -125, 0, 750, 125, 140, 99, 74],
    [-266, -16, -141, 16, 766, 141, 38, 21, 14],
    [0, 0, -125, 250, 750, 125, 140, 99, 74],
    [-16, -16, -141, 266, 766, 141, 38, 21, 14],
  ],
  "minecraft:zombie_villager": [
    [-281, 1469, -281, 281, 2031, 281, 128, 128, 128],
    [-266, 1484, -266, 266, 2141, 266, 56, 67, 40],
    [-78, 1422, -391, 78, 1703, -234, 107, 116, 57],
    [-250, 750, -188, 250, 1500, 188, 91, 69, 58],
    [-281, 344, -219, 281, 1531, 219, 103, 103, 103],
    [-500, 750, -125, -250, 1500, 125, 106, 104, 76],
    [250, 750, -125, 500, 1500, 125, 106, 104, 76],
    [-250, 0, -125, 0, 750, 125, 71, 80, 44],
    [0, 0, -125, 250, 750, 125, 71, 80, 44],
  ],
  "minecraft:zombie_villager_v2": [
    [-266, 1484, -266, 266, 2141, 266, 90, 111, 57],
    [-78, 1422, -391, 78, 1703, -234, 72, 74, 40],
    [-281, 1469, -281, 281, 2156, 281, 108, 146, 67],
    [-506, 994, -381, 506, 2006, -306, 0, 0, 0],
    [-250, 750, -188, 250, 1500, 188, 74, 79, 54],
    [-281, 344, -219, 281, 1531, 219, 0, 0, 0],
    [-500, 750, -125, -250, 1500, 125, 95, 127, 61],
    [250, 750, -125, 500, 1500, 125, 95, 127, 61],
    [-250, 0, -125, 0, 750, 125, 83, 100, 59],
    [0, 0, -125, 250, 750, 125, 83, 100, 59],
  ],
};

/** The same boxes in blocks. */
const ENTITY_MODELS = Object.fromEntries(Object.entries(MOB_MODELS).map(([id, parts]) => [id, parts.map((part) => [...part.slice(0, 6).map((v) => v / 1000), ...part.slice(6)])]));
