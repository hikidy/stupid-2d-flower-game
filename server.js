"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { PETAL, PETAL_RARITY, PETAL_RARITY_SCALE, PetalTypes, MOB, FACTION, sizeScaling, hpScaling, MobTypes, MobObjectTypes } = require("./staticdata");

const PORT = process.env.PORT || 3000;

// -------------------- Game Config --------------------
const TICK_RATE = 20;
const DT = 1 / TICK_RATE;

const WORLD = { w: 2000, h: 2000 };

const SNAPSHOT_RATE = 10; // snapshots/sec
const SNAPSHOT_EVERY_TICKS = Math.max(1, Math.round(TICK_RATE / SNAPSHOT_RATE));

const PLAYER = {
    radius: 15,
    maxHp: 250,
    speed: 220
};

function getPetalOrbitSpan(player, slotIndex) {
    const petal = player?.petals?.[slotIndex];
    if (!petal) return 1;

    const type = PetalTypes[petal.typeId];
    if (!type) return 1;

    const count = Math.max(1, resolvePetalMultiCount(type, petal.rarity));

    // Second-doc behavior:
    // clumped multi = one orbit slot
    // non-clumped multi = count orbit slots
    if (count <= 1) return 1;
    if (type.clumps) return 1;

    return count;
}

function getPetalOrbitLayout(player) {
    const layout = [];
    let total = 0;

    for (let i = 0; i < player.petals.length; i++) {
        const span = getPetalOrbitSpan(player, i);

        layout.push({
            slotIndex: i,
            start: total,
            span
        });

        total += span;
    }

    return {
        layout,
        total: Math.max(1, total)
    };
}

function getPetalVirtualOrbitPosition(player, virtualIndex, totalVirtual, time, slotIndex, subIndex, radius) {
    const a = player.angleBase + (virtualIndex * Math.PI * 2) / totalVirtual;

    const wobble = getMultiPetalWobble(slotIndex, subIndex, time, radius);

    return {
        x: player.x + Math.cos(a) * player.petalRadius + wobble.x,
        y: player.y + Math.sin(a) * player.petalRadius + wobble.y,
        angle: a
    };
}

function getMultiPetalPositions(cx, cy, angle, type, rarity, slotIndex = 0, time = 0, ownerPlayer = null) {
    const amount = Math.max(1, resolvePetalMultiCount(type, rarity));
    const clumps = resolvePetalClumps(type, rarity);

    if (amount <= 1) {
        return [{ x: cx, y: cy, index: 0, angle }];
    }

    const out = [];
    const r = getMultiPetalRadius(type, rarity);

    // Non-clumped multi:
    // each child petal is a full orbit petal, not a mini decoration.
    if (!clumps && ownerPlayer) {
        const { layout, total } = getPetalOrbitLayout(ownerPlayer);
        const info = layout[slotIndex];

        if (!info) {
            return [{ x: cx, y: cy, index: 0, angle }];
        }

        for (let i = 0; i < amount; i++) {
            const virtualIndex = info.start + i;
            const p = getVirtualPetalPos(ownerPlayer, virtualIndex, total);
            const wobble = getMultiPetalWobble(slotIndex, i, time, r);

            out.push({
                x: p.x + wobble.x,
                y: p.y + wobble.y,
                index: i,
                angle: p.angle
            });
        }

        return out;
    }

    // Clumped multi:
    // all petals go in a ring, none in the center.
    const spacing = r * 1.75;
    const baseAngle = angle + time * 0.8 + slotIndex * 0.37;

    for (let i = 0; i < amount; i++) {
        const a = baseAngle + (i / amount) * Math.PI * 2;
        const wobble = getMultiPetalWobble(slotIndex, i, time, r);

        out.push({
            x: cx + Math.cos(a) * spacing + wobble.x,
            y: cy + Math.sin(a) * spacing + wobble.y,
            index: i,
            angle: a
        });
    }

    return out;
}

function getMultiPetalWobble(slotIndex, subIndex, time, radius) {
    // Stable per-subpetal seeds.
    // Not random every frame, because that would look like the petal is having a medical emergency.
    const seed = (slotIndex + 1) * 92821 + (subIndex + 1) * 68917;

    const phase1 = (seed % 6283) / 1000;
    const phase2 = ((seed * 7) % 6283) / 1000;

    const amp = radius * 0.35;

    return {
        x: Math.sin(time * 3.1 + phase1) * amp + Math.sin(time * 5.7 + phase2) * amp * 0.45,
        y: Math.cos(time * 2.8 + phase2) * amp + Math.cos(time * 4.9 + phase1) * amp * 0.45
    };
}

function getPetalSpinAngle(slotIndex, subIndex, time, type, rarity) {
    // Stable offset so every petal is not perfectly synchronized like a cursed marching band.
    const seed =
        (slotIndex + 1) * 92821 +
        (subIndex + 1) * 68917 +
        (rarity + 1) * 31337 +
        String(type?.id ?? "").length * 2713;

    const offset = ((seed % 6283) / 1000);

    // Slow in-place spin.
    // Positive = clockwise-ish depending on canvas rotation.
    const spinSpeed = type?.spinSpeed ?? 0.75;

    return offset + time * spinSpeed;
}

const PETAL_EXTEND = {
    retractedRadius: 18,
    baseRadius: 38,
    extendedRadius: 85,
    extendSpeed: 14 // per-second smoothing
};

// global mob density (mobs per world pixel)
const MOB_DENSITY = 1 / 125000;
let MAX_MOBS = Math.max(100, Math.round(WORLD.w * WORLD.h * MOB_DENSITY));
const PICKUP_LIFETIME = 15; // seconds

// range (in world pixels) within which mobs are considered "active" for
// updates.  Mobs outside this distance from every player are left sleeping
// to save CPU.  This value is squared once and used where appropriate.
const MOB_UPDATE_RANGE = 1000;
const MOB_UPDATE_RANGE2 = MOB_UPDATE_RANGE * MOB_UPDATE_RANGE;
const SUMMON_HARD_LEASH_RANGE = MOB_UPDATE_RANGE * 0.82;
const SUMMON_SOFT_LEASH_RANGE = MOB_UPDATE_RANGE * 0.65;

const INVENTORY = {
    max: 24 // inventory slots per player
};

const CRAFTING = {
    cost: 5,
    successChanceByTargetRarity: [
        0,       // unused, you never craft into rarity 0
        0.64,    // craft into R1
        0.32,    // craft into R2
        0.16,    // craft into R3
        0.08,    // craft into R4
        0.04,    // craft into R5
        0.02,    // craft into R6
        0.01,    // craft into R7
        0.005    // craft into R8
    ]
};

function getCraftSuccessChance(targetRarity) {
    targetRarity = clampPetalRarity(targetRarity);
    return CRAFTING.successChanceByTargetRarity[targetRarity] ?? 0;
}

// Server-side wobbly petal sim parameters
const PETAL_FOLLOW = {
    stiffness: 190,
    damping: 18
};

const PETAL_WOBBLE = {
    ampMin: 1.5,
    ampMax: 5.0,
    amp2Min: 0.8,
    amp2Max: 3.0,
    freqMin: 1.0,   // Hz
    freqMax: 2.8,
    freq2Min: 2.5,
    freq2Max: 5.0
};

let nextGarbageFaction = FACTION.GARBAGE_BASE;

function isFriendlyFaction(a, b) {
    return (
        a != null &&
        b != null &&
        a !== FACTION.NEUTRAL &&
        b !== FACTION.NEUTRAL &&
        a === b
    );
}

// For general "can this thing hurt this other thing?"
function canDamageFaction(attackerFaction, targetFaction) {
    // Missing faction? Old behavior: allow damage.
    if (attackerFaction == null || targetFaction == null) return true;

    // Never damage real allies.
    if (isFriendlyFaction(attackerFaction, targetFaction)) return false;

    // Neutral mobs should not randomly murder each other.
    if (attackerFaction === FACTION.NEUTRAL && targetFaction === FACTION.NEUTRAL) return false;

    // Player/summons can hit neutral mobs.
    // Neutral mobs can hit player/summons.
    // Bees/mechs/player faction can all fight each other.
    return true;
}

// For target scanning. Same logic, but slightly stricter naming.
function isEnemyFaction(a, b) {
    return canDamageFaction(a, b);
}

// Keep old calls from exploding.
function isHostileFaction(a, b) {
    return isEnemyFaction(a, b);
}

function clampPetalRarity(r) {
    return clamp((r | 0), PETAL_RARITY.min, PETAL_RARITY.max);
}

function petalStatScale(rarity) {
    return Math.pow(3, clampPetalRarity(rarity));
}

function summonShouldHardReturnToOwner(summon, owner) {
    if (!summon || !owner) return false;

    const leash = summon.hardLeashRange ?? SUMMON_HARD_LEASH_RANGE;
    return dist2(summon.x, summon.y, owner.x, owner.y) > leash * leash;
}

// rolls a pickup rarity from a mob
function rollDropRarityFromMob(mobRarity) {
    const cap = PETAL_RARITY.max;
    const base = clamp(mobRarity | 0, 0, cap);

    const SUPER_RARITY = 7;
    const ownRarityChance = Math.pow(0.5, base);

    if (base <= 0) return 0;

    if (base < SUPER_RARITY && Math.random() < ownRarityChance) {
        return base;
    }

    const maxDrop = base - 1;

    const r = Math.random();

    if (r < 0.55) return clamp(maxDrop, 0, cap);
    if (r < 0.80) return clamp(maxDrop - 1, 0, cap);
    if (r < 0.93) return clamp(maxDrop - 2, 0, cap);
    if (r < 0.985) return clamp(maxDrop - 3, 0, cap);

    return 0;
}

// Petal type definitions are loaded from staticdata.js

function resolvePetalMultiCount(type, rarity) {
    const multi = type?.multi ?? 1;

    if (Array.isArray(multi)) {
        const r = clampPetalRarity(rarity);
        return clamp((multi[r] ?? multi[multi.length - 1] ?? 1) | 0, 0, 32);
    }

    return clamp((multi | 0), 0, 32);
}

function resolvePetalClumps(type, rarity) {
    const count = Math.max(1, resolvePetalMultiCount(type, rarity));
    return !!type?.clumps && count > 1;
}

function petalHasMulti(type, rarity) {
    return resolvePetalMultiCount(type, rarity) > 1;
}

function getPetalMultiDamage(petal, type) {
    const count = Math.max(1, resolvePetalMultiCount(type, petal.rarity));

    if (type?.splitMultiDamage) {
        return petal.dmg / count;
    }

    return petal.dmg;
}

function getPetalSlotAmount(player, slotIndex) {
    const petal = player?.petals?.[slotIndex];
    if (!petal) return 1;

    const type = PetalTypes[petal.typeId];
    if (!type) return 1;

    const amount = Math.max(1, resolvePetalMultiCount(type, petal.rarity));
    const clumps = resolvePetalClumps(type, petal.rarity);

    // Second-doc behavior:
    // clumped multi advances by 1 orbit position
    // non-clumped multi advances by amount orbit positions
    return clumps ? 1 : amount;
}

function getPetalOrbitLayout(player) {
    const layout = [];
    let total = 0;

    for (let slotIndex = 0; slotIndex < player.petals.length; slotIndex++) {
        const petal = player.petals[slotIndex];
        const disabled = petal && isPetalSlotStackDisabled(player, slotIndex);

        const amount = disabled ? 1 : getPetalSlotAmount(player, slotIndex);

        layout[slotIndex] = {
            start: total,
            amount
        };

        total += amount;
    }

    return {
        layout,
        total: Math.max(1, total)
    };
}

function getVirtualPetalAngle(player, virtualIndex, totalVirtual) {
    return player.angleBase + (virtualIndex * Math.PI * 2) / totalVirtual;
}

function getVirtualPetalPos(player, virtualIndex, totalVirtual) {
    const a = getVirtualPetalAngle(player, virtualIndex, totalVirtual);

    return {
        x: player.x + Math.cos(a) * player.petalRadius,
        y: player.y + Math.sin(a) * player.petalRadius,
        angle: a
    };
}

function getAlivePetalTypeCount(player, typeId) {
    if (!player || !Array.isArray(player.petals)) return 0;

    let count = 0;

    for (const petal of player.petals) {
        if (!petal) continue;
        if (petal.typeId !== typeId) continue;
        if (!petal.isAlive()) continue;

        count++;
    }

    return count;
}

function getPetalTypeCount(player, typeId) {
    if (!player || !Array.isArray(player.petals)) return 0;

    let count = 0;

    for (const petal of player.petals) {
        if (!petal) continue;
        if (petal.typeId !== typeId) continue;

        count++;
    }

    return count;
}

function isPetalSlotStackDisabled(player, slotIndex) {
    if (!player || !Array.isArray(player.petals)) return false;

    const petal = player.petals[slotIndex];
    if (!petal) return false;

    const type = PetalTypes[petal.typeId];
    if (!type?.unstackable) return false;

    // Only the first equipped instance is allowed to exist/spawn.
    for (let i = 0; i < slotIndex; i++) {
        const other = player.petals[i];
        if (!other) continue;

        if (other.typeId === petal.typeId) {
            return true;
        }
    }

    return false;
}

function getPlayerMaxPetalReach(player) {
    if (!player || !Array.isArray(player.petals)) {
        return PETAL.radius;
    }

    let reach = PETAL.radius;

    for (const petal of player.petals) {
        if (!petal) continue;

        const type = PetalTypes[petal.typeId];
        if (!type) continue;

        const amount = Math.max(1, resolvePetalMultiCount(type, petal.rarity));
        const r = getMultiPetalRadius(type, petal.rarity);

        if (resolvePetalClumps(type, petal.rarity)) {
            // Clumped petals can extend a little around their parent slot.
            reach = Math.max(reach, r * (1 + Math.max(0, amount - 1) * 1.75));
        } else {
            // Spread petals are already accounted for by orbit layout.
            reach = Math.max(reach, r);
        }
    }

    return reach;
}

function getPetalRadius(type, rarity) {
    const mult = Number.isFinite(type?.radius) ? type.radius : 1;
    return PETAL.radius * mult;
}

function getMultiPetalRadius(type, rarity) {
    const count = resolvePetalMultiCount(type, rarity);
    const baseRadius = getPetalRadius(type, rarity);

    if (count <= 1) return baseRadius;

    return baseRadius;
}

function syncPetalMultiState(petal) {
    const type = PetalTypes[petal.typeId];
    const amount = Math.max(1, resolvePetalMultiCount(type, petal.rarity));

    if (!Array.isArray(petal.multiHp)) petal.multiHp = [];
    if (!Array.isArray(petal.multiHitCd)) petal.multiHitCd = [];
    if (!Array.isArray(petal.multiDamageCd)) petal.multiDamageCd = [];
    if (!Array.isArray(petal.multiReloadLeft)) petal.multiReloadLeft = [];

    while (petal.multiHp.length < amount) petal.multiHp.push(petal.maxHp);
    while (petal.multiHitCd.length < amount) petal.multiHitCd.push(0);
    while (petal.multiDamageCd.length < amount) petal.multiDamageCd.push(0);
    while (petal.multiReloadLeft.length < amount) petal.multiReloadLeft.push(0);

    petal.multiHp.length = amount;
    petal.multiHitCd.length = amount;
    petal.multiDamageCd.length = amount;
    petal.multiReloadLeft.length = amount;

    for (let i = 0; i < amount; i++) {
        if (!Number.isFinite(petal.multiHp[i])) petal.multiHp[i] = petal.maxHp;
        if (!Number.isFinite(petal.multiHitCd[i])) petal.multiHitCd[i] = 0;
        if (!Number.isFinite(petal.multiDamageCd[i])) petal.multiDamageCd[i] = 0;
        if (!Number.isFinite(petal.multiReloadLeft[i])) petal.multiReloadLeft[i] = 0;
    }
}

function petalMultiAliveCount(petal) {
    syncPetalMultiState(petal);

    let alive = 0;

    for (let i = 0; i < petal.multiHp.length; i++) {
        if ((petal.multiHp[i] ?? 0) > 0) alive++;
    }

    return alive;
}

const PetalTypeList = Object.values(PetalTypes);

// -------------------- Mob Types --------------------
const MobTypeList = Object.values(MobTypes);
// -------------------- Mob Object Types (projectiles, etc.) --------------------
let nextMobObjectId = 1;
const mobObjects = [];
const deadSet = new Set();
class MobObject {
    constructor(type, rarity, x, y, angle, targetPlayerId, ownerMobId) {
        this.id = nextMobObjectId++;
        this.type = type.id;
        this.label = type.label ?? type.id;

        this.rarity = clamp(rarity | 0, 0, sizeScaling.length - 1);
        const statScale = Math.pow(3, this.rarity) || 1;

        this.dmg = (type.baseDmg ?? 1) * statScale;
        this.maxHp = (type.baseHp ?? 1) * statScale;
        this.hp = this.maxHp;

        this.radius = (type.radius ?? 6) * sizeScaling[this.rarity];

        this.size = targetPlayerId ?? null;

        this.speed = type.speed ?? 400;
        this.life = type.life ?? 2.5;

        this.baseSpeed = this.speed;
        this.baseIdleSpeed = this.idleSpeed;

        this.slowLeft = 0;
        this.slowAmount = 0;

        this.homing = !!type.homing;
        this.turnRate = type.turnRate ?? 0;

        this.x = x;
        this.y = y;
        this.angle = angle ?? 0;

        this.vx = 0;
        this.vy = 0;

        this.targetPlayerId = targetPlayerId ?? null;
        this.ownerMobId = ownerMobId ?? null;

        this.hitCd = 0;
    }

    update(dt, playersById) {
        if (this.hitCd > 0) this.hitCd = Math.max(0, this.hitCd - dt);

        this.life -= dt;
        if (this.life <= 0 || this.hp <= 0) return;

        // allow either a player or another mob to be the missile's target
        let t = null;
        if (this.targetPlayerId != null) {
            t = playersById.get(this.targetPlayerId) || mobById.get(this.targetPlayerId) || null;
        }
        if (t) {
            const desired = leadAngle(this.x, this.y, t.x, t.y, t.vx || 0, t.vy || 0, this.speed);

            if (this.homing) {
                let d = (desired - this.angle) % (Math.PI * 2);
                if (d > Math.PI) d -= Math.PI * 2;
                if (d < -Math.PI) d += Math.PI * 2;

                const maxStep = this.turnRate * dt;
                this.angle += clamp(d, -maxStep, maxStep);
            }
        }

        this.vx = Math.cos(this.angle) * this.speed;
        this.vy = Math.sin(this.angle) * this.speed;

        const r = this.radius;
        const tryX = clamp(this.x + this.vx * dt, r, WORLD.w - r);
        if (!isWallAt(tryX, this.y)) this.x = tryX; else this.hp = 0;

        const tryY = clamp(this.y + this.vy * dt, r, WORLD.h - r);
        if (!isWallAt(this.x, tryY)) this.y = tryY; else this.hp = 0;
    }

    isDead() { return this.life <= 0 || this.hp <= 0; }
    toJSON() { return { ...this }; }
}
// -------------------- Map & Spawn Zones --------------------
let currentMapData = null;
const mobSpawnZones = [];
const spawnObjects = []; // objects used for player spawn points
let wallTiles = null; // { width, height, tilewidth, tileheight, data[] }

function getMobLightningConfig(mob) {
    const type = MobTypes[mob.type];
    const cfg = type?.lightning;
    if (!cfg) return null;

    const r = clampPetalRarity(mob.rarity);

    return {
        cooldown: cfg.cooldownByRarity?.[r] ?? cfg.cooldown ?? 3,
        bounces: cfg.bouncesByRarity?.[r] ?? cfg.bounces ?? 2,
        range: (cfg.range ?? 125) * Math.pow(1.15, r),
        damage: (cfg.damage ?? 2) * petalStatScale(r)
    };
}

function zapTarget(from, target, damage) {
    if (!target || !canTakeDamage(target)) return false;

    applyEntityDamage(target, damage, from, {
        targetCdProp: "hitCd",
        targetCd: 0.12
    });

    return true;
}

function fireMobLightning(mob, firstTarget) {
    const cfg = getMobLightningConfig(mob);
    if (!cfg || !firstTarget) return;

    let current = firstTarget;
    const hit = new Set();

    for (let i = 0; i < cfg.bounces; i++) {
        if (!current || hit.has(current.id)) break;

        zapTarget(mob, current, cfg.damage);
        hit.add(current.id);

        let next = null;
        let bestD2 = cfg.range * cfg.range;

        const candidates = [...playersArr, ...mobsArr];

        for (const other of candidates) {
            if (!other || other === mob || other === current) continue;
            if (hit.has(other.id)) continue;
            if (!canTakeDamage(other)) continue;
            if (!isEnemyFaction(mob.faction, other.faction)) continue;

            const d2 = dist2(current.x, current.y, other.x, other.y);
            if (d2 < bestD2) {
                bestD2 = d2;
                next = other;
            }
        }

        current = next;
    }
}

function findNearestEnemyInGrid(self, grid, cellSize, range) {
    const range2 = range * range;

    const scx = toCell(self.x, cellSize);
    const scy = toCell(self.y, cellSize);

    const cellRad = ((range / cellSize) | 0) + 1;

    let best = null;
    let bestD2 = range2;

    for (let dy = -cellRad; dy <= cellRad; dy++) {
        for (let dx = -cellRad; dx <= cellRad; dx++) {
            const k = gridKey(scx + dx, scy + dy);
            const bucket = grid.get(k);
            if (!bucket) continue;

            for (let i = 0; i < bucket.length; i++) {
                const other = bucket[i];
                if (other === self || other.hp <= 0) continue;
                if (!isHostileFaction(self.faction, other.faction)) continue;

                const ddx = other.x - self.x;
                const ddy = other.y - self.y;
                const d2 = ddx * ddx + ddy * ddy;
                if (d2 < bestD2) {
                    bestD2 = d2;
                    best = other;
                }
            }
        }
    }
    return best;
}

function findNearestEnemyMobForSummon(summon, range) {
    if (!summon || summon.hp <= 0) return null;

    const range2 = range * range;
    let best = null;
    let bestD2 = range2;

    for (const mob of mobsArr) {
        if (!mob || mob === summon || mob.hp <= 0) continue;
        if (mob.isPetalSummon) continue;
        if (!isEnemyFaction(summon.faction, mob.faction)) continue;

        const d2 = dist2(summon.x, summon.y, mob.x, mob.y);

        if (d2 < bestD2) {
            bestD2 = d2;
            best = mob;
        }
    }

    return best;
}

function parseSpawnObjects(map) {
    const spawns = [];
    if (!map.layers) return spawns;
    for (const layer of map.layers) {
        if (layer.type !== "objectgroup") continue;
        for (const obj of layer.objects || []) {
            // recognize either layer named 'spawn' or property 'is_spawn'
            let isSpawn = false;
            if (layer.name && layer.name.toLowerCase().includes("is_spawn")) {
                isSpawn = true;
            }
            if (obj.properties) {
                for (const prop of obj.properties) {
                    if (prop.name === "is_spawn") {
                        isSpawn = prop.value === true || prop.value === "true";
                    }
                }
            }
            if (!isSpawn) continue;

            const poly = (obj.polygon || []).map(p => ({ x: p.x, y: p.y }));
            spawns.push({ polygon: poly, offsetX: obj.x || 0, offsetY: obj.y || 0 });
        }
    }
    return spawns;
}

function getRandomSpawnPoint() {
    if (spawnObjects.length === 0) {
        console.warn("No player spawn objects found. Using random fallback.");
        return {
            x: randf(PLAYER.radius, WORLD.w - PLAYER.radius),
            y: randf(PLAYER.radius, WORLD.h - PLAYER.radius)
        };
    }

    for (let attempt = 0; attempt < 30; attempt++) {
        const obj = pick(spawnObjects);

        let candidate;
        if (obj.polygon && obj.polygon.length > 0) {
            candidate = randomPointInPolygon(obj.polygon, obj.offsetX, obj.offsetY);
        } else {
            candidate = { x: obj.offsetX, y: obj.offsetY };
        }

        // Clamp spawn inside world, useful if Tiled object coordinates are near edges.
        candidate.x = clamp(candidate.x, PLAYER.radius, WORLD.w - PLAYER.radius);
        candidate.y = clamp(candidate.y, PLAYER.radius, WORLD.h - PLAYER.radius);

        if (!isWallAt(candidate.x, candidate.y)) {
            return candidate;
        }

        console.warn("Spawn candidate was inside wall:", candidate);
    }

    // If the map has a spawn but it is inside a wall, use the first spawn anyway.
    // Better than randomly teleporting the player into Nebraska.
    const obj = spawnObjects[0];

    return {
        x: clamp(obj.offsetX, PLAYER.radius, WORLD.w - PLAYER.radius),
        y: clamp(obj.offsetY, PLAYER.radius, WORLD.h - PLAYER.radius)
    };
}

function loadMap(filename) {
    const fp = path.join(__dirname, filename);
    const raw = fs.readFileSync(fp, "utf8");
    const map = JSON.parse(raw);

    // Update world size FIRST.
    if (map.width && map.height && map.tilewidth && map.tileheight) {
        WORLD.w = map.width * map.tilewidth;
        WORLD.h = map.height * map.tileheight;
        console.log("World size set to", WORLD.w, WORLD.h);
    }

    // Then parse spawn objects.
    spawnObjects.length = 0;
    spawnObjects.push(...parseSpawnObjects(map));
    console.log("Loaded player spawns:", spawnObjects);

    // Extract wall layer.
    wallTiles = null;
    if (map.layers) {
        let firstTileLayer = null;

        for (const layer of map.layers) {
            if (layer.type === "tilelayer" && layer.data) {
                if (!firstTileLayer) firstTileLayer = layer;

                if (layer.name && layer.name.toLowerCase().includes("wall")) {
                    firstTileLayer = layer;
                    break;
                }
            }
        }

        if (firstTileLayer) {
            wallTiles = {
                width: firstTileLayer.width || map.width,
                height: firstTileLayer.height || map.height,
                tilewidth: map.tilewidth,
                tileheight: map.tileheight,
                data: firstTileLayer.data.slice()
            };
        }
    }

    return map;
}

function isWallAt(x, y) {
    if (!wallTiles) return false;
    const tx = Math.floor(x / wallTiles.tilewidth);
    const ty = Math.floor(y / wallTiles.tileheight);
    if (tx < 0 || ty < 0 || tx >= wallTiles.width || ty >= wallTiles.height) return false;
    const idx = ty * wallTiles.width + tx;
    return wallTiles.data[idx] > 0;
}

function parseMobSpawnZones(map) {
    const zones = [];
    if (!map.layers) return zones;
    for (const layer of map.layers) {
        if (layer.type !== "objectgroup") continue;
        for (const obj of layer.objects || []) {
            let mobSpawnsStr = null;
            let rarityVal = null;
            let maxMobsVal = null;
            if (obj.properties) {
                for (const prop of obj.properties) {
                    if (prop.name === "mob_spawns" || prop.name === "spawns") mobSpawnsStr = prop.value;
                    if (prop.name === "rarity") rarityVal = prop.value;
                    if (prop.name === "max_mobs") maxMobsVal = prop.value;
                }
            }
            if (!mobSpawnsStr) continue;
            const weights = [];
            for (const entry of mobSpawnsStr.split(";")) {
                if (!entry.trim()) continue;
                const [id, w] = entry.split(",");
                weights.push({ id, weight: parseFloat(w) });
            }
            const rarity = parseFloat(rarityVal) || 0;
            const maxMobs = maxMobsVal ? parseInt(maxMobsVal, 10) : 25;
            zones.push({
                polygon: (obj.polygon || []).map(p => ({ x: p.x, y: p.y })),
                offsetX: obj.x || 0,
                offsetY: obj.y || 0,
                weights,
                rarity,
                maxMobs
            });
        }
    }
    return zones;
}

function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        const intersect = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function randomPointInPolygon(poly, offsetX = 0, offsetY = 0) {
    if (poly.length === 0) return { x: offsetX, y: offsetY };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    minX += offsetX; minY += offsetY; maxX += offsetX; maxY += offsetY;
    for (let tries = 0; tries < 100; tries++) {
        const x = randf(minX, maxX);
        const y = randf(minY, maxY);
        if (pointInPolygon(x - offsetX, y - offsetY, poly)) return { x, y };
    }
    return { x: poly[0].x + offsetX, y: poly[0].y + offsetY };
}

function chooseMobType(zone) {
    const total = zone.weights.reduce((s, w) => s + w.weight, 0);
    let r = randf(0, total);
    for (const w of zone.weights) {
        if (r < w.weight) return MobTypes[w.id] || pick(MobTypeList);
        r -= w.weight;
    }
    return pick(MobTypeList);
}

// load the default map (hardcoded path for now)
try {
    currentMapData = loadMap("maps/game.tmj");
    const zones = parseMobSpawnZones(currentMapData);
    mobSpawnZones.push(...zones);
    console.log("Loaded map with", zones.length, "spawn zones");
    console.log("Loaded zone mob caps:", mobSpawnZones.map(z => z.maxMobs || 0));
    const totalZoneCaps = mobSpawnZones.reduce((sum, zone) => sum + Math.max(0, zone.maxMobs || 0), 0);
    MAX_MOBS = Math.max(100, totalZoneCaps + 200);
    console.log("Global emergency mob ceiling set to", MAX_MOBS);
} catch (e) {
    console.error("Failed to load map:", e);
}

// -------------------- Utilities --------------------
function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
}
function randf(a, b) {
    return a + Math.random() * (b - a);
}
function randi(a, bInclusive) {
    return Math.floor(randf(a, bInclusive + 1));
}
function dist2(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}
function pick(arr) {
    return arr[randi(0, arr.length - 1)];
}

function pickWeighted(arr, weightKey) {
    if (arr.length === 0) return null;
    if (arr.length === 1) return arr[0];

    const totalWeight = arr.reduce((sum, item) => sum + (item[weightKey] || 1), 0);
    if (totalWeight <= 0) return arr[0];

    let random = Math.random() * totalWeight;
    for (const item of arr) {
        random -= (item[weightKey] || 1);
        if (random <= 0) return item;
    }
    return arr[arr.length - 1];
}

let nextPlayerId = 1;
let nextMobId = 1;
let nextPickupId = 1;

function killPetalSummon(petal) {
    if (!petal || petal.summonMobId == null) return;

    const summon = mobById.get(petal.summonMobId);

    if (summon && summon.hp > 0) {
        summon.hp = 0;
    }

    petal.summonMobId = null;
}

// -------------------- Game Objects --------------------
class Petal {
    constructor(typeId, rarity = 0) {
        this.hitCd = 0;
        this.setType(typeId, rarity);
    }

    setType(typeId, rarity = this.rarity ?? 0) {
        const t = PetalTypes[typeId];
        if (!t) return;

        killPetalSummon(this);
        this.typeId = typeId;
        this.rarity = rarity;

        const scale = petalStatScale(this.rarity);

        this.dmg = (t.dmg ?? 0) * scale;
        this.maxHp = (t.maxHp ?? 1) * scale;
        this.hp = this.maxHp;

        this.multiHp = [];
        this.multiHitCd = [];
        this.multiDamageCd = [];
        this.multiReloadLeft = [];
        syncPetalMultiState(this);

        this.reloadTime = t.reload;
        this.reloadLeft = 0;

        this.dropped = false;
        this.dropX = 0;
        this.dropY = 0;

        // rose-only
        this.healAmount = (t.heal ?? 0) * scale;
        this.healCooldown = t.healCooldown ?? 0;
        this.healLeft = this.healCooldown;
    }

    isAlive() {
        if (this.disabledByStack) return false;

        syncPetalMultiState(this);

        for (let i = 0; i < this.multiHp.length; i++) {
            if ((this.multiHp[i] ?? 0) > 0) return true;
        }

        return false;
    }

    forceReload() {
        this.hp = 0;
        this.reloadLeft = this.reloadTime;
        this.hitCd = 0;
        this.healLeft = this.healCooldown;

        syncPetalMultiState(this);

        for (let i = 0; i < this.multiHp.length; i++) {
            this.multiHp[i] = 0;
            this.multiHitCd[i] = 0;
            this.multiDamageCd[i] = 0;
            this.multiReloadLeft[i] = this.reloadTime;
        }

        this.dropped = false;
        this.dropX = 0;
        this.dropY = 0;
    }

    forceReloadAndKillSummon() {
        killPetalSummon(this);
        this.forceReload();
    }

    update(dt, ownerPlayer) {
        if (this.hitCd > 0) this.hitCd = Math.max(0, this.hitCd - dt);

        syncPetalMultiState(this);

        let anyAlive = false;
        let anyReloading = false;
        let soonestReload = Infinity;

        for (let i = 0; i < this.multiHp.length; i++) {
            if (this.multiHitCd[i] > 0) {
                this.multiHitCd[i] = Math.max(0, this.multiHitCd[i] - dt);
            }

            if (this.multiDamageCd[i] > 0) {
                this.multiDamageCd[i] = Math.max(0, this.multiDamageCd[i] - dt);
            }

            if ((this.multiHp[i] ?? 0) > 0) {
                anyAlive = true;
                continue;
            }

            this.multiHp[i] = 0;

            if (this.multiReloadLeft[i] <= 0) {
                this.multiReloadLeft[i] = this.reloadTime;
            }

            this.multiReloadLeft[i] = Math.max(0, this.multiReloadLeft[i] - dt);
            anyReloading = true;
            soonestReload = Math.min(soonestReload, this.multiReloadLeft[i]);

            if (this.multiReloadLeft[i] <= 0) {
                this.multiHp[i] = this.maxHp;
                this.multiHitCd[i] = 0;
                this.multiDamageCd[i] = 0;
                this.multiReloadLeft[i] = 0;
                anyAlive = true;
            }
        }

        // Compatibility fields for UI and old checks.
        this.hp = this.multiHp.reduce((sum, hp) => sum + Math.max(0, hp || 0), 0);
        this.reloadLeft = anyReloading ? soonestReload : 0;

        if (this.typeId === "rose" && anyAlive) {
            this.healLeft -= dt;

            if (this.healLeft <= 0) {
                ownerPlayer.hp = clamp(ownerPlayer.hp + this.healAmount, 0, ownerPlayer.maxHp);

                // In second-doc spirit: consume one petal body, not the entire slot.
                for (let i = 0; i < this.multiHp.length; i++) {
                    if ((this.multiHp[i] ?? 0) > 0) {
                        this.multiHp[i] = 0;
                        this.multiReloadLeft[i] = this.reloadTime;
                        break;
                    }
                }

                this.healLeft = this.healCooldown;
            }
        }
    }
}

function playerHasAlivePetalType(player, typeId) {
    if (!player || !player.petals) return false;

    for (const petal of player.petals) {
        if (!petal) continue;
        if (petal.typeId !== typeId) continue;
        if (petal.isAlive()) return true;
    }

    return false;
}

function getPlayerPetalAttractionBonus(player) {
    if (!player || !player.petals) return 0;

    let bonus = 0;

    for (const petal of player.petals) {
        if (!petal || !petal.isAlive()) continue;

        const type = PetalTypes[petal.typeId];
        bonus += (type?.petalAttractBonus ?? 0) * (petal.rarity + 1);
    }

    return bonus;
}

function getPlayerAggroRangeMultiplier(player) {
    // Poo only works while the poo petal is alive.
    // When it dies/reloads, this automatically returns normal range.
    if (playerHasAlivePetalType(player, "poo")) {
        return 0.10;
    }

    return 1.0;
}

class PlayerState {
    constructor(id) {
        this.id = id;

        const sp = getRandomSpawnPoint();
        this.x = sp.x;
        this.y = sp.y;
        this.vx = 0;
        this.vy = 0;

        this.faction = FACTION.PLAYER;

        this.maxHp = PLAYER.maxHp;
        this.hp = PLAYER.maxHp;

        this.angleBase = randf(0, Math.PI * 2);

        this.input = {
            up: false,
            down: false,
            left: false,
            right: false,
            extend: false,
            retract: false
        };
        this.godMode = false;

        // initial loadout random for now
        this.petals = Array.from({ length: PETAL.count }, () => new Petal("basic", 0));
        this.secondaryPetals = Array.from({ length: PETAL.count }, () => new Petal("basic", 0));

        // inventory stores TYPE IDs (strings)
        this.inv = [];

        this.petalRadius = PETAL_EXTEND.baseRadius;
        this.petalRadiusTarget = PETAL_EXTEND.baseRadius;

        this.time = 0;

        this.petalWobble = Array.from({ length: PETAL.count }, () => ({
            ax: randf(PETAL_WOBBLE.ampMin, PETAL_WOBBLE.ampMax),
            ay: randf(PETAL_WOBBLE.ampMin, PETAL_WOBBLE.ampMax),
            ax2: randf(PETAL_WOBBLE.amp2Min, PETAL_WOBBLE.amp2Max),
            ay2: randf(PETAL_WOBBLE.amp2Min, PETAL_WOBBLE.amp2Max),

            fx: randf(PETAL_WOBBLE.freqMin, PETAL_WOBBLE.freqMax) * Math.PI * 2,
            fy: randf(PETAL_WOBBLE.freqMin, PETAL_WOBBLE.freqMax) * Math.PI * 2,
            fx2: randf(PETAL_WOBBLE.freq2Min, PETAL_WOBBLE.freq2Max) * Math.PI * 2,
            fy2: randf(PETAL_WOBBLE.freq2Min, PETAL_WOBBLE.freq2Max) * Math.PI * 2,

            phx: randf(0, Math.PI * 2),
            phy: randf(0, Math.PI * 2),
            phx2: randf(0, Math.PI * 2),
            phy2: randf(0, Math.PI * 2)
        }));

        this.petalSim = Array.from({ length: PETAL.count }, () => ({ x: 0, y: 0, vx: 0, vy: 0 }));
        this.snapPetalsToTargets();
    }

    update(dt) {
        const ix = (this.input.right ? 1 : 0) - (this.input.left ? 1 : 0);
        const iy = (this.input.down ? 1 : 0) - (this.input.up ? 1 : 0);

        if (ix === 0 && iy === 0) {
            this.vx = 0;
            this.vy = 0;
        } else {
            const invLen = 1 / (Math.hypot(ix, iy) || 1);
            const speed = this.godMode ? PLAYER.speed * 10 : PLAYER.speed;
            this.vx = ix * invLen * speed;
            this.vy = iy * invLen * speed;
        }

        // attempt move with wall collision
        const tryX = clamp(this.x + this.vx * dt, PLAYER.radius, WORLD.w - PLAYER.radius);
        if (this.godMode || !isWallAt(tryX, this.y)) {
            this.x = tryX;
        }
        const tryY = clamp(this.y + this.vy * dt, PLAYER.radius, WORLD.h - PLAYER.radius);
        if (this.godMode || !isWallAt(this.x, tryY)) {
            this.y = tryY;
        }

        const yinYangCount = getPetalTypeCount(this, "yinYang");
        const rotationDir = (yinYangCount % 2 === 1) ? -1 : 1;

        this.angleBase += PETAL.orbitSpeed * rotationDir * dt;

        for (let i = 0; i < this.petals.length; i++) {
            const p = this.petals[i];
            if (!p) continue;

            if (isPetalSlotStackDisabled(this, i)) {
                p.disabledByStack = true;
                continue;
            }

            p.disabledByStack = false;
            p.update(dt, this);
        }

        if (this.input.retract) {
            this.petalRadiusTarget = PETAL_EXTEND.retractedRadius;
        } else if (this.input.extend) {
            this.petalRadiusTarget = PETAL_EXTEND.extendedRadius;
        } else {
            this.petalRadiusTarget = PETAL_EXTEND.baseRadius;
        }
        const k = 1 - Math.exp(-PETAL_EXTEND.extendSpeed * dt);
        this.petalRadius += (this.petalRadiusTarget - this.petalRadius) * k;

        this.time += dt;
        this._updatePetalSim(dt);
    }

    _updatePetalSim(dt) {
        for (let i = 0; i < PETAL.count; i++) {
            const petal = this.petals[i];

            if (petal && isPetalSlotStackDisabled(this, i)) {
                petal.disabledByStack = true;

                const s = this.petalSim[i];
                s.x = this.x;
                s.y = this.y;
                s.vx = 0;
                s.vy = 0;

                continue;
            }

            if (petal?.dropped) {
                const s = this.petalSim[i];

                s.x = petal.dropX;
                s.y = petal.dropY;
                s.vx = 0;
                s.vy = 0;

                continue;
            }

            const base = this.getPetalTargetWorldPos(i);
            const w = this.petalWobble[i];

            const wobX =
                Math.sin(this.time * w.fx + w.phx) * w.ax +
                Math.sin(this.time * w.fx2 + w.phx2) * w.ax2;

            const wobY =
                Math.cos(this.time * w.fy + w.phy) * w.ay +
                Math.cos(this.time * w.fy2 + w.phy2) * w.ay2;

            const tx = base.x + wobX;
            const ty = base.y + wobY;

            const s = this.petalSim[i];

            const ax = (tx - s.x) * PETAL_FOLLOW.stiffness - s.vx * PETAL_FOLLOW.damping;
            const ay = (ty - s.y) * PETAL_FOLLOW.stiffness - s.vy * PETAL_FOLLOW.damping;

            s.vx += ax * dt;
            s.vy += ay * dt;

            s.x += s.vx * dt;
            s.y += s.vy * dt;
        }
    }

    getPetalTargetWorldPos(i) {
        const { layout, total } = getPetalOrbitLayout(this);
        const info = layout[i];

        const virtualIndex = info ? info.start : i;
        const a = getVirtualPetalAngle(this, virtualIndex, total);

        let tx = this.x + Math.cos(a) * this.petalRadius;
        let ty = this.y + Math.sin(a) * this.petalRadius;
        let bestD2 = Infinity;

        // slight attraction toward nearby mobs
        const baseAttractStrength = 0.05;
        const lentilBonus = getPlayerPetalAttractionBonus(this);
        const attractStrength = baseAttractStrength + lentilBonus;
        let best = null;

        for (const mob of mobsArr) {
            if (!mob || mob.hp <= 0) continue;

            const mobRangeBonus = mob.radius * (1.8 + lentilBonus * 10);
            const attractRange = 95 + mobRangeBonus;

            const dx = mob.x - tx;
            const dy = mob.y - ty;
            const d2 = dx * dx + dy * dy;

            if (d2 < attractRange * attractRange && d2 < bestD2) {
                bestD2 = d2;
                best = mob;
            }
        }

        if (best) {
            tx += (best.x - tx) * attractStrength;
            ty += (best.y - ty) * attractStrength;
        }

        return { x: tx, y: ty, angle: a };
    }

    getPetalWorldPos(i) {
        return this.petalSim[i];
    }

    snapPetalsToTargets() {
        for (let i = 0; i < PETAL.count; i++) {
            const t = this.getPetalTargetWorldPos(i);
            const s = this.petalSim[i];
            s.x = t.x;
            s.y = t.y;
            s.vx = 0;
            s.vy = 0;
        }
    }

    addToInventory(typeId, rarity = 0) {
        const type = PetalTypes[typeId];
        if (!type) return false;

        this.inv.push({
            ...type,

            // Keep these explicit so nothing weird overrides them.
            typeId,
            id: type.id || typeId,
            label: type.label || typeId,
            rarity: clampPetalRarity(rarity)
        });

        return true;
    }

    countInventoryPetals(typeId, rarity) {
        rarity = clampPetalRarity(rarity);

        let count = 0;

        for (const item of this.inv) {
            if (!item) continue;
            if (item.typeId !== typeId) continue;
            if (clampPetalRarity(item.rarity ?? 0) !== rarity) continue;

            count++;
        }

        return count;
    }

    removeInventoryPetals(typeId, rarity, amount) {
        rarity = clampPetalRarity(rarity);
        amount = Math.max(0, amount | 0);

        if (amount <= 0) return [];

        const removed = [];

        // Remove from the end so splicing does not wreck earlier indices.
        for (let i = this.inv.length - 1; i >= 0 && removed.length < amount; i--) {
            const item = this.inv[i];
            if (!item) continue;
            if (item.typeId !== typeId) continue;
            if (clampPetalRarity(item.rarity ?? 0) !== rarity) continue;

            removed.push(this.inv.splice(i, 1)[0]);
        }

        return removed;
    }

    craftPetal(typeId, rarity) {
        typeId = String(typeId || "");
        rarity = clampPetalRarity(rarity);

        if (!PetalTypes[typeId]) {
            return {
                ok: false,
                reason: "bad_type",
                message: "That petal type does not exist."
            };
        }

        if (rarity >= PETAL_RARITY.max) {
            return {
                ok: false,
                reason: "max_rarity",
                message: "That petal is already max rarity."
            };
        }

        const have = this.countInventoryPetals(typeId, rarity);

        if (have < CRAFTING.cost) {
            return {
                ok: false,
                reason: "not_enough",
                message: `Need ${CRAFTING.cost} of that exact petal and rarity.`
            };
        }

        const targetRarity = clampPetalRarity(rarity + 1);
        const chance = getCraftSuccessChance(targetRarity);

        // The sacrifice. Five petals enter, maybe one petal leaves.
        this.removeInventoryPetals(typeId, rarity, CRAFTING.cost);

        const success = Math.random() < chance;

        if (success) {
            this.addToInventory(typeId, targetRarity);
        }

        return {
            ok: true,
            success,
            typeId,
            rarity,
            targetRarity,
            chance,
            message: success
                ? `Craft succeeded: ${typeId} R${rarity} → R${targetRarity}`
                : `Craft failed: lost ${CRAFTING.cost} ${typeId} R${rarity}`
        };
    }

    craftAllPetals(typeId, rarity) {
        typeId = String(typeId || "");
        rarity = clampPetalRarity(rarity);

        const results = [];

        // Keep crafting while you still have enough.
        // Cap prevents cursed infinite loops if someone mutates inventory mid-loop somehow.
        for (let guard = 0; guard < 999; guard++) {
            if (this.countInventoryPetals(typeId, rarity) < CRAFTING.cost) break;

            const result = this.craftPetal(typeId, rarity);
            results.push(result);

            if (!result.ok) break;
        }

        const attempts = results.filter(r => r.ok).length;
        const successes = results.filter(r => r.ok && r.success).length;
        const failures = results.filter(r => r.ok && !r.success).length;

        return {
            ok: attempts > 0,
            typeId,
            rarity,
            attempts,
            successes,
            failures,
            message: attempts > 0
                ? `Crafted all: ${attempts} attempts, ${successes} succeeded, ${failures} failed.`
                : `Not enough ${typeId} R${rarity} to craft.`
        };
    }

    swapPetalsAndReload(a, b) {
        const n = this.petals.length;
        if (a < 0 || b < 0 || a >= n || b >= n || a === b) return false;

        const pa = this.petals[a];
        const pb = this.petals[b];
        this.petals[a] = pb;
        this.petals[b] = pa;

        this.petals[a].forceReloadAndKillSummon();
        this.petals[b].forceReloadAndKillSummon();
        return true;
    }

    swapPrimaryWithSecondarySlot(i) {
        const n = this.petals.length;
        if (i < 0 || i >= n) return false;
        if (!this.secondaryPetals || !this.secondaryPetals[i]) return false;

        const oldPrimary = this.petals[i];
        this.petals[i] = this.secondaryPetals[i];
        this.secondaryPetals[i] = oldPrimary;

        // Reload only the newly equipped primary.
        this.petals[i].forceReloadAndKillSummon();

        return true;
    }

    swapAllPrimaryAndSecondary() {
        const n = this.petals.length;
        if (!Array.isArray(this.secondaryPetals) || this.secondaryPetals.length !== n) {
            this.secondaryPetals = Array.from({ length: n }, () => new Petal("basic", 0));
        }

        for (let i = 0; i < n; i++) {
            const oldPrimary = this.petals[i];
            this.petals[i] = this.secondaryPetals[i];
            this.secondaryPetals[i] = oldPrimary;

            // Reload newly equipped petals so swapping isn't free instant cheese.
            this.petals[i].forceReloadAndKillSummon();
        }

        return true;
    }

    dropDroppablePetals() {
        for (let i = 0; i < this.petals.length; i++) {
            const petal = this.petals[i];
            if (!petal || !petal.isAlive()) continue;
            if (isPetalSlotStackDisabled(this, i)) continue;

            const type = PetalTypes[petal.typeId];
            if (!type?.isDroppable) continue;
            if (petal.dropped) continue;

            const pos = this.petalSim[i];

            petal.dropped = true;
            petal.dropX = pos.x;
            petal.dropY = pos.y;

            // Freeze it on the ground.
            pos.vx = 0;
            pos.vy = 0;
        }
    }

    swapInvWithSlot(invIndex, slotIndex) {
        const invN = this.inv.length;
        const slotN = this.petals.length;

        if (invIndex < 0 || invIndex >= invN) return false;
        if (slotIndex < 0 || slotIndex >= slotN) return false;

        const invItem = this.inv[invIndex];
        const slotPetal = this.petals[slotIndex];

        this.inv[invIndex] = {
            typeId: slotPetal.typeId,
            rarity: slotPetal.rarity
        };

        killPetalSummon(this.petals[slotIndex]);

        this.petals[slotIndex].setType(invItem.typeId, invItem.rarity);
        this.petals[slotIndex].forceReload();
        return true;
    }

    swapInvSlots(a, b) {
        const n = this.inv.length;
        if (a < 0 || b < 0 || a >= n || b >= n || a === b) return false;
        const t = this.inv[a];
        this.inv[a] = this.inv[b];
        this.inv[b] = t;
        return true;
    }
}
const AggroTypes = Object.create(null);
const IdleTypes = Object.create(null);

function resolveAggroFn(name) {
    return AggroTypes[name] || AggroTypes.chase;
}

function resolveIdleFn(name) {
    return IdleTypes[name] || IdleTypes.wander;
}

function resolveCircleOverlap(a, b, ra, rb) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const rsum = ra + rb;
    const d2 = dx * dx + dy * dy;

    if (d2 <= 0 || d2 >= rsum * rsum) return false;

    const d = Math.sqrt(d2);
    const nx = dx / d;
    const ny = dy / d;

    const overlap = rsum - d;

    // default: split correction
    let pushA = overlap * 0.5;
    let pushB = overlap * 0.5;

    // attempt split push
    const ax0 = a.x, ay0 = a.y;
    const bx0 = b.x, by0 = b.y;

    moveWithWalls(a, nx * pushA, ny * pushA, ra);
    moveWithWalls(b, -nx * pushB, -ny * pushB, rb);

    // if one got blocked by a wall tile, dump more correction into the other
    const aMoved = (a.x !== ax0) || (a.y !== ay0);
    const bMoved = (b.x !== bx0) || (b.y !== by0);

    if (aMoved && bMoved) return true;

    // revert and retry one-sided
    a.x = ax0; a.y = ay0;
    b.x = bx0; b.y = by0;

    if (!aMoved && bMoved) {
        moveWithWalls(b, -nx * overlap, -ny * overlap, rb);
        return true;
    }
    if (aMoved && !bMoved) {
        moveWithWalls(a, nx * overlap, ny * overlap, ra);
        return true;
    }

    // both blocked: do nothing (better than phasing into walls)
    return false;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function wrapAngle(a) {
    a = (a + Math.PI) % (Math.PI * 2);
    if (a < 0) a += Math.PI * 2;
    return a - Math.PI;
}

function findNearestGarbageOfRarity(x, y, rarity, range, excludeId = null) {
    const range2 = range * range;
    let best = null;
    let bestD2 = range2;

    for (const m of mobsArr) {
        if (!m || m.hp <= 0) continue;

        const d2 = dist2(x, y, m.x, m.y);

        if (m.type === "garbage") {
            console.log("[garbage check]", {
                id: m.id,
                rarity: m.rarity,
                wantedRarity: rarity,
                d2,
                range2,
                x: m.x,
                y: m.y
            });
        }

        if (m.id === excludeId) continue;
        if (m.type !== "garbage") continue;
        if ((m.rarity | 0) !== (rarity | 0)) continue;

        if (d2 < bestD2) {
            bestD2 = d2;
            best = m;
        }
    }

    console.log("[garbage result]", best ? {
        id: best.id,
        rarity: best.rarity,
        x: best.x,
        y: best.y
    } : null);

    return best;
}

function turnTowardAngle(current, desired, maxStep) {
    let diff = desired - current;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    return current + clamp(diff, -maxStep, maxStep);
}

function expLerp(current, target, sharpness, dt) {
    const k = 1 - Math.exp(-sharpness * dt);
    return current + (target - current) * k;
}

function setMobDesiredMove(mob, angle, speed) {
    if (!Number.isFinite(angle)) angle = mob.angle || 0;
    if (!Number.isFinite(speed)) speed = 0;

    mob.desiredAngle = angle;
    mob.desiredSpeed = Math.max(0, speed);
    mob.desiredVx = Math.cos(angle) * mob.desiredSpeed;
    mob.desiredVy = Math.sin(angle) * mob.desiredSpeed;
}

function stopMobDesiredMove(mob) {
    mob.desiredAngle = mob.angle || 0;
    mob.desiredSpeed = 0;
    mob.desiredVx = 0;
    mob.desiredVy = 0;
}

function applyMobSmoothMovement(mob, dt) {
    const turnSharpness = mob.aiTurnSharpness ?? 14;
    const accelSharpness = mob.aiAccelSharpness ?? 10;

    const desiredAngle = Number.isFinite(mob.desiredAngle)
        ? mob.desiredAngle
        : mob.angle;

    mob.angle = turnTowardAngle(
        mob.angle || 0,
        desiredAngle,
        turnSharpness * dt
    );

    const tx = Number.isFinite(mob.desiredVx) ? mob.desiredVx : 0;
    const ty = Number.isFinite(mob.desiredVy) ? mob.desiredVy : 0;

    mob.vx = expLerp(mob.vx || 0, tx, accelSharpness, dt);
    mob.vy = expLerp(mob.vy || 0, ty, accelSharpness, dt);

    // Kill tiny drift so idle mobs do not slowly moonwalk into legal trouble.
    if (Math.abs(mob.vx) < 0.01) mob.vx = 0;
    if (Math.abs(mob.vy) < 0.01) mob.vy = 0;
}

/**
 * Returns the aim angle to intercept a moving target with a constant-speed projectile.
 * If no valid intercept, falls back to direct aim.
 */
function leadAngle(
    sx, sy,
    tx, ty,
    tvx, tvy,
    projSpeed,
    maxLeadT = 1e200
) {
    const rx = tx - sx;
    const ry = ty - sy;

    // If projSpeed is 0 or nonsense, avoid NaNs.
    projSpeed = Math.max(1e-6, projSpeed);

    const a = (tvx * tvx + tvy * tvy) - projSpeed * projSpeed;
    const b = 2 * (rx * tvx + ry * tvy);
    const c = rx * rx + ry * ry;

    let t = NaN;

    if (Math.abs(a) < 1e-6) {
        // linear-ish
        if (Math.abs(b) > 1e-6) t = -c / b;
    } else {
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
            const s = Math.sqrt(disc);
            const t1 = (-b - s) / (2 * a);
            const t2 = (-b + s) / (2 * a);

            // smallest positive root
            t = Math.min(t1, t2);
            if (t <= 0) t = Math.max(t1, t2);
        }
    }

    // --------- "ALWAYS FUTURE" fallback ----------
    // If intercept time is invalid, negative, or tiny, we still aim ahead.
    // Use a "best-effort" lookahead based on distance / projectile speed.
    const dist = Math.hypot(rx, ry);

    // Base future time estimate (how long the projectile would take to reach current target position)
    let tfallback = dist / projSpeed;

    // Keep it sane: don't look 30 years ahead, but don't allow t=0 either.
    // minLook makes it ALWAYS future even at point-blank range.
    const minLook = 0.08;                 // seconds (tweak 0.05–0.15)
    const maxSane = Math.min(maxLeadT, 3); // cap future vision to something dodgeable

    tfallback = clamp(tfallback, minLook, maxSane);

    if (!Number.isFinite(t) || t < minLook) t = tfallback;
    else t = clamp(t, minLook, maxSane);

    const ax = tx + tvx * t;
    const ay = ty + tvy * t;

    return Math.atan2(ay - sy, ax - sx);
}

function shouldSkipMobMobCollision(a, b) {
    if (!a || !b) return false;

    // silverfish carrying this garbage
    if (
        a.type === "silverfish" &&
        a.carryingGarbage &&
        a.grabbedGarbageId != null &&
        b.id === a.grabbedGarbageId
    ) {
        return true;
    }

    // same check, reversed pair order
    if (
        b.type === "silverfish" &&
        b.carryingGarbage &&
        b.grabbedGarbageId != null &&
        a.id === b.grabbedGarbageId
    ) {
        return true;
    }

    return false;
}

// ---- Aggro Types ----
AggroTypes.none = (mob, dt, target) => {
    stopMobDesiredMove(mob);
};

AggroTypes.chase = (mob, dt, target) => {
    const dx = target.x - mob.x;
    const dy = target.y - mob.y;

    const angle = Math.atan2(dy, dx);
    setMobDesiredMove(mob, angle, mob.speed);
};

AggroTypes.chaseRapidClose = (mob, dt, target) => {
    const dx = target.x - mob.x;
    const dy = target.y - mob.y;
    const dist = Math.hypot(dx, dy);

    const closeThreshold = 100;
    const baseSpeed = mob.baseSpeed || mob.speed;

    const speed = dist < closeThreshold
        ? baseSpeed * 3
        : baseSpeed;

    const angle = Math.atan2(dy, dx);
    setMobDesiredMove(mob, angle, speed);
};

AggroTypes.chaseSine = (mob, dt, target) => {
    const dx = target.x - mob.x;
    const dy = target.y - mob.y;

    const baseAngle = Math.atan2(dy, dx);

    mob._waveT = (mob._waveT ?? 0) + dt;

    const freqHz = mob.waveFreq ?? 1.8;
    const ampRad = mob.waveAmp ?? 0.35;

    const wobble = Math.sin(mob._waveT * freqHz * Math.PI * 2) * ampRad;

    setMobDesiredMove(mob, baseAngle + wobble, mob.speed);
};

AggroTypes.shootMissile = (mob, dt, target) => {
    stopMobDesiredMove(mob);

    const dx = target.x - mob.x;
    const dy = target.y - mob.y;
    const aim = Math.atan2(dy, dx);

    mob.desiredAngle = aim;

    if (mob.shootCd <= 0) {
        spawnMissile(mob, target);

        // faster fire at higher rarity (tweak to taste)
        mob.shootCd = clamp(1.35 / (1 + 0.06 * mob.rarity), 0.55, 1.35);
    }
};

AggroTypes.shootMissilePredictive = (mob, dt, target) => {
    mob.vx = 0;
    mob.vy = 0;

    const missileType = MobObjectTypes.hornetMissile;
    const projSpeed = missileType?.speed ?? 160;

    // distance-based lead horizon:
    // close range -> small lead time, long range -> more lead time (capped)
    const dx = target.x - mob.x;
    const dy = target.y - mob.y;
    const dist = Math.hypot(dx, dy);

    // "very predictive" without becoming psychic:
    // at 300px: ~1.6s, at 700px: ~2.8s, capped at 3.2s
    const maxLeadT = clamp(0.9 + dist * 0.0023, 0.6, 3.2);

    // use last-known velocities (fine), but fall back to 0 safely
    const tvx = target.vx || 0;
    const tvy = target.vy || 0;

    const aim = leadAngle(
        mob.x, mob.y,
        target.x, target.y,
        tvx, tvy,
        projSpeed,
        maxLeadT
    );

    stopMobDesiredMove(mob);
    mob.desiredAngle = aim;

    if (mob.shootCd <= 0) {
        // fire a straight shot (no homing). It will keep this initial angle.
        spawnMissile(mob, target.id);

        mob.shootCd = clamp(1.35 / (1 + 0.06 * mob.rarity), 0.55, 1.35);
    }
};

AggroTypes.shootMissileChasing = (mob, dt, target) => {
    const missileType = MobObjectTypes.hornetMissile;
    const projSpeed = missileType?.speed ?? 160;

    // distance-based lead horizon:
    // close range -> small lead time, long range -> more lead time (capped)
    const dx = target.x - mob.x;
    const dy = target.y - mob.y;
    const dist = Math.hypot(dx, dy);

    // "very predictive" without becoming psychic:
    // at 300px: ~1.6s, at 700px: ~2.8s, capped at 3.2s
    const maxLeadT = clamp(0.9 + dist * 0.0023, 0.6, 3.2);

    // use last-known velocities (fine), but fall back to 0 safely
    const tvx = target.vx || 0;
    const tvy = target.vy || 0;

    const aim = leadAngle(
        mob.x, mob.y,
        target.x, target.y,
        tvx, tvy,
        projSpeed,
        maxLeadT
    );

    // initialize angle if needed
    mob.angle ??= aim;

    const turnRate = 10;

    let diff = aim - mob.angle;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));

    const maxTurn = turnRate * dt;
    diff = clamp(diff, -maxTurn, maxTurn);

    mob.angle += diff;

    if (mob.shootCd <= 0) {
        // fire a straight shot (no homing). It will keep this initial angle.
        spawnMissile(mob, target.id);

        mob.shootCd = clamp(1.35 / (1 + 0.06 * mob.rarity), 0.55, 1.35);
    }

    const far = 650;   // beyond this: normal speed
    const near = 160;  // within this: max speed
    const t = clamp((far - dist) / (far - near), 0, 1); // 0 far -> 1 near

    const s = t * t * (3 - 2 * t); // smoothstep

    const minMult = 0.6;
    const maxMult = 1 + 0.18 * mob.rarity;

    const desiredSpeed = mob.speed * (minMult + (maxMult - minMult) * s);

    mob.curSpeed ??= mob.speed;
    mob.curSpeed += (desiredSpeed - mob.curSpeed) * clamp(dt * 10, 0, 1);

    mob.vx = Math.cos(mob.angle) * mob.curSpeed;
    mob.vy = Math.sin(mob.angle) * mob.curSpeed;
};

AggroTypes.silverfishScavenge = (mob, dt, target) => {
    mob.baseSpeed ??= mob.speed;
    mob.turnRate ??= 12.0;
    mob.silverfishState ??= "decide"; // decide | fetchGarbage | flee | courageChase
    mob.courageTimer ??= 0;
    mob.carryingGarbage ??= false;
    mob.grabbedGarbageId ??= null;

    const dx = target.x - mob.x;
    const dy = target.y - mob.y;

    // scale detection/grab behavior with actual mob size
    const garbageSearchRange = Math.max(220, mob.radius * 30.0);
    const chaseSearchRange = Math.max(garbageSearchRange, mob.radius + 200);

    // if our carried garbage died somehow, stop pretending
    if (mob.grabbedGarbageId != null) {
        const g = mobById.get(mob.grabbedGarbageId);
        if (!g || g.hp <= 0 || g.type !== "garbage") {
            mob.grabbedGarbageId = null;
            mob.carryingGarbage = false;
        }
    }

    // first aggro decision
    if (mob.silverfishState === "decide") {
        const garbage = findNearestGarbageOfRarity(
            mob.x,
            mob.y,
            mob.rarity,
            garbageSearchRange
        );

        if (garbage) {
            mob.silverfishState = "fetchGarbage";
            mob.grabbedGarbageId = garbage.id;
            mob.carryingGarbage = false;
        } else {
            mob.silverfishState = "flee";
            mob.courageTimer = 10.0;
            mob.grabbedGarbageId = null;
            mob.carryingGarbage = false;
        }
    }

    if (mob.silverfishState === "fetchGarbage") {
        let garbage = mob.grabbedGarbageId != null ? mobById.get(mob.grabbedGarbageId) : null;

        if (
            !garbage ||
            garbage.hp <= 0 ||
            garbage.type !== "garbage" ||
            (garbage.rarity | 0) !== (mob.rarity | 0)
        ) {
            const retry = findNearestGarbageOfRarity(
                mob.x,
                mob.y,
                mob.rarity,
                garbageSearchRange
            );

            if (retry) {
                mob.grabbedGarbageId = retry.id;
                garbage = retry;
            } else {
                mob.silverfishState = "flee";
                mob.courageTimer = 10.0;
                mob.grabbedGarbageId = null;
                mob.carryingGarbage = false;
                return;
            }
        }

        const gx = garbage.x - mob.x;
        const gy = garbage.y - mob.y;
        const gdist = Math.hypot(gx, gy) || 1;
        const desired = Math.atan2(gy, gx);

        mob.angle = turnTowardAngle(mob.angle, desired, mob.turnRate * dt);
        mob.vx = Math.cos(mob.angle) * mob.baseSpeed;
        mob.vy = Math.sin(mob.angle) * mob.baseSpeed;

        // grab range also scales with both bodies
        const grabDist = mob.radius + garbage.radius + Math.max(4, mob.radius * 0.2);
        if (gdist <= grabDist) {
            mob.carryingGarbage = true;
            mob.silverfishState = "courageChase";
        }
        return;
    }

    if (mob.silverfishState === "flee") {
        mob.courageTimer -= dt;

        const awayAngle = Math.atan2(-dy, -dx);
        mob.angle = turnTowardAngle(mob.angle, awayAngle, mob.turnRate * 1.15 * dt);

        const fleeSpeed = mob.baseSpeed * 1.15;
        mob.vx = Math.cos(mob.angle) * fleeSpeed;
        mob.vy = Math.sin(mob.angle) * fleeSpeed;

        // optional: if it notices garbage while fleeing, let it reconsider
        const panicGarbage = findNearestGarbageOfRarity(
            mob.x,
            mob.y,
            mob.rarity,
            chaseSearchRange
        );
        if (panicGarbage) {
            mob.silverfishState = "fetchGarbage";
            mob.grabbedGarbageId = panicGarbage.id;
            mob.carryingGarbage = false;
            return;
        }

        if (mob.courageTimer <= 0) {
            mob.silverfishState = "courageChase";
        }
        return;
    }

    if (mob.silverfishState === "courageChase") {
        const desired = Math.atan2(dy, dx);

        const speedMult = mob.carryingGarbage ? 0.95 : 1.0;
        const turnMult = mob.carryingGarbage ? 0.8 : 1.0;

        mob.angle = turnTowardAngle(mob.angle, desired, mob.turnRate * turnMult * dt);
        mob.vx = Math.cos(mob.angle) * (mob.baseSpeed * speedMult);
        mob.vy = Math.sin(mob.angle) * (mob.baseSpeed * speedMult);
    }
};

IdleTypes.none = (mob, dt) => {
    stopMobDesiredMove(mob);
};

IdleTypes.followOwner = (mob, dt) => {
    const owner = players.get(mob.ownerPlayerId);

    if (!owner || owner.hp <= 0) {
        stopMobDesiredMove(mob);
        return;
    }

    const dx = owner.x - mob.x;
    const dy = owner.y - mob.y;
    const d = Math.hypot(dx, dy);

    const followMin = 70;
    const followMax = 170;

    if (d <= followMin) {
        stopMobDesiredMove(mob);
        return;
    }

    const angle = Math.atan2(dy, dx);

    // Faster if it falls behind, slower if it is just adjusting.
    const speed =
        d > followMax
            ? mob.baseSpeed
            : Math.min(mob.baseSpeed, mob.baseIdleSpeed + 80);

    setMobDesiredMove(mob, angle, speed);
};

IdleTypes.wander = (mob, dt) => {
    mob.wanderT -= dt;

    if (mob.wanderT <= 0) {
        mob.wanderT = randf(mob.wanderTMin, mob.wanderTMax);

        // Do not instantly pick any direction. Ease from current direction.
        const turnAmount = randf(-Math.PI * 0.75, Math.PI * 0.75);
        mob.wanderDir = wrapAngle((mob.wanderDir ?? mob.angle ?? 0) + turnAmount);
    }

    setMobDesiredMove(mob, mob.wanderDir, mob.idleSpeed);
};

IdleTypes.wanderSine = (mob, dt) => {
    mob.wanderT -= dt;

    if (mob.wanderT <= 0) {
        mob.wanderT = randf(mob.wanderTMin, mob.wanderTMax);

        const turnAmount = randf(-Math.PI * 0.65, Math.PI * 0.65);
        mob.wanderDir = wrapAngle((mob.wanderDir ?? mob.angle ?? 0) + turnAmount);
    }

    mob._idleWaveT = (mob._idleWaveT ?? 0) + dt;

    const freqHz = mob.idleWaveFreq ?? 0.75;
    const ampRad = mob.idleWaveAmp ?? 0.22;

    const wobble = Math.sin(mob._idleWaveT * freqHz * Math.PI * 2) * ampRad;
    const angle = mob.wanderDir + wobble;

    setMobDesiredMove(mob, angle, mob.idleSpeed);
};

class MobState {
    constructor(type, rarityParam) {
        let rarity;
        if (typeof rarityParam === "number") {
            rarity = Math.floor(rarityParam);
            rarity = clamp(rarity, 0, sizeScaling.length - 1);
        } else {
            rarity = Math.floor(Math.random() * sizeScaling.length);
        }

        this.rarity = rarity;
        this.id = nextMobId++;

        // centipede linkage fields (null for normal mobs)
        this.chainPrevId = null;
        this.chainNextId = null;
        this.chainGroupId = null;

        this.type = type.id;
        this.label = type.label ?? type.id;

        this.dmg = type.dmg * Math.pow(3, rarity);
        this.maxHp = type.maxHp * hpScaling[rarity];
        this.hp = this.maxHp;
        this.radius = (type.radius ?? MOB.radius) * sizeScaling[rarity];

        if (type.sizeVary) {
            const mult = randf(0.8, 1.2);
            this.radius *= mult;
        }

        this.speed = type.speed ?? 0;
        this.baseSpeed = this.speed;

        this.mass = type.mass ?? 1; // heavier mobs are harder to push

        this.behavior = type.behavior || "neutral";      // passive | neutral | hostile
        this.aggroType = type.aggroType || "chase";      // chase | chaseSine | ...
        this.idleType = type.idleType || "wander";       // wander | wanderSine | ...

        this.aggroRange = (type.aggroRange ?? 0) * Math.pow(1.275, rarity) + this.radius;
        this.leashRange = type.leashRange ?? MOB_UPDATE_RANGE; // drop target if absurdly far
        this.idleSpeed = Math.min(this.speed, 60);
        this.baseIdleSpeed = this.idleSpeed;

        this.slowLeft = 0;
        this.slowAmount = 0;

        this.wanderTMin = type.wanderTMin ?? 0.6;
        this.wanderTMax = type.wanderTMax ?? 1.8;
        this.shootCd = randf(0, 0.6);

        this.lightningCd = randf(0.25, 1.25);

        this.mateCd = randf(3, 8);
        this.mateWarmupLeft = 0;
        this.matePartnerId = null;
        this.isBaby = type.id === "lovebugBaby";

        // resolve functions once (fast + extensible)
        this._aggroFn = resolveAggroFn(this.aggroType);
        this._idleFn = resolveIdleFn(this.idleType);

        this.drops = (type.drops || []).slice();

        this.x = randf(100, WORLD.w - 100);
        this.y = randf(100, WORLD.h - 100);
        if (isWallAt(this.x, this.y)) {
            for (let i = 0; i < 20 && isWallAt(this.x, this.y); i++) {
                this.x = randf(100, WORLD.w - 100);
                this.y = randf(100, WORLD.h - 100);
            }
        }

        this.randoms = Array.from({ length: 30 }, () => randf(0, 1));

        this.vx = 0;
        this.vy = 0;

        this.angle = randf(0, Math.PI * 2);

        this.desiredVx = 0;
        this.desiredVy = 0;
        this.desiredSpeed = 0;
        this.desiredAngle = this.angle;

        // Higher = snappier, lower = floatier.
        this.aiTurnSharpness = type.aiTurnSharpness ?? 14;
        this.aiAccelSharpness = type.aiAccelSharpness ?? 10;

        this.targetPlayerId = null;
        this.targetMobId = null; // new: can chase other mobs (ants vs bees)
        this.attackCd = 0;
        this.hitCd = 0;

        this.wanderT = randf(this.wanderTMin, this.wanderTMax);
        this.wanderDir = randf(0, Math.PI * 2);

        // garbage mobs get their own random faction; other mobs use type's faction
        if (type.id === "garbage") {
            this.faction = nextGarbageFaction++;
        } else {
            this.faction = type.faction ?? FACTION.NEUTRAL;
        }
        this.enemyScanCd = randf(0, 0.35); // desync scanning
        this.spawnFlyCd = randf(0, 1.0); // spawn flies periodically

        if (type.ropeBody) {
            this.bodySegments = [];
            syncRopeBodySegments(this, type);
        } else {
            this.bodySegments = null;
        }
    }

    // Call this if you ever change aggroType/idleType at runtime
    _refreshAIFns() {
        this._aggroFn = resolveAggroFn(this.aggroType);
        this._idleFn = resolveIdleFn(this.idleType);
    }

    _nearestPlayerInEffectiveAggroRange(playersArr) {
        let best = null;
        let bestD2 = Infinity;

        for (const p of playersArr) {
            if (!p || p.hp <= 0 || p.godMode) continue;

            const mult = getPlayerAggroRangeMultiplier(p);
            const range = this.aggroRange * mult;
            const range2 = range * range;

            const dx = p.x - this.x;
            const dy = p.y - this.y;
            const d2 = dx * dx + dy * dy;

            if (d2 <= range2 && d2 < bestD2) {
                best = p;
                bestD2 = d2;
            }
        }

        return best;
    }

    update(dt, playersArr, playersById, factionGrid) {
        // garbage spawns flies periodically
        if (this.type === "garbage") {
            this.spawnFlyCd -= dt;
            if (this.spawnFlyCd <= 0) {
                spawnFlyFromGarbage(this.x, this.y, this.faction, this.rarity);
                this.spawnFlyCd = randf(0.5, 1.5);
            }
        }

        if (this.chainPrevId != null) {
            const prev = mobById.get(this.chainPrevId);
            if (!prev || prev.hp <= 0) {
                this.chainPrevId = null;
                return;
            }

            const desired = segSpacing(prev, this);

            // target point behind prev, but based on prev->seg direction (smooth)
            let dx = this.x - prev.x;
            let dy = this.y - prev.y;
            let d = Math.hypot(dx, dy);

            // if stacked exactly, use prev.angle as a fallback direction
            if (d < 1e-6) {
                dx = Math.cos(prev.angle);
                dy = Math.sin(prev.angle);
                d = 1;
            } else {
                dx /= d;
                dy /= d;
            }

            const targetX = prev.x + dx * desired;
            const targetY = prev.y + dy * desired;

            // smooth toward target
            const followK = 10; // lower = looser/smoother, higher = tighter
            const k = 1 - Math.exp(-followK * dt);

            const moveX = (targetX - this.x) * k;
            const moveY = (targetY - this.y) * k;

            const r = this.radius || MOB.radius;

            const tryX = clamp(this.x + moveX, r, WORLD.w - r);
            if (!isWallAt(tryX, this.y)) this.x = tryX;

            const tryY = clamp(this.y + moveY, r, WORLD.h - r);
            if (!isWallAt(this.x, tryY)) this.y = tryY;

            // face along the chain (toward prev)
            this.angle = Math.atan2(prev.y - this.y, prev.x - this.x);

            return;
        }

        // cooldowns
        if (this.attackCd > 0) this.attackCd = Math.max(0, this.attackCd - dt);
        if (this.hitCd > 0) this.hitCd = Math.max(0, this.hitCd - dt);
        if (this.shootCd > 0) this.shootCd = Math.max(0, this.shootCd - dt);

        // ---------- FACTION TARGETING ----------
        if (this.faction !== FACTION.NEUTRAL && factionGrid) {
            // keep existing mob target if still valid
            if (this.targetMobId != null) {
                const t = mobById.get(this.targetMobId);
                if (!t || t.hp <= 0 || !isHostileFaction(this.faction, t.faction)) {
                    this.targetMobId = null;
                }
            }

            // scan sometimes
            this.enemyScanCd -= dt;
            if (this.targetMobId == null && this.enemyScanCd <= 0) {
                this.enemyScanCd = 0.20 + Math.random() * 0.25;

                const FIGHT_RANGE = 600;
                const enemy = findNearestEnemyInGrid(this, factionGrid, FACTION_CELL, FIGHT_RANGE);
                if (enemy) {
                    this.targetMobId = enemy.id;
                    this.targetPlayerId = null; // ignore players during bug war
                }
            }

            // if we have a mob enemy, ignore players
            if (this.targetMobId != null) {
                this.targetPlayerId = null;
            }
        }

        // ---------- PETAL SUMMON TARGETING ----------
        if (this.isPetalSummon) {
            const owner = playersById.get(this.ownerPlayerId) || null;

            // Owner gone/dead = summon gone. No abandoned beetle economy.
            if (!owner || owner.hp <= 0) {
                this.hp = 0;
                return;
            }

            const hardReturn = summonShouldHardReturnToOwner(this, owner);

            if (hardReturn) {
                // Override EVERYTHING. Even current attacks.
                this.targetMobId = null;
                this.targetPlayerId = null;

                const dx = owner.x - this.x;
                const dy = owner.y - this.y;
                const angle = Math.atan2(dy, dx);

                setMobDesiredMove(this, angle, this.baseSpeed || this.speed || 220);

                // Skip normal targeting this tick.
                this._summonHardReturning = true;
            } else {
                this._summonHardReturning = false;

                const enemy = findNearestEnemyMobForSummon(
                    this,
                    Math.max(this.aggroRange ?? 0, 650)
                );

                if (enemy) {
                    this.targetMobId = enemy.id;
                    this.targetPlayerId = null;
                } else {
                    this.targetMobId = null;
                    this.targetPlayerId = null;
                }
            }
        }

        // ---------- PLAYER TARGETING (ONLY IF NOT FIGHTING A MOB) ----------
        if (this.targetMobId == null && !this.isPetalSummon) {
            if (this.behavior === "passive") {
                this.targetPlayerId = null;
            } else if (this.behavior === "hostile") {
                const best = this._nearestPlayerInEffectiveAggroRange(playersArr);
                this.targetPlayerId = best ? best.id : null;
            } else {
                // neutral: keep target if still valid
                if (this.targetPlayerId != null) {
                    const t = playersById.get(this.targetPlayerId);
                    if (!t || t.godMode) {
                        this.targetPlayerId = null;
                    } else {
                        const d2 = dist2(this.x, this.y, t.x, t.y);
                        if (d2 > this.leashRange * this.leashRange) this.targetPlayerId = null;
                    }
                }
            }
        }

        // ---------- PICK ACTUAL TARGET ----------
        let target = null;
        if (this.targetMobId != null) {
            target = mobById.get(this.targetMobId) || null;
            if (!target || target.hp <= 0) {
                this.targetMobId = null;
                target = null;
            }
        }
        if (!target && this.targetPlayerId != null) {
            target = playersById.get(this.targetPlayerId) || null;
            if (target && target.godMode) target = null;
        }

        const lightningCfg = getMobLightningConfig(this);

        if (lightningCfg && target && target.hp > 0) {
            this.lightningCd -= dt;

            if (this.lightningCd <= 0) {
                fireMobLightning(this, target);
                this.lightningCd = lightningCfg.cooldown * (0.95 + Math.random() * 0.1);
            }
        }

        // Actual contact damage is handled once in tick() by applyEntityDamage().
        // MobState.update() only chooses targets and movement now.

        if (!target && this.type === "silverfish") {
            this.silverfishState = "decide";
            this.courageTimer = 0;
            this.carryingGarbage = false;
            this.grabbedGarbageId = null;
        }

        // ---------- MOVE ----------
        if (!this._summonHardReturning) {
            if (target) this._aggroFn(this, dt, target);
            else this._idleFn(this, dt);
        }

        applyMobSmoothMovement(this, dt);

        // wall movement
        const r = this.radius || MOB.radius;
        const tryX = clamp(this.x + this.vx * dt, r, WORLD.w - r);
        if (!isWallAt(tryX, this.y)) this.x = tryX;

        const tryY = clamp(this.y + this.vy * dt, r, WORLD.h - r);
        if (!isWallAt(this.x, tryY)) this.y = tryY;

        // face velocity
        if (this.vx !== 0 || this.vy !== 0) this.angle = Math.atan2(this.vy, this.vx);

        updateRopeBodySegments(this, dt);

        if (this.type === "silverfish" && this.carryingGarbage && this.grabbedGarbageId != null) {
            const g = mobById.get(this.grabbedGarbageId);
            if (g && g.hp > 0 && g.type === "garbage") {
                const carryDist = this.radius + Math.max(6, g.radius * 0.35);
                g.x = clamp(this.x + Math.cos(this.angle) * carryDist, g.radius, WORLD.w - g.radius);
                g.y = clamp(this.y + Math.sin(this.angle) * carryDist, g.radius, WORLD.h - g.radius);
                g.vx = this.vx;
                g.vy = this.vy;
            }
        }

        if (this.faction === FACTION.ANT && target && this.targetMobId != null) {
            let allies = 0;
            const R = 140; // swarm radius
            const R2 = R * R;

            // cheap-ish: only scan same cell + neighbors
            const scx = toCell(this.x, FACTION_CELL);
            const scy = toCell(this.y, FACTION_CELL);
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const bucket = factionGrid.get(gridKey(scx + dx, scy + dy));
                    if (!bucket) continue;
                    for (const m of bucket) {
                        if (m === this || m.hp <= 0) continue;
                        if (m.faction !== FACTION.ANT) continue;
                        if (dist2(this.x, this.y, m.x, m.y) <= R2) allies++;
                    }
                }
            }

            const bonus = Math.min(0.60, allies * 0.08); // up to +60%
            const dmg = this.dmg * (1 + bonus);

            // when you apply damage:
            // target.hp -= dmg;
        }

        // ---------- DANDELION SPECIAL LOGIC ----------
        if (this.type === "dandelion") {
            const SPORE_COUNT = 10;
            const SPORE_RELEASE_INTERVAL = 0.12;

            // Initialize dandelion state ONCE.
            if (this.dandelionMissiles == null) {
                this.dandelionMissiles = [];
                this.prevHp = this.hp;

                this.dandelionSpawnedMissiles = true;
                this.dandelionReleasing = false;
                this.dandelionReleaseTimer = 0;

                // Spawn the spores once.
                for (let i = 0; i < SPORE_COUNT; i++) {
                    const angle = (i / SPORE_COUNT) * Math.PI * 2;
                    const distance = this.radius * 1.65;

                    const x = this.x + Math.cos(angle) * distance;
                    const y = this.y + Math.sin(angle) * distance;

                    const missile = new MobObject(
                        MobObjectTypes.dandelionMissile,
                        this.rarity,
                        x,
                        y,
                        angle,
                        null,
                        this.id
                    );

                    missile.orbitCenterId = this.id;
                    missile.orbitAngle = angle;
                    missile.orbitDistance = distance;
                    missile.faction = this.faction ?? FACTION.NEUTRAL;
                    missile.ownerMobId = this.id;
                    missile.damageable = false;
                    missile.released = false;

                    missile.homing = false;
                    missile.speed = 0;
                    missile.vx = 0;
                    missile.vy = 0;

                    // Important: prevents the sprite from visually spinning if your client uses angle.
                    missile.angle = angle;

                    mobObjects.push(missile);
                    this.dandelionMissiles.push(missile.id);
                }
            }

            // If damaged, start releasing spores, but do NOT dump them all at once.
            if (this.hp < this.prevHp && !this.dandelionReleasing) {
                this.dandelionReleasing = true;
                this.dandelionReleaseTimer = 0;
            }

            this.prevHp = this.hp;

            // Keep unreleased spores attached to the dandelion, but DO NOT rotate them.
            for (let i = 0; i < this.dandelionMissiles.length; i++) {
                const missileId = this.dandelionMissiles[i];
                const missile = mobObjects.find(m => m.id === missileId);
                if (!missile || missile.hp <= 0) continue;
                if (missile.released) continue;

                const angle = missile.orbitAngle;
                const distance = missile.orbitDistance ?? this.radius * 1.5;

                missile.x = this.x + Math.cos(angle) * distance;
                missile.y = this.y + Math.sin(angle) * distance;
                missile.angle = angle;
                missile.speed = 0;
                missile.vx = 0;
                missile.vy = 0;
                missile.life = 999; // prevent despawn while attached
            }

            // Release spores one at a time.
            if (this.dandelionReleasing) {
                this.dandelionReleaseTimer -= dt;

                while (this.dandelionReleaseTimer <= 0) {
                    const missileId = this.dandelionMissiles.find(id => {
                        const missile = mobObjects.find(m => m.id === id);
                        return missile && missile.hp > 0 && !missile.released;
                    });

                    if (missileId == null) {
                        this.dandelionReleasing = false;
                        break;
                    }

                    const missile = mobObjects.find(m => m.id === missileId);
                    if (!missile) break;

                    const dx = missile.x - this.x;
                    const dy = missile.y - this.y;
                    const angle = Math.atan2(dy, dx);

                    missile.released = true;
                    missile.orbitCenterId = null;

                    missile.angle = angle;
                    missile.speed = MobObjectTypes.dandelionMissile.speed;
                    missile.vx = Math.cos(angle) * missile.speed;
                    missile.vy = Math.sin(angle) * missile.speed;

                    this.dandelionReleaseTimer += SPORE_RELEASE_INTERVAL;
                }
            }

            // Keep only existing living spores in the list.
            // This does NOT respawn them. Civilization survives another day.
            this.dandelionMissiles = this.dandelionMissiles.filter(id => {
                const missile = mobObjects.find(m => m.id === id);
                return missile && missile.hp > 0;
            });
        }
    }

    _nearestPlayerInRangeArr(playersArr, range) {
        if (range <= 0) return null;
        const r2 = range * range;

        let best = null;
        let bestD2 = Infinity;

        for (let i = 0; i < playersArr.length; i++) {
            const p = playersArr[i];
            if (p.godMode) continue;
            const d2 = dist2(this.x, this.y, p.x, p.y);
            if (d2 < r2 && d2 < bestD2) {
                best = p;
                bestD2 = d2;
            }
        }
        return best;
    }

    toJSON() {
        const out = { ...this };

        if (Array.isArray(this.bodySegments)) {
            out.bodySegments = this.bodySegments.map(seg => ({
                x: seg.x,
                y: seg.y,
                radius: seg.radius
            }));
        }

        return out;
    }
}

class PickupState {
    constructor(typeId, rarity, x, y) {
        this.id = nextPickupId++;
        this.typeId = typeId;
        this.rarity = clampPetalRarity(rarity);
        this.x = x + randf(-10, 10);
        this.y = y + randf(-10, 10);
        this.life = PICKUP_LIFETIME;
        this.radius = 10;
    }

    update(dt) {
        this.life -= dt;
    }

    isDead() {
        return this.life <= 0;
    }
}

// -------------------- Server State --------------------
const players = new Map(); // id -> PlayerState
const sockets = new Map(); // ws -> playerId
const mobs = [];
const pickups = [];

// map of active mobs by id (rebuilt every tick).  Used by centipede
// segment code so a segment can look up its predecessor quickly.
const mobById = new Map();

// cached arrays for faster iteration on hot loops
let playersArr = [];
let mobsArr = [];

function refreshLists() {
    playersArr = Array.from(players.values());
    mobsArr = mobs; // already an array, but alias for symmetry
}

function segSpacing(prev, seg) {
    return (prev.radius || MOB.radius) + (seg.radius || MOB.radius) + 2;
}

function unlinkCentipedeSegment(mob) {
    if (mob.chainPrevId != null) {
        const prev = mobById.get(mob.chainPrevId);
        if (prev) prev.chainNextId = mob.chainNextId ?? null;
    }
    if (mob.chainNextId != null) {
        const next = mobById.get(mob.chainNextId);
        if (next) next.chainPrevId = mob.chainPrevId ?? null;
    }

    mob.chainPrevId = null;
    mob.chainNextId = null;
}

function solveCentipedeConstraints(iterations = 2) {
    const softness = 0.35; // 0..1, lower = softer (less stiff)

    for (let it = 0; it < iterations; it++) {
        for (const seg of mobsArr) {
            if (seg.chainPrevId == null || seg.hp <= 0) continue;

            const prev = mobById.get(seg.chainPrevId);
            if (!prev || prev.hp <= 0) continue;

            const desired = segSpacing(prev, seg);

            let dx = seg.x - prev.x;
            let dy = seg.y - prev.y;
            let d = Math.hypot(dx, dy);

            if (d < 1e-6) {
                dx = Math.cos(prev.angle);
                dy = Math.sin(prev.angle);
                d = 1;
            }

            const err = d - desired;
            if (Math.abs(err) < 0.001) continue;

            const nx = dx / d;
            const ny = dy / d;

            // move seg toward desired distance, but only partially
            const corr = err * softness;

            const newX = seg.x - nx * corr;
            const newY = seg.y - ny * corr;

            const r = seg.radius || MOB.radius;
            const cx = clamp(newX, r, WORLD.w - r);
            const cy = clamp(newY, r, WORLD.h - r);

            if (!isWallAt(cx, seg.y)) seg.x = cx;
            if (!isWallAt(seg.x, cy)) seg.y = cy;

            seg.angle = Math.atan2(prev.y - seg.y, prev.x - seg.x);
        }
    }
}

function moveWithWalls(ent, dx, dy, r) {
    // try X
    let nx = clamp(ent.x + dx, r, WORLD.w - r);
    if (!isWallAt(nx, ent.y)) ent.x = nx;

    // try Y
    let ny = clamp(ent.y + dy, r, WORLD.h - r);
    if (!isWallAt(ent.x, ny)) ent.y = ny;
}

function pushMobOutOfPetal(mob, petalPos, petalRadius, mobRadius) {
    let dx = mob.x - petalPos.x;
    let dy = mob.y - petalPos.y;

    let d = Math.hypot(dx, dy);

    // If exactly stacked, pick a direction instead of exploding into NaN-land.
    if (d < 0.0001) {
        dx = Math.cos(mob.angle || 0);
        dy = Math.sin(mob.angle || 0);
        d = 1;
    }

    const hitDist = petalRadius + mobRadius;
    const overlap = hitDist - d;
    if (overlap <= 0) return;

    const nx = dx / d;
    const ny = dy / d;

    const mass = mob.mass ?? 1;
    const pushScale = (1 / Math.max(0.25, mass)) * 0.5;

    moveWithWalls(
        mob,
        nx * overlap * pushScale,
        ny * overlap * pushScale,
        mobRadius
    );
}

function isPointInZone(x, y, zone) {
    return pointInPolygon(x - zone.offsetX, y - zone.offsetY, zone.polygon);
}

function countMobsInZone(zone) {
    let count = 0;
    for (const m of mobs) {
        if (m.hp <= 0) continue;
        if (isPointInZone(m.x, m.y, zone)) count++;
    }
    return count;
}
function hasLivingHighRarityMobOfType(typeId) {
    for (const m of mobs) {
        if (!m || m.hp <= 0) continue;
        if (m.type === typeId && m.rarity >= 7) return true;
    }
    return false;
}

function canSpawnMobTypeRarity(type, rarity) {
    if (!type) return false;

    // Only limit rarity 7+.
    if ((rarity | 0) < 7) return true;

    // If one living rarity 7+ mob of this exact type already exists, block it.
    return !hasLivingHighRarityMobOfType(type.id);
}

function rollZoneMobRarity(zone) {
    const r = zone.rarity ?? 1;
    const base = Math.floor(r);
    const frac = r - base;

    let rarity = base + (Math.random() < frac ? 1 : 0);

    if (Math.random() < 0.1) {
        rarity += Math.random() < 0.5 ? 1 : -1;
    }

    return clamp(rarity, 0, sizeScaling.length - 1);
}

function spawnMobInZone(zone) {
    let type = null;
    let rarity = 0;

    // Try a few times so the spawner can choose another mob type
    // instead of giving up the second it rolls a blocked R7+.
    let foundAllowed = false;

    for (let tries = 0; tries < 12; tries++) {
        type = chooseMobType(zone);
        rarity = rollZoneMobRarity(zone);

        if (canSpawnMobTypeRarity(type, rarity)) {
            foundAllowed = true;
            break;
        }
    }

    if (!foundAllowed) return false;

    const pt = randomPointInPolygon(zone.polygon, zone.offsetX, zone.offsetY);

    const m = new MobState(type, rarity);
    m.x = pt.x;
    m.y = pt.y;
    mobs.push(m);

    if (type.id === "centipede" || type.id === "milipede" || type.id === "centipedeDesert") {
        m.chainGroupId = m.id;

        const len = type.length || 5;
        let prev = m;

        for (let i = 1; i < len; i++) {
            const seg = new MobState(type, rarity);
            seg.chainGroupId = m.chainGroupId;

            seg.x = prev.x - Math.cos(prev.angle) * (prev.radius + seg.radius);
            seg.y = prev.y - Math.sin(prev.angle) * (prev.radius + seg.radius);

            seg.chainPrevId = prev.id;
            prev.chainNextId = seg.id;

            // keep segment inside zone if possible
            if (!isPointInZone(seg.x, seg.y, zone)) {
                const fallback = randomPointInPolygon(zone.polygon, zone.offsetX, zone.offsetY);
                seg.x = fallback.x;
                seg.y = fallback.y;
            }

            mobs.push(seg);
            prev = seg;
        }
    }

    return true;
}

function spawnMobFallback() {
    if (mobs.length >= MAX_MOBS) return false;

    if (mobSpawnZones.length === 0) {
        for (let tries = 0; tries < 12; tries++) {
            const type = pick(MobTypeList);
            const rarity = randi(0, sizeScaling.length - 1);

            if (!canSpawnMobTypeRarity(type, rarity)) continue;

            mobs.push(new MobState(type, rarity));
            return true;
        }

        return false;
    }

    const zone = pick(mobSpawnZones);
    return spawnMobInZone(zone);
}

function ensureMobs() {
    if (mobSpawnZones.length === 0) {
        while (mobs.length < MAX_MOBS) {
            spawnMobFallback();
        }
        return;
    }

    for (const zone of mobSpawnZones) {
        const zoneCap = Math.max(0, zone.maxMobs || 0);
        if (zoneCap <= 0) continue;

        let zoneCount = countMobsInZone(zone);
        let safety = 0;
        let spawnedCount = 0;

        while (zoneCount < zoneCap && mobs.length < MAX_MOBS && safety < zoneCap * 2 + 50) {
            const spawned = spawnMobInZone(zone);
            if (spawned) {
                zoneCount = countMobsInZone(zone);
                spawnedCount++;
            }
            safety++;
        }
        console.log(`Zone with max_mobs ${zoneCap} spawned ${spawnedCount} mobs, final count ${zoneCount}`);
    }
}

function spawnFlyFromGarbage(garbageX, garbageY, garbageFaction, garbageRarity) {

    const flyType = MobTypes.fly;
    const rarity = garbageRarity;

    const fly = new MobState(flyType, rarity);

    // Spawn slightly offset from garbage center
    const angle = Math.random() * Math.PI * 2;
    const distance = 40 + Math.random() * 20;
    fly.x = garbageX + Math.cos(angle) * distance;
    fly.y = garbageY + Math.sin(angle) * distance;

    // Clamp to world bounds
    fly.x = clamp(fly.x, fly.radius, WORLD.w - fly.radius);
    fly.y = clamp(fly.y, fly.radius, WORLD.h - fly.radius);

    // Inherit garbage's faction so flies from the same garbage won't fight each other
    fly.faction = garbageFaction;

    mobs.push(fly);
}

function countNearbyMobsOfType(typeId, x, y, range) {
    const range2 = range * range;
    let count = 0;

    for (const m of mobs) {
        if (!m || m.hp <= 0) continue;
        if (m.type !== typeId) continue;

        if (dist2(x, y, m.x, m.y) <= range2) {
            count++;
        }
    }

    return count;
}

function spawnLovebugBaby(parentA, parentB) {
    const type = MobTypes.lovebugBaby;
    if (!type) return false;
    if (mobs.length >= MAX_MOBS) return false;

    const rarity = Math.min(parentA.rarity ?? 0, parentB.rarity ?? 0);
    const baby = new MobState(type, rarity);

    const mx = (parentA.x + parentB.x) / 2;
    const my = (parentA.y + parentB.y) / 2;

    const angle = Math.random() * Math.PI * 2;
    const dist = 18 + Math.random() * 18;

    baby.x = clamp(mx + Math.cos(angle) * dist, baby.radius, WORLD.w - baby.radius);
    baby.y = clamp(my + Math.sin(angle) * dist, baby.radius, WORLD.h - baby.radius);

    if (isWallAt(baby.x, baby.y)) {
        baby.x = clamp(mx, baby.radius, WORLD.w - baby.radius);
        baby.y = clamp(my, baby.radius, WORLD.h - baby.radius);
    }

    // Keep family bugs from instantly turning into a tiny civil war.
    baby.faction = parentA.faction;

    mobs.push(baby);
    return true;
}

function updateLovebugMating(dt) {
    for (const a of mobs) {
        if (!a || a.hp <= 0) continue;
        if (a.type !== "lovebug") continue;

        const typeA = MobTypes[a.type];
        if (!typeA?.canMate) continue;

        a.mateCd = Math.max(0, (a.mateCd ?? 0) - dt);

        if ((a.mateCd ?? 0) > 0) {
            a.mateWarmupLeft = 0;
            a.matePartnerId = null;
            continue;
        }

        // Don't mate while actively chasing/angry. This prevents battle from becoming bug daycare.
        if (a.targetPlayerId != null || a.targetMobId != null) {
            a.mateWarmupLeft = 0;
            a.matePartnerId = null;
            continue;
        }

        const nearbyChildren = countNearbyMobsOfType(
            "lovebugBaby",
            a.x,
            a.y,
            220
        );

        if (nearbyChildren >= (typeA.mateMaxChildrenNearby ?? 8)) {
            a.mateCd = 4;
            a.mateWarmupLeft = 0;
            a.matePartnerId = null;
            continue;
        }

        let best = null;
        let bestD2 = Infinity;
        const range = typeA.mateRange ?? 46;
        const range2 = range * range;

        for (const b of mobs) {
            if (!b || b === a || b.hp <= 0) continue;
            if (b.type !== "lovebug") continue;
            if (b.targetPlayerId != null || b.targetMobId != null) continue;
            if ((b.mateCd ?? 0) > 0) continue;

            const d2 = dist2(a.x, a.y, b.x, b.y);
            if (d2 > range2 || d2 >= bestD2) continue;

            best = b;
            bestD2 = d2;
        }

        if (!best) {
            a.mateWarmupLeft = 0;
            a.matePartnerId = null;
            continue;
        }

        // Pair them together.
        a.matePartnerId = best.id;
        best.matePartnerId = a.id;

        const warmup = typeA.mateWarmup ?? 1.25;
        a.mateWarmupLeft = (a.mateWarmupLeft ?? warmup) - dt;
        best.mateWarmupLeft = (best.mateWarmupLeft ?? warmup) - dt;

        // Nudge them to stop wandering while mating.
        a.vx = 0;
        a.vy = 0;
        best.vx = 0;
        best.vy = 0;

        if (a.mateWarmupLeft <= 0 && best.mateWarmupLeft <= 0) {
            spawnLovebugBaby(a, best);

            const cd = typeA.mateCooldown ?? 18;
            a.mateCd = cd + randf(0, 4);
            best.mateCd = cd + randf(0, 4);

            a.mateWarmupLeft = 0;
            best.mateWarmupLeft = 0;

            a.matePartnerId = null;
            best.matePartnerId = null;
        }
    }
}

// -------------------- Combat & Collisions --------------------
function handlePickups(dt) {
    // lifetime
    for (let i = pickups.length - 1; i >= 0; i--) {
        pickups[i].update(dt);
        if (pickups[i].isDead()) pickups.splice(i, 1);
    }

    // collect -> goes to inventory
    for (const player of players.values()) {
        if (player.hp <= 0) continue;

        for (let i = pickups.length - 1; i >= 0; i--) {
            const pk = pickups[i];
            const r = PLAYER.radius + pk.radius;

            if (dist2(player.x, player.y, pk.x, pk.y) <= r * r) {
                const added = player.addToInventory(pk.typeId, pk.rarity);

                if (!added) {
                    const slot = player.petals.findIndex(p => p.reloadLeft > 0 || p.hp <= 0);
                    if (slot !== -1) {
                        player.petals[slot].reloadLeft = 0;
                        player.petals[slot].hp = player.petals[slot].maxHp;
                        player.petals[slot].hitCd = 0;
                    }
                }

                pickups.splice(i, 1);
            }
        }
    }
}

// -------------------- Networking --------------------
function makeSnapshot() {
    // copy arrays quickly
    const ps = playersArr.map(p => ({
        id: p.id,
        x: p.x,
        y: p.y,
        hp: p.hp,
        maxHp: p.maxHp,
        angleBase: p.angleBase,
        petalRadius: p.petalRadius,
        petals: p.petals.map((petal, i) => {
            const type = PetalTypes[petal.typeId];
            const pos = p.petalSim?.[i] ?? { x: p.x, y: p.y };
            const angle = Math.atan2(pos.y - p.y, pos.x - p.x);

            return {
                typeId: petal.typeId,
                rarity: petal.rarity,
                hp: petal.hp,
                maxHp: petal.maxHp,
                reloadLeft: petal.reloadLeft,
                label: type?.label ?? petal.typeId,
                angle,
                spinAngle: getPetalSpinAngle(i, 0, p.time, type, petal.rarity),

                multi: resolvePetalMultiCount(type, petal.rarity),
                clumps: !!type?.clumps,
                splitMultiDamage: !!type?.splitMultiDamage,

                multiPetalRadius: getMultiPetalRadius(type, petal.rarity),

                multiPetalPos: getMultiPetalPositions(
                    pos.x,
                    pos.y,
                    angle,
                    type,
                    petal.rarity,
                    i,
                    p.time, p
                ).map(mp => {
                    const subIndex = mp.index ?? 0;
                    syncPetalMultiState(petal);

                    return {
                        ...mp,
                        angle: mp.angle ?? angle,

                        spinAngle: getPetalSpinAngle(i, subIndex, p.time, type, petal.rarity),
                        hp: petal.multiHp[subIndex] ?? petal.maxHp,
                        maxHp: petal.maxHp,
                        label: type?.label ?? petal.typeId,
                        alive: (petal.multiHp[subIndex] ?? petal.maxHp) > 0,
                        reloadLeft: petal.multiReloadLeft?.[subIndex] ?? 0,
                    };
                }),

                light: type?.light ?? null
            };
        }),
        secondaryPetals: p.secondaryPetals.map(petal => {
            const type = PetalTypes[petal.typeId];

            return {
                typeId: petal.typeId,
                label: type?.label ?? petal.typeId,
                rarity: petal.rarity,
                hp: petal.hp,
                maxHp: petal.maxHp,
                reloadLeft: petal.reloadLeft
            };
        }),
        petalPos: p.petalSim.map(s => ({ x: s.x, y: s.y })),
        inv: p.inv.map(item => {
            const type = PetalTypes[item.typeId];

            return {
                ...item,
                label: type?.label ?? item.typeId
            };
        })
    }));

    const ms = mobsArr; // objects already have toJSON

    const ks = pickups.map(k => {
        const type = PetalTypes[k.typeId];

        return {
            id: k.id,
            typeId: k.typeId,
            label: type?.label ?? k.typeId,
            rarity: k.rarity,
            x: k.x,
            y: k.y,
            life: k.life
        };
    });

    const os = mobObjects.map(o => ({
        id: o.id,
        type: o.type,
        label: o.label,
        rarity: o.rarity,
        x: o.x,
        y: o.y,
        vx: o.vx,
        vy: o.vy,
        angle: o.angle,
        hp: o.hp,
        maxHp: o.maxHp,
        radius: o.radius,
        dmg: o.dmg,
        life: o.life
    }));

    return {
        t: "state",
        now: Date.now(),
        world: WORLD,
        players: ps,
        mobs: ms,
        pickups: ks,
        mobObjects: os
    };
}

function broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
}

// -------------------- Main Loop --------------------
let tickCount = 0;
function spawnMissile(mob, targetPlayerId) {
    const type = MobObjectTypes.hornetMissile;
    if (!type) return;

    const mobR = (mob.radius || MOB.radius);

    // spawn slightly in front of hornet
    const ox = Math.cos(mob.angle) * (mobR + 6);
    const oy = Math.sin(mob.angle) * (mobR + 6);

    const obj = new MobObject(
        type,
        mob.rarity,
        mob.x + ox,
        mob.y + oy,
        mob.angle,          // ✅ angle goes here
        targetPlayerId,     // ✅ target id goes here
        mob.id              // ✅ owner mob id
    );

    // optional: give it movement immediately (feels snappier)
    obj.vx = Math.cos(obj.angle) * obj.speed;
    obj.vy = Math.sin(obj.angle) * obj.speed;
    obj.faction = mob.faction; // ✅ inherit faction

    mobObjects.push(obj);
}

function gridKey(cx, cy) { return (cx << 16) ^ cy; } // cheap-ish key
function toCell(v, cellSize) { return (v / cellSize) | 0; }

function buildFactionGrid(mobsArr, isActive, cellSize) {
    const grid = new Map(); // key -> array of mob refs
    for (let i = 0; i < mobsArr.length; i++) {
        if (isActive && !isActive[i]) continue;
        const m = mobsArr[i];
        if (m.hp <= 0) continue;
        if (m.faction === FACTION.NEUTRAL) continue;

        const cx = toCell(m.x, cellSize);
        const cy = toCell(m.y, cellSize);
        const k = gridKey(cx, cy);

        let bucket = grid.get(k);
        if (!bucket) grid.set(k, (bucket = []));
        bucket.push(m);
    }
    return grid;
}


const FACTION_CELL = 220;

// -------------------- General contact / damage helpers --------------------
function canTakeDamage(ent) {
    return !!ent && Number.isFinite(ent.hp) && ent.hp > 0;
}

function getPincerSlowStats(petal, type = PetalTypes.pincer) {
    const rarity = clampPetalRarity(petal?.rarity ?? 0);

    const slowAmount =
        (type?.slowAmount ?? 0.25) * Math.pow(1.05, rarity);

    const slowDuration =
        (type?.slowDuration ?? 2.0) +
        (type?.slowDurationPerRarity ?? 0) * rarity;

    return { slowAmount, slowDuration };
}

function applyMobSlow(mob, slowAmount, duration) {
    if (!mob || mob.hp <= 0) return false;

    // If already slowed, do NOT refresh/reapply.
    // This prevents pincer from perma-freezing mobs by constantly extending the timer.
    if ((mob.slowLeft ?? 0) > 0) return false;

    // Make sure base speed exists and is not accidentally the already-slowed speed.
    if (!Number.isFinite(mob.baseSpeed)) {
        mob.baseSpeed = Number.isFinite(mob.speed) ? mob.speed : 0;
    }

    if (!Number.isFinite(mob.baseIdleSpeed)) {
        mob.baseIdleSpeed = Number.isFinite(mob.idleSpeed)
            ? mob.idleSpeed
            : Math.min(mob.baseSpeed, 60);
    }

    mob.slowAmount = clamp(Number(slowAmount) || 0, 0, 0.85);
    mob.slowLeft = Math.max(0, Number(duration) || 0);

    return mob.slowLeft > 0 && mob.slowAmount > 0;
}

function updateMobSlow(mob, dt) {
    if (!mob) return;

    if ((mob.slowLeft ?? 0) > 0) {
        mob.slowLeft = Math.max(0, mob.slowLeft - dt);
    }

    if ((mob.slowLeft ?? 0) <= 0) {
        mob.slowLeft = 0;
        mob.slowAmount = 0;
    }
}

function getMobSlowMultiplier(mob) {
    if (!mob || (mob.slowLeft ?? 0) <= 0) return 1;

    const amount = Number(mob.slowAmount) || 0;

    // 0.15 minimum means even a ridiculous rarity pincer cannot make mobs fully frozen.
    return clamp(1 - amount, 0.15, 1);
}

function applyEntityDamage(target, amount, source = null, opts = {}) {
    if (!canTakeDamage(target)) return false;
    if (!Number.isFinite(amount) || amount <= 0) return false;

    if (opts.ignoreGod !== true && target.godMode) return false;

    const targetCdProp = opts.targetCdProp ?? null;
    if (targetCdProp && (target[targetCdProp] ?? 0) > 0) return false;

    target.hp -= amount;

    if (target.type === "antHole") {
        handleAntHoleDamageSpawns(target, opts.neutralAggroPlayer ?? source);
    }

    if (targetCdProp) target[targetCdProp] = opts.targetCd ?? 0.12;

    if (opts.neutralAggroPlayer && target.behavior === "neutral" && !target.targetPlayerId) {
        target.targetPlayerId = opts.neutralAggroPlayer.id;
    }

    if (opts.targetMobId != null) {
        target.targetMobId = opts.targetMobId;
        target.targetPlayerId = null;
    }

    return true;
}
function getNearestPlayerToMob(mob) {
    let best = null;
    let bestD2 = Infinity;

    for (const p of playersArr) {
        if (!p || p.hp <= 0 || p.godMode) continue;

        const d2 = dist2(mob.x, mob.y, p.x, p.y);
        if (d2 < bestD2) {
            bestD2 = d2;
            best = p;
        }
    }

    return best;
}

function spawnMobNearMob(typeId, rarity, sourceMob, opts = {}) {
    const type = MobTypes[typeId];
    if (!type || !sourceMob) return null;

    const mob = new MobState(type, rarity);

    const spread = opts.spread ?? Math.max(20, sourceMob.radius || MOB.radius);
    const angle = randf(0, Math.PI * 2);
    const dist = randf(sourceMob.radius || MOB.radius, (sourceMob.radius || MOB.radius) + spread);

    mob.x = clamp(
        sourceMob.x + Math.cos(angle) * dist,
        mob.radius || MOB.radius,
        WORLD.w - (mob.radius || MOB.radius)
    );

    mob.y = clamp(
        sourceMob.y + Math.sin(angle) * dist,
        mob.radius || MOB.radius,
        WORLD.h - (mob.radius || MOB.radius)
    );

    // Try not to spawn inside walls. Humanity's greatest invention: not putting ants in drywall.
    for (let tries = 0; tries < 12 && isWallAt(mob.x, mob.y); tries++) {
        const a = randf(0, Math.PI * 2);
        const d = randf(sourceMob.radius || MOB.radius, (sourceMob.radius || MOB.radius) + spread * 2);

        mob.x = clamp(
            sourceMob.x + Math.cos(a) * d,
            mob.radius || MOB.radius,
            WORLD.w - (mob.radius || MOB.radius)
        );

        mob.y = clamp(
            sourceMob.y + Math.sin(a) * d,
            mob.radius || MOB.radius,
            WORLD.h - (mob.radius || MOB.radius)
        );
    }

    mobs.push(mob);
    mobById.set(mob.id, mob);

    return mob;
}

function spawnFriendlyMobFromPetal(player, petal, slotIndex) {
    if (!player || !petal) return null;

    const petalType = PetalTypes[petal.typeId];
    if (!petalType?.deathSummonType) return null;

    // One summon per egg. No beetle printer. Society survives another day.
    if (petal.summonMobId != null) {
        const existing = mobById.get(petal.summonMobId);
        if (existing && existing.hp > 0) {
            return existing;
        }

        petal.summonMobId = null;
    }

    const mobType = MobTypes[petalType.deathSummonType];
    if (!mobType) return null;

    const pos = player.petalSim?.[slotIndex] ?? { x: player.x, y: player.y };

    const rarityOffset = petalType.deathSummonRarityOffset ?? -1;
    const summonRarity = clamp(
        (petal.rarity | 0) + rarityOffset,
        0,
        sizeScaling.length - 1
    );

    const mob = new MobState(mobType, summonRarity);

    const spawnR = Math.max(20, mob.radius || MOB.radius);
    const a = randf(0, Math.PI * 2);
    const d = randf(10, spawnR + 20);

    mob.x = clamp(
        pos.x + Math.cos(a) * d,
        mob.radius || MOB.radius,
        WORLD.w - (mob.radius || MOB.radius)
    );

    mob.y = clamp(
        pos.y + Math.sin(a) * d,
        mob.radius || MOB.radius,
        WORLD.h - (mob.radius || MOB.radius)
    );

    for (let tries = 0; tries < 12 && isWallAt(mob.x, mob.y); tries++) {
        const aa = randf(0, Math.PI * 2);
        const dd = randf(10, spawnR + 45);

        mob.x = clamp(
            pos.x + Math.cos(aa) * dd,
            mob.radius || MOB.radius,
            WORLD.w - (mob.radius || MOB.radius)
        );

        mob.y = clamp(
            pos.y + Math.sin(aa) * dd,
            mob.radius || MOB.radius,
            WORLD.h - (mob.radius || MOB.radius)
        );
    }

    // Player-owned ally.
    mob.faction = player.faction ?? FACTION.PLAYER;

    // Summon metadata.
    mob.isPetalSummon = true;
    mob.ownerPlayerId = player.id;
    mob.ownerPetalSlot = slotIndex;
    mob.ownerPetalTypeId = petal.typeId;

    // Fight mobs first, follow owner when idle.
    mob.behavior = "summon";
    mob.aggroType = "chase";
    mob.idleType = "followOwner";
    mob.aggroRange = Math.max(mob.aggroRange ?? 0, 650);
    mob.leashRange = Math.max(mob.leashRange ?? 0, MOB_UPDATE_RANGE);

    mob.targetPlayerId = null;
    mob.targetMobId = null;
    mob._refreshAIFns?.();

    mob.hardLeashRange = SUMMON_HARD_LEASH_RANGE;
    mob.softLeashRange = SUMMON_SOFT_LEASH_RANGE;

    mobs.push(mob);
    mobById.set(mob.id, mob);

    petal.summonMobId = mob.id;

    return mob;
}

function handleAntHoleDamageSpawns(mob, source = null) {
    if (!mob || mob.type !== "antHole") return;
    if (mob.maxHp <= 0) return;

    const type = MobTypes[mob.type];
    const frac = type.spawnAntsEveryHpFrac ?? 0.15;
    if (frac <= 0) return;

    // Initialize the counter the first time the hole gets hurt.
    mob.antHoleSpawnStepsDone ??= 0;

    const hpLost = clamp(mob.maxHp - Math.max(0, mob.hp), 0, mob.maxHp);
    const stepsNow = Math.floor(hpLost / (mob.maxHp * frac));

    const stepsToSpawn = stepsNow - mob.antHoleSpawnStepsDone;
    if (stepsToSpawn <= 0) return;

    mob.antHoleSpawnStepsDone = stepsNow;

    const targetPlayer =
        source?.id != null && players.has(source.id)
            ? source
            : getNearestPlayerToMob(mob);

    const antsPerStep = type.spawnAntsPerThreshold ?? 3;
    const totalAnts = stepsToSpawn * antsPerStep;

    for (let i = 0; i < totalAnts; i++) {
        const drop = randi(type.spawnAntMinRarityDrop ?? 1, type.spawnAntMaxRarityDrop ?? 2);
        const antRarity = clamp((mob.rarity | 0) - drop, 0, sizeScaling.length - 1);

        const ant = spawnMobNearMob(type.spawnAntType ?? "ant", antRarity, mob, {
            spread: 55
        });

        if (!ant) continue;

        // Force them hostile and chasing, regardless of normal ant neutrality.
        ant.behavior = "hostile";
        ant.aggroType = "chase";
        ant._aggroFn = resolveAggroFn("chase");
        ant.aggroRange = Math.max(ant.aggroRange ?? 0, MOB_UPDATE_RANGE);

        if (targetPlayer) {
            ant.targetPlayerId = targetPlayer.id;
            ant.targetMobId = null;
        }
    }
}

function handleMobDeathSpawn(mob) {
    if (!mob) return;

    const type = MobTypes[mob.type];
    const deathSpawnType = type?.deathSpawnType;
    if (!deathSpawnType) return;

    const spawned = spawnMobNearMob(deathSpawnType, mob.rarity, mob, {
        spread: 70
    });

    if (!spawned) return;

    spawned.behavior = "hostile";
    spawned.aggroType = spawned.aggroType || "chase";
    spawned._aggroFn = resolveAggroFn(spawned.aggroType);

    const targetPlayer = getNearestPlayerToMob(mob);
    if (targetPlayer) {
        spawned.targetPlayerId = targetPlayer.id;
        spawned.targetMobId = null;
    }
}

function circlesTouch(ax, ay, ar, bx, by, br) {
    const r = ar + br;
    return dist2(ax, ay, bx, by) <= r * r;
}

function getMobHitParts(mob) {
    if (!mob) return [];

    const parts = [{
        x: mob.x,
        y: mob.y,
        radius: mob.radius || MOB.radius,
        index: 0,
        isHead: true
    }];

    if (Array.isArray(mob.bodySegments)) {
        for (let i = 0; i < mob.bodySegments.length; i++) {
            const seg = mob.bodySegments[i];
            if (!seg) continue;

            parts.push({
                x: seg.x,
                y: seg.y,
                radius: seg.radius || mob.radius || MOB.radius,
                index: i + 1,
                isHead: false
            });
        }
    }

    return parts;
}

function syncRopeBodySegments(mob, type) {
    if (!type?.ropeBody) {
        mob.bodySegments = null;
        return;
    }

    const count = Math.max(0, type.bodySegments | 0);
    const segRadius = (mob.radius || MOB.radius) * (type.bodySegmentRadiusMult ?? 0.8);

    if (!Array.isArray(mob.bodySegments)) mob.bodySegments = [];

    while (mob.bodySegments.length < count) {
        const prev = mob.bodySegments[mob.bodySegments.length - 1] || mob;

        mob.bodySegments.push({
            x: prev.x - Math.cos(mob.angle || 0) * segRadius * 2,
            y: prev.y - Math.sin(mob.angle || 0) * segRadius * 2,
            radius: segRadius
        });
    }

    mob.bodySegments.length = count;

    for (const seg of mob.bodySegments) {
        seg.radius = segRadius;
    }
}

function updateRopeBodySegments(mob, dt) {
    const type = MobTypes[mob.type];
    if (!type?.ropeBody) return;

    syncRopeBodySegments(mob, type);

    const spacing =
        (mob.radius || MOB.radius) *
        (type.bodySegmentSpacingMult ?? 1.1);

    const sharpness = type.bodyFollowSharpness ?? 14;
    const k = 1 - Math.exp(-sharpness * dt);

    let prev = mob;

    for (let i = 0; i < mob.bodySegments.length; i++) {
        const seg = mob.bodySegments[i];

        let dx = seg.x - prev.x;
        let dy = seg.y - prev.y;
        let d = Math.hypot(dx, dy);

        if (d < 0.0001) {
            dx = -Math.cos(mob.angle || 0);
            dy = -Math.sin(mob.angle || 0);
            d = 1;
        } else {
            dx /= d;
            dy /= d;
        }

        const tx = prev.x + dx * spacing;
        const ty = prev.y + dy * spacing;

        seg.x += (tx - seg.x) * k;
        seg.y += (ty - seg.y) * k;

        const r = seg.radius || mob.radius || MOB.radius;
        seg.x = clamp(seg.x, r, WORLD.w - r);
        seg.y = clamp(seg.y, r, WORLD.h - r);

        if (isWallAt(seg.x, seg.y)) {
            // If the body clips into a wall, pull it back toward the previous link.
            seg.x = prev.x + dx * spacing;
            seg.y = prev.y + dy * spacing;
        }

        prev = seg;
    }
}

function pushDeadMob(deadIndices, index, mob) {
    if (index == null || index < 0 || !mob || mob.hp > 0) return;
    if (!deadIndices.includes(index)) deadIndices.push(index);
}

function damagePetalSub(petal, subIndex, amount) {
    if (!petal) return false;

    syncPetalMultiState(petal);
    subIndex = clamp(subIndex | 0, 0, petal.multiHp.length - 1);

    if (!Number.isFinite(amount) || amount <= 0) return false;
    if ((petal.multiHp[subIndex] ?? 0) <= 0) return false;
    if ((petal.multiDamageCd[subIndex] ?? 0) > 0) return false;

    petal.multiHp[subIndex] = Math.max(0, petal.multiHp[subIndex] - amount);
    petal.multiDamageCd[subIndex] = 0.12;

    if (petal.multiHp[subIndex] <= 0) {
        petal.multiHp[subIndex] = 0;
        petal.multiHitCd[subIndex] = 0;
        petal.multiDamageCd[subIndex] = 0;
        petal.multiReloadLeft[subIndex] = petal.reloadTime;
    }

    petal.hp = petal.multiHp.reduce((sum, hp) => sum + Math.max(0, hp || 0), 0);

    // Only spawn death summon when the whole slot is dead.
    if (petalMultiAliveCount(petal) <= 0) {
        if (petal._deathOwner && petal._deathSlotIndex != null) {
            spawnFriendlyMobFromPetal(petal._deathOwner, petal, petal._deathSlotIndex);
        }
    }

    return true;
}

function explodeLandmine(player, petal, deadIndices) {
    const type = PetalTypes[petal.typeId];

    if (!type?.isDroppable || petal.typeId !== "landmine") return false;
    if (!petal.dropped || petal.reloadLeft > 0) return false;

    const r =
        (type.explosionRadiusBase ?? 500) *
        Math.pow(type.explosionRadiusScale ?? 1, petal.rarity);

    const r2 = r * r;
    const dmg = petal.dmg;

    // Damage mobs in explosion radius.
    for (let mi = 0; mi < mobsArr.length; mi++) {
        const mob = mobsArr[mi];

        if (!canTakeDamage(mob)) continue;
        if (dist2(petal.dropX, petal.dropY, mob.x, mob.y) > r2) continue;

        const didDamage = applyEntityDamage(mob, dmg, petal, {
            targetCdProp: "hitCd",
            targetCd: 0.12,
            neutralAggroPlayer: player
        });

        if (didDamage) {
            pushDeadMob(deadIndices, mi, mob);
        }
    }

    // Damage players too, but not godmode players.
    for (const p of playersArr) {
        if (!canTakeDamage(p) || p.godMode) continue;
        if (p === player) {
            // Remove this if you WANT the owner to be hit too.
            // Since you said landmine should damage players as a downside,
            // this line decides whether it damages only other players or everyone.
        }

        if (dist2(petal.dropX, petal.dropY, p.x, p.y) > r2) continue;

        applyEntityDamage(p, dmg, petal, {
            targetCdProp: "hitCd",
            targetCd: 0.12
        });
    }

    petal.forceReload();
    return true;
}

function handlePetalEntityContact(player, slotIndex, petal, target, targetRadius, deadIndices, targetMobIndex = null, hitX = null, hitY = null) {
    if (!petal || petal.disabledByStack || !petal.isAlive() || !canTakeDamage(target)) return false;
    if (isPetalSlotStackDisabled(player, slotIndex)) return false;

    if (
        target &&
        target.type !== undefined &&
        isFriendlyFaction(player.faction, target.faction)
    ) {
        return false;
    }

    const petalType = PetalTypes[petal.typeId];
    const pos = player.petalSim?.[slotIndex];
    if (!petalType || !pos) return false;

    petal._deathOwner = player;
    petal._deathSlotIndex = slotIndex;

    const petalAngle = Math.atan2(pos.y - player.y, pos.x - player.x) || 0;

    const multiPositions = getMultiPetalPositions(
        pos.x,
        pos.y,
        petalAngle,
        petalType,
        petal.rarity,
        slotIndex,
        player.time,
        player
    );

    const multiRadius = getMultiPetalRadius(petalType, petal.rarity);
    const multiDamage = getPetalMultiDamage(petal, petalType);

    for (const mp of multiPositions) {
        const subIndex = mp.index ?? 0;

        syncPetalMultiState(petal);

        if ((petal.multiHp[subIndex] ?? 0) <= 0) continue;
        if ((petal.multiHitCd[subIndex] ?? 0) > 0) continue;

        const tx = Number.isFinite(hitX) ? hitX : target.x;
        const ty = Number.isFinite(hitY) ? hitY : target.y;

        if (!circlesTouch(mp.x, mp.y, multiRadius, tx, ty, targetRadius)) continue;

        // Petals are physical bodies, like the second doc.
        // Push the target out from this exact petal body.
        if (target && target.type !== undefined) {
            const fakePetalBody = {
                x: mp.x,
                y: mp.y
            };

            resolveCircleOverlap(
                target,
                fakePetalBody,
                targetRadius,
                multiRadius
            );
        }

        if (petal.typeId === "landmine" && petal.dropped) {
            return explodeLandmine(player, petal, deadIndices);
        }

        const didDamage = applyEntityDamage(target, multiDamage, petal, {
            neutralAggroPlayer: player
        });

        if (!didDamage) continue;

        petal.multiHitCd[subIndex] = 0.12;

        if (petal.typeId === "pincer" && target.type !== undefined) {
            const type = PetalTypes[petal.typeId];
            const { slowAmount, slowDuration } = getPincerSlowStats(petal, type);

            applyMobSlow(target, slowAmount, slowDuration);
        }

        damagePetalSub(petal, subIndex, target.dmg ?? 0);

        if (targetMobIndex != null) {
            pushDeadMob(deadIndices, targetMobIndex, target);
        }

        return true;
    }

    return false;
}

function tick() {
    ensureMobs();

    refreshLists();

    const plArr = playersArr;
    const mbArr = mobsArr;

    mobById.clear();
    for (const m of mbArr) mobById.set(m.id, m);

    let minPX = Infinity;
    let maxPX = -Infinity;
    let minPY = Infinity;
    let maxPY = -Infinity;

    for (const p of plArr) {
        if (p.x < minPX) minPX = p.x;
        if (p.x > maxPX) maxPX = p.x;
        if (p.y < minPY) minPY = p.y;
        if (p.y > maxPY) maxPY = p.y;
    }

    if (minPX !== Infinity) {
        minPX -= MOB_UPDATE_RANGE;
        maxPX += MOB_UPDATE_RANGE;
        minPY -= MOB_UPDATE_RANGE;
        maxPY += MOB_UPDATE_RANGE;
    }

    const isActive = new Array(mbArr.length).fill(false);

    if (plArr.length) {
        for (let i = 0; i < mbArr.length; i++) {
            const mob = mbArr[i];

            if (!mob || mob.hp <= 0) continue;

            if (
                minPX !== Infinity &&
                (mob.x < minPX || mob.x > maxPX || mob.y < minPY || mob.y > maxPY)
            ) {
                continue;
            }

            for (const p of plArr) {
                const dx = mob.x - p.x;
                const dy = mob.y - p.y;

                if (dx * dx + dy * dy <= MOB_UPDATE_RANGE2) {
                    isActive[i] = true;
                    break;
                }
            }
        }
    }

    const factionGrid = buildFactionGrid(mbArr, isActive, FACTION_CELL);

    updateLovebugMating(DT);

    for (const p of plArr) {
        p.update(DT);
    }

    const deadIndices = [];

    if (mbArr.length && plArr.length) {
        for (let mi = 0; mi < mbArr.length; mi++) {
            const mob = mbArr[mi];
            if (!mob) continue;

            if (mob.hp <= 0) {
                const nextId = mob.chainNextId;
                const wasHead = mob.chainPrevId == null && nextId != null;

                unlinkCentipedeSegment(mob);

                if (wasHead && nextId != null) {
                    const nxt = mobById.get(nextId);

                    if (nxt && nxt.hp > 0) {
                        nxt.chainPrevId = null;
                        nxt.targetPlayerId = mob.targetPlayerId;
                        nxt.chainGroupId = mob.chainGroupId;
                    }
                }

                pushDeadMob(deadIndices, mi, mob);
                continue;
            }

            if (!isActive[mi]) continue;

            // Always make sure base speeds exist before deriving slowed speeds.
            mob.baseSpeed ??= mob.speed;
            mob.baseIdleSpeed ??= mob.idleSpeed ?? Math.min(mob.baseSpeed, 60);

            updateMobSlow(mob, DT);

            const slowMult = getMobSlowMultiplier(mob);
            mob.speed = mob.baseSpeed * slowMult;
            mob.idleSpeed = mob.baseIdleSpeed * slowMult;

            mob.update(DT, plArr, players, factionGrid);

            // Restore so stacking/refreshing stays sane next tick.
            mob.speed = mob.baseSpeed ?? mob.speed;
            mob.idleSpeed = mob.baseIdleSpeed ?? mob.idleSpeed;

            // mob ↔ mob: push and hostile touch damage
            for (let mj = 0; mj < mi; mj++) {
                if (!isActive[mj]) continue;

                const other = mbArr[mj];
                if (!other || other.hp <= 0) continue;

                if (mob.chainGroupId != null && mob.chainGroupId === other.chainGroupId) continue;
                if (shouldSkipMobMobCollision(mob, other)) continue;

                const dxm = mob.x - other.x;
                const dym = mob.y - other.y;
                const rsum = (mob.radius || MOB.radius) + (other.radius || MOB.radius);
                const d2 = dxm * dxm + dym * dym;

                if (d2 > 0 && d2 < rsum * rsum) {
                    const d = Math.sqrt(d2);
                    const nx = dxm / d;
                    const ny = dym / d;
                    const overlap = rsum - d;

                    const totalMass = Math.max(0.0001, (mob.mass || 1) + (other.mass || 1));
                    const mobShare = (other.mass || 1) / totalMass;
                    const otherShare = (mob.mass || 1) / totalMass;

                    moveWithWalls(
                        mob,
                        nx * overlap * mobShare,
                        ny * overlap * mobShare,
                        mob.radius || MOB.radius
                    );

                    moveWithWalls(
                        other,
                        -nx * overlap * otherShare,
                        -ny * overlap * otherShare,
                        other.radius || MOB.radius
                    );

                    if (canDamageFaction(mob.faction, other.faction)) {
                        if (mob.attackCd <= 0) {
                            applyEntityDamage(mob, other.dmg, other, { targetMobId: other.id });
                            mob.attackCd = 0.01;
                            pushDeadMob(deadIndices, mi, mob);
                        }

                        if (other.attackCd <= 0) {
                            applyEntityDamage(other, mob.dmg, mob, { targetMobId: mob.id });
                            other.attackCd = 0.01;
                            pushDeadMob(deadIndices, mj, other);
                        }
                    }
                }
            }

            // petal ↔ mob
            for (const player of plArr) {
                if (!player || player.hp <= 0) continue;

                const parts = getMobHitParts(mob);

                let closestD2 = Infinity;
                for (const part of parts) {
                    const d2 = dist2(part.x, part.y, player.x, player.y);
                    if (d2 < closestD2) closestD2 = d2;
                }

                const approxR =
                    player.petalRadius +
                    getPlayerMaxPetalReach(player) +
                    (mob.radius || MOB.radius) +
                    PETAL_WOBBLE.ampMax +
                    64;

                if (closestD2 > approxR * approxR) continue;

                let hit = false;

                for (let i = 0; i < player.petals.length && !hit; i++) {
                    for (const part of parts) {
                        if (
                            handlePetalEntityContact(
                                player,
                                i,
                                player.petals[i],
                                mob,
                                part.radius,
                                deadIndices,
                                mi,
                                part.x,
                                part.y
                            )
                        ) {
                            hit = true;
                            break;
                        }
                    }
                }
            }

            // mob ↔ player
            if (!mob.isPetalSummon) {
                for (const player of plArr) {
                    if (!player || player.hp <= 0) continue;

                    const pr = PLAYER.radius;
                    const canDamagePlayer = canDamageFaction(mob.faction, player.faction);

                    for (const part of getMobHitParts(mob)) {
                        const mr = part.radius || MOB.radius;

                        // Only push from the head. Body pushing gets annoying fast.
                        if (part.isHead) {
                            resolveCircleOverlap(mob, player, mr, pr);
                        }

                        if (
                            canDamagePlayer &&
                            circlesTouch(part.x, part.y, mr, player.x, player.y, pr) &&
                            mob.attackCd <= 0
                        ) {
                            applyEntityDamage(player, mob.dmg, mob);
                            mob.attackCd = 0.5;
                            break;
                        }
                    }
                }
            }
        }
    }

    // mob projectiles / mob objects
    for (let oi = mobObjects.length - 1; oi >= 0; oi--) {
        const o = mobObjects[oi];

        o.update(DT, players);

        if (o.isDead()) {
            mobObjects.splice(oi, 1);
            continue;
        }

        // mobObject ↔ player
        for (const p of plArr) {
            if (!p || p.hp <= 0) continue;

            if (circlesTouch(o.x, o.y, o.radius, p.x, p.y, PLAYER.radius)) {
                if (applyEntityDamage(p, o.dmg, o)) {
                    o.hp = 0;
                }

                break;
            }
        }

        // mobObject ↔ hostile mob
        if (!o.isDead()) {
            for (let mi = 0; mi < mbArr.length; mi++) {
                if (!isActive[mi]) continue;

                const m = mbArr[mi];
                if (!m || m.hp <= 0) continue;
                if (!isHostileFaction(o.faction, m.faction)) continue;

                if (circlesTouch(o.x, o.y, o.radius, m.x, m.y, m.radius || MOB.radius)) {
                    if (
                        applyEntityDamage(m, o.dmg, o, {
                            targetCdProp: "hitCd",
                            targetCd: 0.12
                        })
                    ) {
                        o.hp = 0;
                        pushDeadMob(deadIndices, mi, m);
                    }

                    break;
                }
            }
        }

        if (o.isDead()) {
            mobObjects.splice(oi, 1);
            continue;
        }

        // petal ↔ mobObject
        for (const player of plArr) {
            if (!player || player.hp <= 0) continue;

            const dxp = o.x - player.x;
            const dyp = o.y - player.y;

            const approxR =
                player.petalRadius +
                getPlayerMaxPetalReach(player) +
                o.radius +
                PETAL_WOBBLE.ampMax +
                12;

            if (dxp * dxp + dyp * dyp > approxR * approxR) continue;

            for (let i = 0; i < player.petals.length; i++) {
                if (
                    handlePetalEntityContact(
                        player,
                        i,
                        player.petals[i],
                        o,
                        o.radius,
                        deadIndices
                    )
                ) {
                    break;
                }
            }

            if (o.isDead()) break;
        }

        if (o.isDead()) {
            mobObjects.splice(oi, 1);
        }
    }

    const uniqueDeadIndices = [...new Set(deadIndices)]
        .filter(i => Number.isInteger(i) && i >= 0 && i < mobs.length)
        .sort((a, b) => b - a);

    for (const idx of uniqueDeadIndices) {
        const mob = mobs[idx];
        if (!mob) continue;

        handleMobDeathSpawn(mob);

        const drops = Array.isArray(mob.drops) ? mob.drops : [];

        for (const dropType of drops) {
            if (!PetalTypes[dropType]) continue;

            pickups.push(
                new PickupState(
                    dropType,
                    rollDropRarityFromMob(mob.rarity),
                    mob.x,
                    mob.y
                )
            );
        }

        if (
            typeof unlinkCentipedeSegment === "function" &&
            (mob.chainPrevId != null || mob.chainNextId != null)
        ) {
            unlinkCentipedeSegment(mob);
        }

        // Release any remaining dandelion missiles if the dandelion dies
        if (mob.type === "dandelion" && mob.dandelionMissiles) {
            for (const missileId of mob.dandelionMissiles) {
                const missile = mobObjects.find(m => m.id === missileId);
                if (!missile || missile.hp <= 0 || missile.released) continue;

                const dx = missile.x - mob.x;
                const dy = missile.y - mob.y;
                const angle = Math.atan2(dy, dx);

                missile.released = true;
                missile.orbitCenterId = null;

                missile.angle = angle;
                missile.speed = MobObjectTypes.dandelionMissile.speed;
                missile.vx = Math.cos(angle) * missile.speed;
                missile.vy = Math.sin(angle) * missile.speed;
            }
        }

        if (mob.isPetalSummon && mob.ownerPlayerId != null && mob.ownerPetalSlot != null) {
            const owner = players.get(mob.ownerPlayerId);
            const petal = owner?.petals?.[mob.ownerPetalSlot];

            if (petal && petal.summonMobId === mob.id) {
                petal.summonMobId = null;
            }
        }

        mobs.splice(idx, 1);
    }

    solveCentipedeConstraints(8);
    handlePickups(DT);

    for (const p of plArr) {
        if (p.hp <= 0) {
            p.hp = p.maxHp;

            const sp2 = getRandomSpawnPoint();
            p.x = sp2.x;
            p.y = sp2.y;

            p.snapPetalsToTargets();
        }
    }

    tickCount++;

    if (tickCount % SNAPSHOT_EVERY_TICKS === 0) {
        broadcast(makeSnapshot());
    }
}

setInterval(tick, 1000 / TICK_RATE);

// -------------------- HTTP + WS Setup --------------------
const app = express();
app.use(express.static("public"));

// expose map files so clients can fetch them if needed
app.get("/maps/:file", (req, res) => {
    const p = path.join(__dirname, "maps", req.params.file);
    res.sendFile(p);
});

app.get("/staticdata", (req, res) => {
    res.json({
        petal: PETAL,
        petalRarity: PETAL_RARITY,
        petalRarityScale: PETAL_RARITY_SCALE,
        petalTypes: PetalTypes,
        mob: MOB,
        mobTypes: MobTypes,
        mobObjectTypes: MobObjectTypes,
        faction: FACTION,
        sizeScaling
    });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
    const id = nextPlayerId++;
    const player = new PlayerState(id);

    players.set(id, player);
    sockets.set(ws, id);

    // send initial handshake plus any map info client might need
    const hello = { t: "hello", id };
    if (currentMapData) {
        hello.map = {
            width: currentMapData.width,
            height: currentMapData.height,
            tilewidth: currentMapData.tilewidth,
            tileheight: currentMapData.tileheight
        };
    }
    if (spawnObjects.length > 0) {
        // send only polygons/offsets so client can visualize spawn area if desired
        hello.spawn = spawnObjects.map(o => ({ polygon: o.polygon, x: o.offsetX, y: o.offsetY }));
    }
    if (wallTiles) {
        // send minimal wall grid data for client rendering & potential pathing
        hello.walls = {
            width: wallTiles.width,
            height: wallTiles.height,
            tilewidth: wallTiles.tilewidth,
            tileheight: wallTiles.tileheight,
            data: wallTiles.data
        };
    }
    ws.send(JSON.stringify(hello));

    ws.on("message", (buf) => {
        let msg;
        try {
            msg = JSON.parse(buf.toString());
        } catch {
            return;
        }

        const pid = sockets.get(ws);
        const p = pid ? players.get(pid) : null;
        if (!p) return;

        if (msg.t === "input") {
            p.input.up = !!msg.up;
            p.input.down = !!msg.down;
            p.input.left = !!msg.left;
            p.input.right = !!msg.right;
            p.input.extend = !!msg.extend;
            p.input.retract = !!msg.retract;
            return;
        }

        if (msg.t === "drop_petals") {
            p.dropDroppablePetals();
            return;
        }

        if (msg.t === "godMode") {
            p.godMode = !!msg.enabled;
            return;
        }

        if (msg.t === "petal_swap") {
            p.swapPetalsAndReload(msg.a | 0, msg.b | 0);
            return;
        }

        if (msg.t === "swap_secondary_slot") {
            p.swapPrimaryWithSecondarySlot(msg.slot | 0);
            return;
        }

        if (msg.t === "swap_secondary_all") {
            p.swapAllPrimaryAndSecondary();
            return;
        }

        if (msg.t === "inv_swap_slot") {
            p.swapInvWithSlot(msg.inv | 0, msg.slot | 0);
            return;
        }

        if (msg.t === "inv_swap_inv") {
            p.swapInvSlots(msg.a | 0, msg.b | 0);
            return;
        }

        if (msg.t === "craft_petal") {
            const result = p.craftPetal(msg.typeId, msg.rarity | 0);

            ws.send(JSON.stringify({
                t: "craft_result",
                ...result
            }));

            return;
        }

        if (msg.t === "craft_all_petals") {
            const result = p.craftAllPetals(msg.typeId, msg.rarity | 0);

            ws.send(JSON.stringify({
                t: "craft_result",
                ...result
            }));

            return;
        }

        if (msg.t === "dev_spawn_pickup") {
            const x = Number(msg.x);
            const y = Number(msg.y);
            const typeId = String(msg.typeId || "basic");
            const rarity = clampPetalRarity(Number(msg.rarity) || 0);

            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            if (!PetalTypes[typeId]) return;

            pickups.push(new PickupState(typeId, rarity, x, y));
            return;
        }

        if (msg.t === "dev_set_slot") {
            const slotIndex = msg.slot | 0;
            const typeId = String(msg.type || "basic");
            const rarity = clampPetalRarity(Number(msg.rarity) || 0);

            if (slotIndex < 0 || slotIndex >= p.petals.length) return;
            if (!PetalTypes[typeId]) return;

            p.petals[slotIndex].setType(typeId, rarity);
            p.petals[slotIndex].forceReload();
            return;
        }

        // developer: spawn a mob at (x,y) with optional type and rarity
        // usage from client devtools: ws.send(JSON.stringify({t:"dev_spawn_mob", x:100, y:200, type:"ant", rarity:2}));
        if (msg.t === "dev_spawn_mob") {
            // allow only well-formed requests
            const x = Number(msg.x);
            const y = Number(msg.y);
            let typeId = typeof msg.type === "string" ? msg.type : null;
            let rarity = (msg.rarity == null) ? null : Number(msg.rarity);

            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                // ignore malformed
                return;
            }

            // resolve mob type, fallback to random if unknown
            let type = null;
            if (typeId && MobTypes[typeId]) type = MobTypes[typeId];
            if (!type) type = pick(MobTypeList);

            // clamp rarity if provided, otherwise let MobState randomize
            if (Number.isFinite(rarity)) {
                rarity = Math.floor(rarity);
                rarity = clamp(rarity, 0, sizeScaling.length - 1);
            } else {
                rarity = undefined;
            }

            const m = new MobState(type, rarity);
            m.x = clamp(x, 0, WORLD.w);
            m.y = clamp(y, 0, WORLD.h);
            mobs.push(m);
            console.log(`Dev spawned mob ${m.label || m.type} id=${m.id} at ${m.x},${m.y} (rarity=${m.rarity})`);
            return;
        }
    });

    ws.on("close", () => {
        const pid = sockets.get(ws);
        sockets.delete(ws);
        if (pid) players.delete(pid);
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
