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
    speed: 220,
    bodyDmg: 20
};

const LEVELING = {
    maxLevel: 200,

    startSlots: 5,
    maxSlots: 10,
    levelsPerSlot: 5,

    maxHpBase: 250,
    maxHpGrowth: 1.02,

    bodyDmgBase: 20,
    bodyDmgGrowth: 1.02,

    expRequirementBase: 45,
    expRequirementPower: 1.126,

    mobKillExpBase: 10,
    mobKillExpRarityGrowth: 1.75,

    craftSuccessExpBase: 20,
    craftSuccessExpRarityGrowth: 2.2
};

function getExpRequiredForLevel(level) {
    // Player starts at level 0, so level 1 costs:
    // 50 * 1^1.2 = 50 exp.
    level = Math.max(1, Math.floor(Number(level) || 1));
    return Math.ceil(
        LEVELING.expRequirementBase *
        Math.pow(level, LEVELING.expRequirementPower)
    );
}

function getExpRequiredForNextLevel(currentLevel) {
    currentLevel = Math.max(0, Math.floor(Number(currentLevel) || 0));
    return getExpRequiredForLevel(currentLevel + 1);
}

function getMobKillExp(mob) {
    if (!mob) return 0;

    const rarity = clamp(
        Math.floor(Number(mob.rarity) || 0),
        0,
        sizeScaling.length - 1
    );

    const type = MobTypes[mob.type];
    const typeMult = Number.isFinite(type?.expMult) ? type.expMult : 1;

    return Math.max(
        1,
        Math.round(
            LEVELING.mobKillExpBase *
            Math.pow(LEVELING.mobKillExpRarityGrowth, rarity) *
            typeMult
        )
    );
}

function getCraftSuccessExp(targetRarity) {
    const rarity = clampPetalRarity(targetRarity);

    return Math.max(
        1,
        Math.round(
            LEVELING.craftSuccessExpBase *
            Math.pow(LEVELING.craftSuccessExpRarityGrowth, rarity)
        )
    );
}

function getPlayerSlotCountForLevel(level) {
    level = Math.max(0, Math.floor(Number(level) || 0));

    return clamp(
        LEVELING.startSlots + Math.floor(level / LEVELING.levelsPerSlot),
        LEVELING.startSlots,
        LEVELING.maxSlots
    );
}

function getPlayerBaseMaxHpForLevel(level) {
    level = Math.max(0, Math.floor(Number(level) || 0));
    return LEVELING.maxHpBase * Math.pow(LEVELING.maxHpGrowth, level);
}

function getPlayerBodyDmgForLevel(level) {
    level = Math.max(0, Math.floor(Number(level) || 0));
    return LEVELING.bodyDmgBase * Math.pow(LEVELING.bodyDmgGrowth, level);
}

function getMultiPetalPositions(cx, cy, angle, type, rarity, slotIndex = 0, time = 0, ownerPlayer = null) {
    const amount = resolvePetalMultiCount(type, rarity);
    const clumps = resolvePetalClumps(type, rarity);

    // Default petal: still a multi petal, just one body.
    if (amount === 1) {
        let x = cx;
        let y = cy;

        // Apply wing flapping when extended
        if (type?.id === "wing" && ownerPlayer) {
            const t = performance.now() / 250;
            const isExtended = ownerPlayer.petalRadius > PETAL_EXTEND.baseRadius + 0.1;

            if (isExtended) {
                const flapOffset = Math.sin(t * 2.4) * 14;
                x = cx - Math.sin(angle) * flapOffset;
                y = cy + Math.cos(angle) * flapOffset;
            }
        }

        return [{
            x,
            y,
            index: 0,
            angle
        }];
    }

    const out = [];
    const r = getPetalRadius(type, rarity);

    // Spread multi, like light:
    // each subpetal gets its own virtual orbit slot.
    if (!clumps && ownerPlayer) {
        const { layout, total } = getPetalOrbitLayout(ownerPlayer);
        const info = layout[slotIndex];

        if (!info) {
            return [{
                x: cx,
                y: cy,
                index: 0,
                angle
            }];
        }

        for (let i = 0; i < amount; i++) {
            const virtualIndex = info.start + i;
            const isExtended = ownerPlayer.petalRadius > PETAL_EXTEND.baseRadius + 0.1;
            const p = getVirtualPetalPos(ownerPlayer, virtualIndex, total, type, isExtended);
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
    // all subpetals orbit around the parent slot.
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

function syncPetalBodies(player, slotIndex, petal, type) {
    if (!player || !petal || !type) return [];

    syncPetalMultiState(petal);

    const amount = resolvePetalMultiCount(type, petal.rarity);

    if (!Array.isArray(petal.multiBodies)) {
        petal.multiBodies = [];
    }

    while (petal.multiBodies.length < amount) {
        petal.multiBodies.push({
            x: player.x,
            y: player.y,
            vx: 0,
            vy: 0,
            index: petal.multiBodies.length,
            angle: 0
        });
    }

    petal.multiBodies.length = amount;

    for (let i = 0; i < amount; i++) {
        if (!petal.multiBodies[i]) {
            petal.multiBodies[i] = {
                x: player.x,
                y: player.y,
                vx: 0,
                vy: 0,
                index: i,
                angle: 0
            };
        }

        petal.multiBodies[i].index = i;

        if (!Number.isFinite(petal.multiBodies[i].x)) petal.multiBodies[i].x = player.x;
        if (!Number.isFinite(petal.multiBodies[i].y)) petal.multiBodies[i].y = player.y;
        if (!Number.isFinite(petal.multiBodies[i].vx)) petal.multiBodies[i].vx = 0;
        if (!Number.isFinite(petal.multiBodies[i].vy)) petal.multiBodies[i].vy = 0;
        if (!Number.isFinite(petal.multiBodies[i].angle)) petal.multiBodies[i].angle = 0;
    }

    return petal.multiBodies;
}

function getPetalBodyPositions(player, slotIndex, petal, type) {
    if (type?.noPetalBody) return [];
    const pos = player.petalSim?.[slotIndex];
    if (!pos || !petal || !type) return [];

    const bodies = syncPetalBodies(player, slotIndex, petal, type);

    // If dropped, these ARE the landmines now.
    // Do not recompute them from orbit.
    if (petal.dropped) {
        return bodies;
    }
    return bodies;
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
let MAX_MOBS = Math.max(100, Math.round(WORLD.w * WORLD.h * MOB_DENSITY * 0.5));
const PICKUP_LIFETIME = 15; // seconds

// range (in world pixels) within which mobs are considered "active" for
// updates.  Mobs outside this distance from every player are left sleeping
// to save CPU.  This value is squared once and used where appropriate.
const MOB_UPDATE_RANGE = 1000;
const MOB_UPDATE_RANGE2 = MOB_UPDATE_RANGE * MOB_UPDATE_RANGE;
const SUMMON_HARD_LEASH_RANGE = MOB_UPDATE_RANGE * 0.82;
const SUMMON_SOFT_LEASH_RANGE = MOB_UPDATE_RANGE * 0.65;

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

const PETAL_DROP = {
    lifetime: 3,

    // How far the petal glides when dropped.
    driftTime: 0.32,

    // How much of its current movement it keeps.
    inheritVelocity: 0.22,

    // Extra push away from the player.
    outwardImpulse: 85,

    // Tiny sideways wobble so multi petals don't stack perfectly.
    sideImpulse: 28,

    // Softer than normal orbit following.
    stiffness: 85,
    damping: 18
};

function clampDropTarget(x, y, radius = PETAL.radius) {
    return {
        x: clamp(x, radius, WORLD.w - radius),
        y: clamp(y, radius, WORLD.h - radius)
    };
}

function springBodyTo(body, target, dt, stiffness = PETAL_FOLLOW.stiffness, damping = PETAL_FOLLOW.damping) {
    if (!body || !target) return;

    const ax = (target.x - body.x) * stiffness - body.vx * damping;
    const ay = (target.y - body.y) * stiffness - body.vy * damping;

    body.vx += ax * dt;
    body.vy += ay * dt;

    body.x += body.vx * dt;
    body.y += body.vy * dt;

    body.angle = target.angle ?? body.angle ?? 0;
}

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

    return clamp(base - 2, 0, cap);
}

// Petal type definitions are loaded from staticdata.js

function resolvePetalMultiCount(type, rarity) {
    const r = clampPetalRarity(rarity);
    const multi = type?.multi;

    // Exact per-rarity amount.
    if (Array.isArray(multi)) {
        return clamp(
            (multi[r] ?? multi[multi.length - 1] ?? 1) | 0,
            1,
            32
        );
    }

    // Fixed amount.
    if (Number.isFinite(multi)) {
        return clamp(multi | 0, 1, 32);
    }

    // Every petal is still internally a multi petal.
    // It just has one body by default.
    return 1;
}

function resolvePetalClumps(type, rarity) {
    return !!type?.clumps && resolvePetalMultiCount(type, rarity) > 1;
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

    const amount = resolvePetalMultiCount(type, petal.rarity);

    // Clumped multis occupy one orbit slot.
    // Spread multis occupy one slot per subpetal.
    return resolvePetalClumps(type, petal.rarity) ? 1 : amount;
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

function getVirtualPetalPos(player, virtualIndex, totalVirtual, type = null, extended = false) {
    const a = getVirtualPetalAngle(player, virtualIndex, totalVirtual);

    let extraDistance = 0;
    let flapOffset = 0;

    if (type?.id === "wing") {
        const t = performance.now() / 250;
        const isExtended = extended || player?.petalRadius > PETAL_EXTEND.baseRadius + 0.1;

        if (isExtended) {
            extraDistance = Math.sin(t) * 16 + 72;
            flapOffset = Math.sin(t * 2.4) * 14;
        } else {
            extraDistance = 60;
        }
    }

    return {
        x: player.x + Math.cos(a) * (player.petalRadius + extraDistance) - Math.sin(a) * flapOffset,
        y: player.y + Math.sin(a) * (player.petalRadius + extraDistance) + Math.cos(a) * flapOffset,
        angle: a
    };
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
        const r = getPetalRadius(type, petal.rarity);

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

function getPetalReloadTime(type, rarity) {
    const base = Number.isFinite(type?.reload) ? type.reload : 1;
    const r = clampPetalRarity(rarity);

    // Exact per-rarity reloads:
    // reloadByRarity: [R0, R1, R2, ...]
    if (Array.isArray(type?.reloadByRarity)) {
        return Math.max(
            0,
            type.reloadByRarity[r] ?? type.reloadByRarity[type.reloadByRarity.length - 1] ?? base
        );
    }

    // Multiplies base reload by per-rarity values:
    // reloadScaling: [1, 0.9, 0.8, ...]
    if (Array.isArray(type?.reloadScaling)) {
        const mult = type.reloadScaling[r] ?? type.reloadScaling[type.reloadScaling.length - 1] ?? 1;
        return Math.max(0, base * mult);
    }

    // Simple exponential multiplier:
    // reloadScalePerRarity: 0.85 means each rarity makes reload 15% shorter
    if (Number.isFinite(type?.reloadScalePerRarity)) {
        return Math.max(0, base * Math.pow(type.reloadScalePerRarity, r));
    }

    // Old flag, still supported.
    if (type?.reloadHalvesByRarity) {
        return Math.max(0, base * Math.pow(0.5, r));
    }

    return Math.max(0, base);
}

function getPetalMaxHp(type, rarity) {
    const base = type?.maxHp ?? 1;

    if (type?.fixedMaxHp) {
        return base;
    }

    return base * petalStatScale(rarity);
}

function getPetalRadius(type, rarity) {
    const mult = Number.isFinite(type?.radius) ? type.radius : 1;
    return PETAL.radius * mult;
}

function syncPetalMultiState(petal) {
    if (!petal) return;

    const type = PetalTypes[petal.typeId];
    const amount = resolvePetalMultiCount(type, petal.rarity);

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

        petal.multiHp[i] = clamp(petal.multiHp[i], 0, petal.maxHp);
        petal.multiReloadLeft[i] = Math.max(0, petal.multiReloadLeft[i]);
    }

    petal.hp = petal.multiHp.reduce((sum, hp) => sum + Math.max(0, hp || 0), 0);
}

function petalMultiAliveCount(petal) {
    syncPetalMultiState(petal);

    let alive = 0;

    for (let i = 0; i < petal.multiHp.length; i++) {
        if ((petal.multiHp[i] ?? 0) > 0) alive++;
    }

    return alive;
}

// -------------------- Mob Types --------------------
const MobTypeList = Object.values(MobTypes);
// -------------------- Mob Object Types (projectiles, etc.) --------------------
let nextMobObjectId = 1;
const mobObjects = [];
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

function findNearestLightningBounce(mob, current, hit, range2) {
    let next = null;
    let bestD2 = range2;

    function scan(list) {
        for (let i = 0; i < list.length; i++) {
            const other = list[i];

            if (!other || other === mob || other === current) continue;
            if (hit.has(other.id)) continue;
            if (!canTakeDamage(other)) continue;
            if (!canDamageFaction(mob.faction, other.faction)) continue;

            const d2 = dist2(current.x, current.y, other.x, other.y);

            if (d2 < bestD2) {
                bestD2 = d2;
                next = other;
            }
        }
    }

    scan(playersArr);
    scan(mobsArr);

    return next;
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

        current = findNearestLightningBounce(
            mob,
            current,
            hit,
            cfg.range * cfg.range
        );
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
                if (!canDamageFaction(self.faction, other.faction)) continue;

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
        if (!canDamageFaction(summon.faction, mob.faction)) continue;

        const d2 = dist2(summon.x, summon.y, mob.x, mob.y);

        if (d2 < bestD2) {
            bestD2 = d2;
            best = mob;
        }
    }

    return best;
}
function getZoneAtPoint(x, y) {
    for (const zone of mobSpawnZones) {
        if (isPointInZone(x, y, zone)) {
            return zone;
        }
    }

    return null;
}

function spawnBloodSacrificeMobAt(x, y) {
    const fakeZone = getZoneAtPoint(x, y);
    if (!fakeZone) return false;

    const type = chooseMobType(fakeZone);
    const rarity = 7;

    if (!type || !canSpawnMobTypeRarity(type, rarity)) return false;

    const mob = new MobState(type, rarity);
    mob.x = clamp(x, mob.radius || MOB.radius, WORLD.w - (mob.radius || MOB.radius));
    mob.y = clamp(y, mob.radius || MOB.radius, WORLD.h - (mob.radius || MOB.radius));

    mobs.push(mob);
    return true;
}

function consumeBloodSacrificePetal(player) {
    if (!player || !Array.isArray(player.petals)) return false;

    for (let i = 0; i < player.petals.length; i++) {
        const petal = player.petals[i];
        if (!petal || petal.typeId !== "bloodSacrifice") continue;

        // Replace with basic so your code does not explode from null slots,
        // because apparently every array slot in this codebase is a sacred cow.
        player.petals[i] = new Petal("basic", 0);
        return true;
    }

    return false;
}

function tryBloodSacrificeOnDeath(player, deathX, deathY) {
    if (!player || !Array.isArray(player.petals)) return false;

    const hasBloodSacrifice = player.petals.some(p => p?.typeId === "bloodSacrifice");
    if (!hasBloodSacrifice) return false;

    const zone = getZoneAtPoint(deathX, deathY);
    if (!zone || (Number(zone.rarity) || 0) < 3.5) return false;

    const spawned = spawnBloodSacrificeMobAt(deathX, deathY);
    if (!spawned) return false;

    consumeBloodSacrificePetal(player);
    return true;
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

    // Parse map-level properties.
    map.biome = "garden";
    if (Array.isArray(map.properties)) {
        for (const prop of map.properties) {
            if (prop && prop.name === "biome") {
                const value = String(prop.value || "").trim().toLowerCase();
                if (value) {
                    map.biome = value;
                }
                break;
            }
        }
    }

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

function tryPlaceMobInOpenSpace(mob, candidateFn, maxTries = 40) {
    if (!mob || typeof candidateFn !== "function") return false;
    const radius = mob.radius || MOB.radius;
    let tries = 0;
    while (tries < maxTries && isWallAt(mob.x, mob.y)) {
        const candidate = candidateFn(tries);
        if (!candidate || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) break;
        mob.x = clamp(candidate.x, radius, WORLD.w - radius);
        mob.y = clamp(candidate.y, radius, WORLD.h - radius);
        tries++;
    }
    return !isWallAt(mob.x, mob.y);
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
    currentMapData = loadMap("maps/hel.tmj");
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

let nextPlayerId = 1;
let nextMobId = 1;
let nextPickupId = 1;

function killPetalSummon(petal) {
    if (!petal) return;

    const ids = [];

    if (petal.summonMobId != null) {
        ids.push(petal.summonMobId);
    }

    if (Array.isArray(petal.summonMobIds)) {
        for (const id of petal.summonMobIds) {
            if (id != null) ids.push(id);
        }
    }

    for (const id of ids) {
        const summon = mobById.get(id);

        if (summon && summon.hp > 0) {
            summon.hp = 0;
        }
    }

    petal.summonMobId = null;
    petal.summonMobIds = [];
}

function killPlayerSummons(player) {
    if (!player) return;

    // Kill summons linked directly from equipped petals.
    if (Array.isArray(player.petals)) {
        for (const petal of player.petals) {
            killPetalSummon(petal);
        }
    }

    // Just in case a summon somehow belongs to a secondary petal too.
    if (Array.isArray(player.secondaryPetals)) {
        for (const petal of player.secondaryPetals) {
            killPetalSummon(petal);
        }
    }

    // Backup cleanup: kill any living petal summon owned by this player,
    // even if the petal link got weird.
    for (let i = mobs.length - 1; i >= 0; i--) {
        const mob = mobs[i];

        if (!mob) continue;
        if (!mob.isPetalSummon) continue;
        if (mob.ownerPlayerId !== player.id) continue;
        if (mob.hp <= 0) continue;

        mob.hp = 0;
    }
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
        this.maxHp = getPetalMaxHp(t, this.rarity);
        this.hp = this.maxHp;

        this.multiHp = [];
        this.multiHitCd = [];
        this.multiDamageCd = [];
        this.multiReloadLeft = [];
        syncPetalMultiState(this);

        this.reloadTime = getPetalReloadTime(t, this.rarity);
        this.reloadLeft = 0;

        this.dropped = false;
        this.dropX = 0;
        this.dropY = 0;

        this.dropAge = 0;
        this.dropSettleTime = 0.75;
        this.dropTargets = [];

        this.multiBodies = [];

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

        this.dropAge = 0;
        this.dropTargets = [];

        this.multiBodies = [];
    }

    forceReloadSub(subIndex = 0) {
        syncPetalMultiState(this);

        subIndex = clamp(subIndex | 0, 0, this.multiHp.length - 1);

        this.multiHp[subIndex] = 0;
        this.multiHitCd[subIndex] = 0;
        this.multiDamageCd[subIndex] = 0;
        this.multiReloadLeft[subIndex] = this.reloadTime;

        this.hp = this.multiHp.reduce((sum, hp) => {
            return sum + Math.max(0, hp || 0);
        }, 0);

        this.reloadLeft = this.multiReloadLeft.reduce((best, t) => {
            if (t > 0 && t < best) return t;
            return best;
        }, Infinity);

        if (this.reloadLeft === Infinity) {
            this.reloadLeft = 0;
        }
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

        const type = PetalTypes[this.typeId];

        if (type?.hps && anyAlive) {
            const scale = petalStatScale(this.rarity);
            const healPerSecond = type.hps * scale;

            ownerPlayer.hp = clamp(
                ownerPlayer.hp + healPerSecond * dt,
                0,
                ownerPlayer.maxHp
            );
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

function getPlayerPetalSpeedMultiplier(player) {
    if (!player || !Array.isArray(player.petals)) return 1;

    let bonus = 0;

    for (const petal of player.petals) {
        if (!petal || !petal.isAlive()) continue;

        const type = PetalTypes[petal.typeId];
        if (!type) continue;

        const base = type.petalSpeedBonus ?? 0;
        const perRarity = type.petalSpeedBonusPerRarity ?? 0;

        bonus += base + perRarity * clampPetalRarity(petal.rarity ?? 0);
    }

    return Math.max(0.1, 1 + bonus);
}

function getPlayerMaxHpBonus(player) {
    if (!player || !Array.isArray(player.petals)) return 0;

    let bonus = 0;

    for (let slotIndex = 0; slotIndex < player.petals.length; slotIndex++) {
        const petal = player.petals[slotIndex];
        if (!petal) continue;
        if (isPetalSlotStackDisabled(player, slotIndex)) continue;

        const type = PetalTypes[petal.typeId];
        if (!type) continue;

        const base = type.maxHpBonus ?? 0;
        if (base <= 0) continue;

        const scale = petalStatScale(petal.rarity ?? 0);
        bonus += base * scale;
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

function popBubblePetals(player) {
    if (!player || !Array.isArray(player.petals)) return false;

    let poppedAny = false;

    const orbitData = getPetalOrbitLayout(player);

    for (let slotIndex = 0; slotIndex < player.petals.length; slotIndex++) {
        const petal = player.petals[slotIndex];
        if (!petal || petal.disabledByStack) continue;

        const type = PetalTypes[petal.typeId];
        if (!type?.rightClickPop) continue;
        if (!petal.isAlive()) continue;
        if (isPetalSlotStackDisabled(player, slotIndex)) continue;

        const info = orbitData.layout[slotIndex];
        if (!info) continue;

        // Direction from player to this petal in orbit.
        const orbitAngle = getVirtualPetalAngle(player, info.start, orbitData.total);

        const rarity = clampPetalRarity(petal.rarity ?? 0);
        const impulse =
            (type.popImpulse ?? 420) +
            (type.popImpulsePerRarity ?? 0) * rarity;

        // Opposite direction of where the petal is.
        player.bubblePushVx = (player.bubblePushVx || 0) - Math.cos(orbitAngle) * impulse;
        player.bubblePushVy = (player.bubblePushVy || 0) - Math.sin(orbitAngle) * impulse;

        // Keep inside world.
        player.x = clamp(player.x, PLAYER.radius, WORLD.w - PLAYER.radius);
        player.y = clamp(player.y, PLAYER.radius, WORLD.h - PLAYER.radius);

        // Bubble pop reloads the whole bubble slot.
        petal.forceReload();

        poppedAny = true;
    }

    return poppedAny;
}

function buildPlayerPetalCollisionCache(player) {
    const cache = [];

    for (let i = 0; i < player.petals.length; i++) {
        const petal = player.petals[i];

        if (!petal || petal.disabledByStack || !petal.isAlive()) {
            cache[i] = null;
            continue;
        }

        const type = PetalTypes[petal.typeId];
        if (!type) {
            cache[i] = null;
            continue;
        }

        const bodies = getPetalBodyPositions(player, i, petal, type);
        const radius = getPetalRadius(type, petal.rarity);

        cache[i] = {
            petal,
            type,
            bodies,
            radius,
            dropped: !!petal.dropped
        };
    }

    return cache;
}

class PlayerState {
    constructor(id) {
        this.id = id;

        const sp = getRandomSpawnPoint();
        this.x = sp.x;
        this.y = sp.y;
        this.vx = 0;
        this.vy = 0;

        this.radius = PLAYER.radius;

        this.faction = FACTION.PLAYER;

        this.level = 0;
        this.exp = 0;
        this.expToNext = getExpRequiredForNextLevel(this.level);

        this.slotCount = getPlayerSlotCountForLevel(this.level);

        this.baseMaxHp = getPlayerBaseMaxHpForLevel(this.level);
        this.bodyDmg = getPlayerBodyDmgForLevel(this.level);

        this.maxHp = this.baseMaxHp;
        this.hp = this.maxHp;

        this.angleBase = randf(0, Math.PI * 2);

        this.input = {
            up: false,
            down: false,
            left: false,
            right: false,
            extend: false,
            retract: false,

            mouseMove: false,
            mouseX: 0,
            mouseY: 0
        };

        this.wasRetracting = false;

        this.godMode = false;

        // inventory stores TYPE IDs (strings)
        this.inv = [];

        // initial loadout random for now
        this.petals = Array.from({ length: this.slotCount }, () => new Petal("basic", 0));
        this.secondaryPetals = Array.from({ length: this.slotCount }, () => new Petal("basic", 0));

        // inventory stores TYPE IDs (strings)
        this.inv = [];

        this.petalRadius = PETAL_EXTEND.baseRadius;
        this.petalRadiusTarget = PETAL_EXTEND.baseRadius;

        this.time = 0;

        this.petalWobble = Array.from({ length: this.slotCount }, () => this.makePetalWobble());
        this.petalSim = Array.from({ length: this.slotCount }, () => ({ x: 0, y: 0, vx: 0, vy: 0 }));

        this.snapPetalsToTargets();
    }

    makePetalWobble() {
        return {
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
        };
    }

    syncSlotCount() {
        const wanted = getPlayerSlotCountForLevel(this.level);
        this.slotCount = wanted;

        while (this.petals.length < wanted) {
            this.petals.push(new Petal("basic", 0));
        }

        while (this.secondaryPetals.length < wanted) {
            this.secondaryPetals.push(new Petal("basic", 0));
        }

        while (this.petalWobble.length < wanted) {
            this.petalWobble.push(this.makePetalWobble());
        }

        while (this.petalSim.length < wanted) {
            this.petalSim.push({ x: this.x, y: this.y, vx: 0, vy: 0 });
        }

        // Only matters if you manually lower level in dev tools.
        while (this.petals.length > wanted) {
            const petal = this.petals.pop();
            if (petal) {
                killPetalSummon(petal);
                this.inv.push({ typeId: petal.typeId, rarity: petal.rarity });
            }
        }

        while (this.secondaryPetals.length > wanted) {
            const petal = this.secondaryPetals.pop();
            if (petal) {
                killPetalSummon(petal);
                this.inv.push({ typeId: petal.typeId, rarity: petal.rarity });
            }
        }

        this.petalWobble.length = wanted;
        this.petalSim.length = wanted;
    }

    syncLevelStats() {
        const oldMaxHp = this.maxHp;

        this.level = clamp(
            Math.floor(Number(this.level) || 0),
            0,
            LEVELING.maxLevel
        );
        this.baseMaxHp = getPlayerBaseMaxHpForLevel(this.level);
        this.bodyDmg = getPlayerBodyDmgForLevel(this.level);

        this.syncSlotCount();

        this.maxHp = this.baseMaxHp + getPlayerMaxHpBonus(this);

        if (this.maxHp > oldMaxHp) {
            this.hp += this.maxHp - oldMaxHp;
        }

        this.hp = clamp(this.hp, 0, this.maxHp);
        this.expToNext = getExpRequiredForNextLevel(this.level);
    }

    setLevel(level) {
        this.level = clamp(
            Math.floor(Number(level) || 0),
            0,
            LEVELING.maxLevel
        );

        if (this.level >= LEVELING.maxLevel) {
            this.exp = 0;
        } else {
            this.exp = clamp(
                Number(this.exp) || 0,
                0,
                getExpRequiredForNextLevel(this.level) - 1
            );
        }

        this.syncLevelStats();
        this.snapPetalsToTargets();
    }

    addLevels(amount = 1) {
        this.setLevel(this.level + Math.max(0, Math.floor(Number(amount) || 0)));
    }

    addExp(amount) {
        amount = Math.max(0, Math.floor(Number(amount) || 0));

        if (this.level >= LEVELING.maxLevel) {
            this.level = LEVELING.maxLevel;
            this.exp = 0;
            this.expToNext = 0;

            return {
                expGained: 0,
                levelsGained: 0,
                level: this.level,
                exp: this.exp,
                expToNext: this.expToNext
            };
        }

        if (amount <= 0) {
            return {
                expGained: 0,
                levelsGained: 0,
                level: this.level,
                exp: this.exp,
                expToNext: this.expToNext
            };
        }

        this.exp = Math.max(0, Number(this.exp) || 0) + amount;

        let levelsGained = 0;

        while (
            this.level < LEVELING.maxLevel &&
            this.exp >= getExpRequiredForNextLevel(this.level)
        ) {
            const needed = getExpRequiredForNextLevel(this.level);

            this.exp -= needed;
            this.level++;
            levelsGained++;

            if (levelsGained > LEVELING.maxLevel + 5) break;
        }

        if (this.level >= LEVELING.maxLevel) {
            this.level = LEVELING.maxLevel;
            this.exp = 0;
            this.expToNext = 0;
        } else if (levelsGained > 0) {
            this.syncLevelStats();
            this.snapPetalsToTargets();
        } else {
            this.expToNext = getExpRequiredForNextLevel(this.level);
        }

        return {
            expGained: amount,
            levelsGained,
            level: this.level,
            exp: this.exp,
            expToNext: this.expToNext
        };
    }

    refreshPetalStackDisabledCache() {
        if (!this._stackDisabled || this._stackDisabled.length !== this.petals.length) {
            this._stackDisabled = new Array(this.petals.length).fill(false);
        }

        const seenUnstackable = new Set();

        for (let i = 0; i < this.petals.length; i++) {
            const petal = this.petals[i];
            let disabled = false;

            if (petal) {
                const type = PetalTypes[petal.typeId];

                if (type?.unstackable) {
                    if (seenUnstackable.has(petal.typeId)) {
                        disabled = true;
                    } else {
                        seenUnstackable.add(petal.typeId);
                    }
                }
            }

            this._stackDisabled[i] = disabled;

            if (petal) {
                petal.disabledByStack = disabled;
            }
        }
    }

    isSlotStackDisabledFast(slotIndex) {
        return !!this._stackDisabled?.[slotIndex];
    }

    update(dt) {
        let ix = (this.input.right ? 1 : 0) - (this.input.left ? 1 : 0);
        let iy = (this.input.down ? 1 : 0) - (this.input.up ? 1 : 0);

        this.syncLevelStats();
        this.refreshPetalStackDisabledCache();

        const speed = this.godMode ? PLAYER.speed * 10 : PLAYER.speed;

        // Mouse movement only takes over if no WASD key is being held.
        // So WASD still works and can override mouse movement instantly.
        if (ix === 0 && iy === 0 && this.input.mouseMove) {
            const mx = Number(this.input.mouseX);
            const my = Number(this.input.mouseY);

            if (Number.isFinite(mx) && Number.isFinite(my)) {
                const dx = mx - this.x;
                const dy = my - this.y;
                const d = Math.hypot(dx, dy);

                // Deadzone prevents jitter when the mouse is basically on top of you.
                if (d > 8) {
                    ix = dx / d;
                    iy = dy / d;
                }
            }
        }

        if (ix === 0 && iy === 0) {
            this.vx = 0;
            this.vy = 0;
        } else {
            const invLen = 1 / (Math.hypot(ix, iy) || 1);
            this.vx = ix * invLen * speed;
            this.vy = iy * invLen * speed;
        }

        const retractPressed = !!this.input.retract;

        if (retractPressed) {
            popBubblePetals(this);

            // Droppable petals should still only drop once per press.
            if (!this.wasRetracting) {
                this.dropDroppablePetals();
            }
        }

        this.wasRetracting = retractPressed;

        // attempt move with wall collision
        if (this.bubblePushVx || this.bubblePushVy) {
            this.vx += this.bubblePushVx || 0;
            this.vy += this.bubblePushVy || 0;

            const decay = Math.exp(-10 * dt);
            this.bubblePushVx *= decay;
            this.bubblePushVy *= decay;

            if (Math.abs(this.bubblePushVx) < 1) this.bubblePushVx = 0;
            if (Math.abs(this.bubblePushVy) < 1) this.bubblePushVy = 0;
        }

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
        const petalSpeedMult = getPlayerPetalSpeedMultiplier(this);

        this.angleBase += PETAL.orbitSpeed * petalSpeedMult * rotationDir * dt;

        for (let i = 0; i < this.petals.length; i++) {
            const p = this.petals[i];
            if (!p) continue;

            if (this.isSlotStackDisabledFast(i)) {
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
        const orbitData = getPetalOrbitLayout(this);
        for (let i = 0; i < this.petals.length; i++) {
            const petal = this.petals[i];

            if (petal && this.isSlotStackDisabledFast(i)) {
                petal.disabledByStack = true;

                const s = this.petalSim[i];
                s.x = this.x;
                s.y = this.y;
                s.vx = 0;
                s.vy = 0;

                continue;
            }

            if (petal?.dropped) {
                const type = PetalTypes[petal.typeId];

                syncPetalMultiState(petal);

                if (!Array.isArray(petal.multiBodies)) {
                    petal.multiBodies = [];
                }

                const amount = resolvePetalMultiCount(type, petal.rarity);

                while (petal.multiBodies.length < amount) {
                    const target = petal.dropTargets?.[petal.multiBodies.length];
                    petal.multiBodies.push({
                        x: target?.x ?? petal.dropX ?? this.x,
                        y: target?.y ?? petal.dropY ?? this.y,
                        vx: 0,
                        vy: 0,
                        index: petal.multiBodies.length,
                        angle: target?.angle ?? 0
                    });
                }

                petal.multiBodies.length = amount;

                const bodies = petal.multiBodies;

                petal.dropAge = (petal.dropAge ?? 0) + dt;

                if (petal.dropAge >= PETAL_DROP.lifetime) {
                    petal.forceReload();
                    continue;
                }

                for (let j = 0; j < bodies.length; j++) {
                    const body = bodies[j];
                    const target = petal.dropTargets?.[j];

                    if (!target) continue;

                    // Always spring toward the resting point.
                    // Never hard-snap, because snapping is the enemy of looking alive.
                    springBodyTo(
                        body,
                        target,
                        dt,
                        PETAL_DROP.stiffness,
                        PETAL_DROP.damping
                    );

                    const radius = getPetalRadius(type, petal.rarity);

                    body.x = clamp(body.x, radius, WORLD.w - radius);
                    body.y = clamp(body.y, radius, WORLD.h - radius);

                    if (isWallAt(body.x, body.y)) {
                        body.x = target.x;
                        body.y = target.y;
                        body.vx = 0;
                        body.vy = 0;
                    }

                    body.angle = target.angle ?? body.angle ?? 0;
                }

                const first = bodies[0];

                const s = this.petalSim[i];
                s.x = first?.x ?? petal.dropX;
                s.y = first?.y ?? petal.dropY;
                s.vx = 0;
                s.vy = 0;

                petal.dropX = s.x;
                petal.dropY = s.y;

                continue;
            }

            const base = this.getPetalTargetWorldPos(i, orbitData);
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

            this.updateOrbitingMultiBodies(i, petal, dt);
        }
    }

    updateOrbitingMultiBodies(slotIndex, petal, dt) {
        if (!petal || petal.dropped || petal.disabledByStack) return;

        const type = PetalTypes[petal.typeId];
        if (!type) return;

        const pos = this.petalSim?.[slotIndex];
        if (!pos) return;

        const bodies = syncPetalBodies(this, slotIndex, petal, type);
        const amount = resolvePetalMultiCount(type, petal.rarity);

        const petalAngle = Math.atan2(pos.y - this.y, pos.x - this.x) || 0;


        const targets = getMultiPetalPositions(
            pos.x,
            pos.y,
            petalAngle,
            type,
            petal.rarity,
            slotIndex,
            this.time,
            this,
        );

        for (let i = 0; i < bodies.length; i++) {
            const body = bodies[i];
            const target = targets[i] ?? targets[0] ?? pos;

            let flapOffset = 0;
            if (petal.typeId === "wing" && this.input.extend) {
                flapOffset = 10 + 5 * Math.sin(this.time * 10 + i);
            }

            if (amount === 1) {
                body.x = pos.x - Math.sin(petalAngle) * flapOffset;
                body.y = pos.y + Math.cos(petalAngle) * flapOffset;
                body.vx = this.petalSim[slotIndex].vx ?? 0;
                body.vy = this.petalSim[slotIndex].vy ?? 0;
                body.angle = petalAngle;
                continue;
            }

            springBodyTo(body, target, dt);
        }
    }

    getPetalTargetWorldPos(i, orbitData = null) {
        const { layout, total } = orbitData ?? getPetalOrbitLayout(this);
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

        const maxQueryRange = 260 + lentilBonus * 180;

        forEachMobNearPetal(tx, ty, maxQueryRange, (mob) => {
            if (!mob || mob.hp <= 0) return;

            const mobRangeBonus = mob.radius * (1.8 + lentilBonus * 10);
            const attractRange = 95 + mobRangeBonus;

            const dx = mob.x - tx;
            const dy = mob.y - ty;
            const d2 = dx * dx + dy * dy;

            if (d2 < attractRange * attractRange && d2 < bestD2) {
                bestD2 = d2;
                best = mob;
            }
        });

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
        for (let i = 0; i < this.petals.length; i++) {
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

        let expInfo = null;
        let expGained = 0;

        if (success) {
            this.addToInventory(typeId, targetRarity);

            expGained = getCraftSuccessExp(targetRarity);
            expInfo = this.addExp(expGained);
        }

        return {
            ok: true,
            success,
            typeId,
            rarity,
            targetRarity,
            chance,
            expGained,
            level: this.level,
            exp: this.exp,
            expToNext: this.expToNext,
            levelsGained: expInfo?.levelsGained ?? 0,
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
        const expGained = results.reduce((sum, r) => sum + (r.expGained || 0), 0);
        const levelsGained = results.reduce((sum, r) => sum + (r.levelsGained || 0), 0);

        return {
            ok: attempts > 0,
            typeId,
            rarity,
            attempts,
            successes,
            failures,
            expGained,
            levelsGained,
            level: this.level,
            exp: this.exp,
            expToNext: this.expToNext,
            message: attempts > 0
                ? `Crafted all: ${attempts} attempts, ${successes} succeeded, ${failures} failed. +${expGained} exp.`
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

        if (!Array.isArray(this.secondaryPetals) || this.secondaryPetals.length !== n) {
            this.secondaryPetals = Array.from({ length: n }, () => new Petal("basic", 0));
        }

        if (!this.secondaryPetals[i]) return false;

        const oldPrimary = this.petals[i];
        const oldSecondary = this.secondaryPetals[i];

        // Kill only the summon spawned by the petal leaving primary.
        killPetalSummon(oldPrimary);

        this.petals[i] = oldSecondary;
        this.secondaryPetals[i] = oldPrimary;

        // Reload newly equipped primary so swapping isn't free instant cheese.
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
            const oldSecondary = this.secondaryPetals[i];

            // Kill the summon spawned by the petal being removed from primary.
            // This only kills oldPrimary.summonMobId, not every summon.
            killPetalSummon(oldPrimary);

            this.petals[i] = oldSecondary;
            this.secondaryPetals[i] = oldPrimary;

            // Reload newly equipped primary so swapping is not free instant cheese.
            this.petals[i].forceReloadAndKillSummon();
        }

        return true;
    }

    dropDroppablePetals() {
        for (let i = 0; i < this.petals.length; i++) {
            const petal = this.petals[i];
            if (!petal || !petal.isAlive()) continue;
            if (this.isSlotStackDisabledFast(i)) continue;

            const type = PetalTypes[petal.typeId];
            if (!type?.isDroppable) continue;
            if (petal.dropped) continue;

            syncPetalMultiState(petal);

            // Get exact current positions BEFORE dropped mode.
            // This works for clumped and spread petals.
            const bodies = getPetalBodyPositions(this, i, petal, type);

            if (!Array.isArray(bodies) || bodies.length <= 0) continue;

            // Snapshot the bodies directly.
            // Do not rely on later orbit layout recalculation.
            petal.multiBodies = bodies.map((body, j) => ({
                x: body.x,
                y: body.y,
                vx: Number.isFinite(body.vx) ? body.vx : 0,
                vy: Number.isFinite(body.vy) ? body.vy : 0,
                index: j,
                angle: body.angle ?? 0
            }));

            petal.dropTargets = petal.multiBodies.map((body, j) => {
                const dx = body.x - this.x;
                const dy = body.y - this.y;
                const d = Math.hypot(dx, dy) || 1;

                const nx = dx / d;
                const ny = dy / d;

                // Perpendicular direction, used for tiny spread.
                const px = -ny;
                const py = nx;

                const side = ((j % 2) ? -1 : 1) * (1 + Math.floor(j / 2) * 0.35);

                const vx =
                    (Number.isFinite(body.vx) ? body.vx : 0) * PETAL_DROP.inheritVelocity +
                    nx * PETAL_DROP.outwardImpulse +
                    px * PETAL_DROP.sideImpulse * side;

                const vy =
                    (Number.isFinite(body.vy) ? body.vy : 0) * PETAL_DROP.inheritVelocity +
                    ny * PETAL_DROP.outwardImpulse +
                    py * PETAL_DROP.sideImpulse * side;

                body.vx = vx;
                body.vy = vy;

                const target = clampDropTarget(
                    body.x + vx * PETAL_DROP.driftTime,
                    body.y + vy * PETAL_DROP.driftTime,
                    getPetalRadius(type, petal.rarity)
                );

                return {
                    x: target.x,
                    y: target.y,
                    angle: body.angle ?? 0
                };
            });

            petal.dropped = true;
            petal.dropAge = 0;
            petal.dropSettleTime = PETAL_DROP.driftTime;

            petal.dropX = petal.dropTargets[0]?.x ?? this.petalSim[i].x;
            petal.dropY = petal.dropTargets[0]?.y ?? this.petalSim[i].y;

            const s = this.petalSim[i];
            s.x = petal.dropX;
            s.y = petal.dropY;
            s.vx = 0;
            s.vy = 0;
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

function getEntityMass(ent) {
    if (!ent) return 1;

    // Players should barely push mobs back.
    // Lower = player gets shoved more, mob barely moves.
    if (ent instanceof PlayerState) return 0.03;

    return Number.isFinite(ent.mass) ? ent.mass : 1;
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

    const massA = getEntityMass(a);
    const massB = getEntityMass(b);
    const totalMass = Math.max(0.0001, massA + massB);

    // Lighter thing moves more. Heavy thing barely moves.
    const pushA = overlap * (massB / totalMass);
    const pushB = overlap * (massA / totalMass);

    const ax0 = a.x, ay0 = a.y;
    const bx0 = b.x, by0 = b.y;

    moveWithWalls(a, nx * pushA, ny * pushA, ra);
    moveWithWalls(b, -nx * pushB, -ny * pushB, rb);

    const aMoved = (a.x !== ax0) || (a.y !== ay0);
    const bMoved = (b.x !== bx0) || (b.y !== by0);

    if (aMoved && bMoved) return true;

    // Revert and retry one-sided if one body got blocked.
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

    return false;
}

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

IdleTypes.wanderSineFast = (mob, dt) => {
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

    setMobDesiredMove(mob, angle, mob.idleSpeed * 3);
};

IdleTypes.wanderSineSlow = (mob, dt) => {
    mob.wanderT -= dt;

    if (mob.wanderT <= 0) {
        mob.wanderT = randf(mob.wanderTMin, mob.wanderTMax);

        const turnAmount = randf(-Math.PI * 0.65, Math.PI * 0.65);
        mob.wanderDir = wrapAngle((mob.wanderDir ?? mob.angle ?? 0) + turnAmount);
    }

    mob._idleWaveT = (mob._idleWaveT ?? 0) + dt;

    const freqHz = mob.idleWaveFreq ?? 0.75;
    const ampRad = mob.idleWaveAmp ?? 0.22;

    const wobble = Math.sin(mob._idleWaveT * freqHz * 0.5 * Math.PI * 2) * ampRad;
    const angle = mob.wanderDir + wobble;

    setMobDesiredMove(mob, angle, mob.idleSpeed / 2);
};

IdleTypes.spin = (mob, dt) => {
    mob.angle += .02;
    setMobDesiredMove(mob, mob.angle, mob.idleSpeed / 10);
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
        this.smashCd = 0;

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
                if (!t || t.hp <= 0 || !canDamageFaction(this.faction, t.faction)) {
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

        if (this.type === "elephant") {
            this.smashCd = Math.max(0, this.smashCd - dt);
            if (target && target.hp > 0) {
                const dx = target.x - this.x;
                const dy = target.y - this.y;
                const dist2 = dx * dx + dy * dy;
                const stompRange = this.stompRange ?? this.radius * 1.4;
                if (this.smashCd <= 0 && dist2 <= stompRange * stompRange) {
                    const stompDmg = Math.round((this.dmg || 30) * (this.stompDamageMult ?? 1.35));
                    applyEntityDamage(target, stompDmg, this);
                    this.smashCd = this.stompCd ?? 3.0;
                }
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
// -------------------- Chat --------------------
const CHAT = {
    maxLen: 140,
    historyMax: 40,
    cooldown: 0.55
};

let nextChatId = 1;
const chatHistory = [];

function cleanChatText(value) {
    return String(value ?? "")
        .replace(/[\r\n\t]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, CHAT.maxLen);
}

function addChatMessage(player, text) {
    const msg = {
        t: "chat",
        id: nextChatId++,
        playerId: player.id,
        name: `Player ${player.id}`,
        text,
        time: Date.now()
    };

    chatHistory.push(msg);
    while (chatHistory.length > CHAT.historyMax) chatHistory.shift();

    broadcast(msg);
}

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

    if (!tryPlaceMobInOpenSpace(m, () => randomPointInPolygon(zone.polygon, zone.offsetX, zone.offsetY))) {
        return false;
    }

    mobs.push(m);

    if (type.id === "centipede" || type.id === "milipede" || type.id === "centipedeDesert" || type.id === "centipede_hel") {
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
            for (let segTries = 0; segTries < 12 && (!isPointInZone(seg.x, seg.y, zone) || isWallAt(seg.x, seg.y)); segTries++) {
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

            const mob = new MobState(type, rarity);
            mob.x = randf(mob.radius || MOB.radius, WORLD.w - (mob.radius || MOB.radius));
            mob.y = randf(mob.radius || MOB.radius, WORLD.h - (mob.radius || MOB.radius));

            if (!tryPlaceMobInOpenSpace(mob, () => ({
                x: randf(mob.radius || MOB.radius, WORLD.w - (mob.radius || MOB.radius)),
                y: randf(mob.radius || MOB.radius, WORLD.h - (mob.radius || MOB.radius))
            }), 24)) {
                continue;
            }

            mobs.push(mob);
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

    if (!tryPlaceMobInOpenSpace(fly, () => {
        const a = Math.random() * Math.PI * 2;
        const d = 40 + Math.random() * 20;
        return {
            x: garbageX + Math.cos(a) * d,
            y: garbageY + Math.sin(a) * d
        };
    })) {
        return;
    }

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
        radius: p.radius,
        lookAngle: Math.atan2(
            Number.isFinite(p.input?.mouseY) ? p.input.mouseY - p.y : 0,
            Number.isFinite(p.input?.mouseX) ? p.input.mouseX - p.x : 1
        ),
        hp: p.hp,
        maxHp: p.maxHp,
        level: p.level,
        exp: p.exp,
        expToNext: p.expToNext,
        slotCount: p.slotCount,
        bodyDmg: p.bodyDmg,
        angleBase: p.angleBase,
        petalRadius: p.petalRadius,
        petals: p.petals.map((petal, i) => {
            const type = PetalTypes[petal.typeId];
            const pos = p.petalSim?.[i] ?? { x: p.x, y: p.y };
            const angle = Math.atan2(pos.y - p.y, pos.x - p.x);

            syncPetalMultiState(petal);

            const multiAmount = Math.max(1, resolvePetalMultiCount(type, petal.rarity));
            const totalMaxHp = petal.maxHp * multiAmount;

            return {
                multiBodies: Array.isArray(petal.multiBodies)
                    ? petal.multiBodies.map(body => ({
                        x: body.x,
                        y: body.y,
                        index: body.index ?? 0,
                        angle: body.angle ?? 0
                    }))
                    : [],

                typeId: petal.typeId,
                rarity: petal.rarity,
                hp: petal.hp,
                maxHp: totalMaxHp,
                reloadLeft: petal.reloadLeft,
                reloadTime: petal.reloadTime,
                label: type?.label ?? petal.typeId,
                angle,
                spinAngle: getPetalSpinAngle(i, 0, p.time, type, petal.rarity),

                multi: multiAmount,
                clumps: !!type?.clumps,
                splitMultiDamage: !!type?.splitMultiDamage,

                multiPetalRadius: getPetalRadius(type, petal.rarity),

                multiPetalPos: (
                    Array.isArray(petal.multiBodies) && petal.multiBodies.length > 0
                        ? petal.multiBodies
                        : getMultiPetalPositions(
                            pos.x,
                            pos.y,
                            angle,
                            type,
                            petal.rarity,
                            i,
                            p.time,
                            p
                        )
                ).map(mp => {
                    const subIndex = mp.index ?? 0;

                    return {
                        ...mp,
                        angle: mp.angle ?? angle,

                        spinAngle: getPetalSpinAngle(i, subIndex, p.time, type, petal.rarity),
                        hp: petal.multiHp[subIndex] ?? petal.maxHp,
                        maxHp: petal.maxHp,
                        label: type?.label ?? petal.typeId,
                        alive: (petal.multiHp[subIndex] ?? petal.maxHp) > 0,
                        reloadLeft: petal.multiReloadLeft?.[subIndex] ?? 0,
                        reloadTime: petal.reloadTime,
                        dropped: !!petal.dropped,
                        dropX: petal.dropX,
                        dropY: petal.dropY,
                    };
                }),

                light: type?.light ?? null
            };
        }),
        secondaryPetals: p.secondaryPetals.map(petal => {
            const type = PetalTypes[petal.typeId];

            syncPetalMultiState(petal);

            const multiAmount = Math.max(1, resolvePetalMultiCount(type, petal.rarity));
            const totalMaxHp = petal.maxHp * multiAmount;

            return {
                typeId: petal.typeId,
                label: type?.label ?? petal.typeId,
                rarity: petal.rarity,
                hp: petal.hp,
                maxHp: totalMaxHp,
                reloadLeft: petal.reloadLeft,
                reloadTime: petal.reloadTime
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

const PETAL_ATTRACT_CELL = 180;
let petalAttractGrid = new Map();

function buildMobGridForPetals(mobsArr, isActive, cellSize) {
    const grid = new Map();

    for (let i = 0; i < mobsArr.length; i++) {
        if (isActive && !isActive[i]) continue;

        const mob = mobsArr[i];
        if (!mob || mob.hp <= 0) continue;

        const cx = toCell(mob.x, cellSize);
        const cy = toCell(mob.y, cellSize);
        const key = gridKey(cx, cy);

        let bucket = grid.get(key);
        if (!bucket) grid.set(key, bucket = []);

        bucket.push(mob);
    }

    return grid;
}

function forEachMobNearPetal(x, y, range, fn) {
    const grid = petalAttractGrid;
    if (!grid || grid.size === 0) return;

    const cellSize = PETAL_ATTRACT_CELL;
    const cx = toCell(x, cellSize);
    const cy = toCell(y, cellSize);
    const cr = ((range / cellSize) | 0) + 1;

    for (let yy = -cr; yy <= cr; yy++) {
        for (let xx = -cr; xx <= cr; xx++) {
            const bucket = grid.get(gridKey(cx + xx, cy + yy));
            if (!bucket) continue;

            for (let i = 0; i < bucket.length; i++) {
                fn(bucket[i]);
            }
        }
    }
}

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

    const expPlayer =
        opts.expPlayer ??
        (
            source &&
                source.id != null &&
                players?.has?.(source.id)
                ? source
                : null
        ) ??
        (
            source?.isPetalSummon && source.ownerPlayerId != null
                ? players.get(source.ownerPlayerId)
                : null
        );

    if (expPlayer && target.type !== undefined) {
        target.lastHitPlayerId = expPlayer.id;
    }

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

    if (!tryPlaceMobInOpenSpace(mob, () => {
        const a = randf(0, Math.PI * 2);
        const d = randf(sourceMob.radius || MOB.radius, (sourceMob.radius || MOB.radius) + spread * 2);
        return {
            x: sourceMob.x + Math.cos(a) * d,
            y: sourceMob.y + Math.sin(a) * d
        };
    }, 24)) {
        return null;
    }

    mobs.push(mob);
    mobById.set(mob.id, mob);

    return mob;
}

function spawnFriendlyMobFromPetal(player, petal, slotIndex, subIndex = 0, posOverride = null) {
    if (!player || !petal) return null;

    const petalType = PetalTypes[petal.typeId];
    if (!petalType?.deathSummonType) return null;

    syncPetalMultiState(petal);

    subIndex = clamp(subIndex | 0, 0, petal.multiHp.length - 1);

    if (!Array.isArray(petal.summonMobIds)) {
        petal.summonMobIds = [];
    }

    // One summon per subpetal.
    const oldId = petal.summonMobIds[subIndex];

    if (oldId != null) {
        const existing = mobById.get(oldId);

        if (existing && existing.hp > 0) {
            return existing;
        }

        petal.summonMobIds[subIndex] = null;
    }

    const mobType = MobTypes[petalType.deathSummonType];
    if (!mobType) return null;

    const bodies = getPetalBodyPositions(player, slotIndex, petal, petalType);
    const bodyPos = bodies.find(b => (b.index ?? 0) === subIndex);

    const pos =
        posOverride ??
        bodyPos ??
        player.petalSim?.[slotIndex] ??
        { x: player.x, y: player.y };

    const rarityOffset = petalType.deathSummonRarityOffset ?? -1;
    const summonRarity = clamp(
        (petal.rarity | 0) + rarityOffset,
        0,
        6
    );

    const mob = new MobState(mobType, summonRarity);

    //reduced size scaling so that it isn't OP
    mob.radius = (mobType.radius ?? MOB.radius) * Math.pow(1.15, summonRarity);

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

    if (!tryPlaceMobInOpenSpace(mob, () => {
        const aa = randf(0, Math.PI * 2);
        const dd = randf(10, spawnR + 45);
        return {
            x: pos.x + Math.cos(aa) * dd,
            y: pos.y + Math.sin(aa) * dd
        };
    }, 24)) {
        return null;
    }

    // Player-owned ally.
    mob.faction = player.faction ?? FACTION.PLAYER;

    // Summon metadata.
    mob.isPetalSummon = true;
    mob.ownerPlayerId = player.id;
    mob.ownerPetalSlot = slotIndex;
    mob.ownerPetalSubIndex = subIndex;
    mob.ownerPetalTypeId = petal.typeId;
    mob.drops = [];

    // Fight mobs first, follow owner when idle. 
    mob.behavior = "summon";
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

    petal.summonMobIds[subIndex] = mob.id;
    // Compatibility for old code that expects one summon.
    petal.summonMobId = petal.summonMobIds.find(id => {
        const m = mobById.get(id);
        return m && m.hp > 0;
    }) ?? null;

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

function damagePetalSub(petal, subIndex, amount, source = null) {
    if (!petal) return false;

    const type = PetalTypes[petal.typeId];

    // Bubble petals cannot be damaged by mobs/mob objects.
    // They can still forceReload from their own pop.
    if (
        type?.immuneToMobDamage &&
        source &&
        (
            source.type !== undefined ||
            source.ownerMobId !== undefined ||
            source.targetPlayerId !== undefined
        )
    ) {
        return false;
    }

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

    // Spawn one summon when THIS subpetal dies.
    // So antEgg multi 4 = 4 ants, multi 5 = 5 ants.
    // Revolutionary concept: four eggs make four ants.
    if (
        type?.deathSummonType &&
        petal.multiHp[subIndex] <= 0 &&
        petal._deathOwner &&
        petal._deathSlotIndex != null
    ) {
        const body = Array.isArray(petal.multiBodies)
            ? petal.multiBodies.find(b => (b.index ?? 0) === subIndex)
            : null;

        spawnFriendlyMobFromPetal(
            petal._deathOwner,
            petal,
            petal._deathSlotIndex,
            subIndex,
            body ? { x: body.x, y: body.y } : null
        );
    }

    return true;
}

function explodeLandmine(player, petal, deadIndices, subIndex = 0, ex = petal.dropX, ey = petal.dropY) {
    const type = PetalTypes[petal.typeId];

    if (!type?.isDroppable || petal.typeId !== "landmine") return false;
    if (!petal.dropped) return false;

    syncPetalMultiState(petal);
    subIndex = clamp(subIndex | 0, 0, petal.multiHp.length - 1);

    if ((petal.multiHp[subIndex] ?? 0) <= 0) return false;
    if ((petal.multiReloadLeft[subIndex] ?? 0) > 0) return false;

    const r =
        (type.explosionRadiusBase ?? 500) *
        Math.pow(type.explosionRadiusScale ?? 1, petal.rarity);

    const r2 = r * r;
    const dmg = petal.dmg;

    // Damage mobs in explosion radius.
    for (let mi = 0; mi < mobsArr.length; mi++) {
        const mob = mobsArr[mi];

        if (!canTakeDamage(mob)) continue;
        if (dist2(ex, ey, mob.x, mob.y) > r2) continue;

        const didDamage = applyEntityDamage(mob, dmg, petal, {
            targetCdProp: "hitCd",
            targetCd: 0.12,
            neutralAggroPlayer: player,
            expPlayer: player
        });

        if (didDamage) {
            pushDeadMob(deadIndices, mi, mob);
        }
    }

    // Damage players too, but not godmode players.
    for (const p of playersArr) {
        if (!canTakeDamage(p) || p.godMode) continue;

        // Owner can also be hit. Landmines having consequences, tragic.
        if (dist2(ex, ey, p.x, p.y) > r2) continue;

        applyEntityDamage(p, dmg, petal, {
            targetCdProp: "hitCd",
            targetCd: 0.12
        });
    }

    petal.forceReloadSub(subIndex);

    if (Array.isArray(petal.multiBodies)) {
        petal.multiBodies = petal.multiBodies.filter(body => {
            return (body.index ?? 0) !== subIndex;
        });
    }

    if (petalMultiAliveCount(petal) <= 0) {
        petal.dropped = false;
        petal.dropX = 0;
        petal.dropY = 0;
        petal.multiBodies = [];
    } else if (Array.isArray(petal.multiBodies) && petal.multiBodies.length > 0) {
        petal.dropX = petal.multiBodies[0].x;
        petal.dropY = petal.multiBodies[0].y;
    }

    return true;
}

function handlePetalEntityContact(player, slotIndex, petal, target, targetRadius, deadIndices, targetMobIndex = null, hitX = null, hitY = null, cachedPetal = null) {
    if (!petal || petal.disabledByStack || !petal.isAlive() || !canTakeDamage(target)) return false;
    if (player.isSlotStackDisabledFast?.(slotIndex) ?? isPetalSlotStackDisabled(player, slotIndex)) return false;

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

    const multiPositions = cachedPetal?.bodies ?? getPetalBodyPositions(player, slotIndex, petal, petalType);

    const multiRadius = cachedPetal?.radius ?? getPetalRadius(petalType, petal.rarity);
    const multiDamage = getPetalMultiDamage(petal, petalType);

    for (const mp of multiPositions) {
        const subIndex = mp.index ?? 0;

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
            return explodeLandmine(player, petal, deadIndices, subIndex, mp.x, mp.y);
        }

        let didDamage = false;

        if (multiDamage > 0) {
            didDamage = applyEntityDamage(target, multiDamage, petal, {
                neutralAggroPlayer: player,
                expPlayer: player
            });

            if (!didDamage) continue;
        }

        petal.multiHitCd[subIndex] = 0.12;

        if (petal.typeId === "pincer" && target.type !== undefined && didDamage) {
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
    petalAttractGrid = buildMobGridForPetals(mbArr, isActive, PETAL_ATTRACT_CELL);

    updateLovebugMating(DT);

    for (const p of plArr) {
        p.update(DT);
        p._petalCollisionCache = buildPlayerPetalCollisionCache(p);
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

                let couldTouchPetal = false;

                // Normal orbiting-petal broad phase:
                // mob near the player/orbit area.
                let closestD2ToPlayer = Infinity;

                for (const part of parts) {
                    const d2 = dist2(part.x, part.y, player.x, player.y);
                    if (d2 < closestD2ToPlayer) closestD2ToPlayer = d2;
                }

                const normalApproxR =
                    player.petalRadius +
                    getPlayerMaxPetalReach(player) +
                    (mob.radius || MOB.radius) +
                    PETAL_WOBBLE.ampMax +
                    64;

                if (closestD2ToPlayer <= normalApproxR * normalApproxR) {
                    couldTouchPetal = true;
                }

                // Dropped-petal broad phase:
                // dropped landmines are not near the player anymore, because that is literally
                // what "dropped" means. Software, please try to keep up.
                if (!couldTouchPetal) {
                    for (let i = 0; i < player.petals.length && !couldTouchPetal; i++) {
                        const petal = player.petals[i];
                        if (!petal || !petal.dropped) continue;

                        const petalType = PetalTypes[petal.typeId];
                        if (!petalType) continue;

                        const cached = player._petalCollisionCache?.[i];
                        if (!cached) continue;

                        const bodies = cached.bodies;
                        const pr = cached.radius;

                        for (const body of bodies) {
                            for (const part of parts) {
                                const mr = part.radius || mob.radius || MOB.radius;

                                if (circlesTouch(body.x, body.y, pr, part.x, part.y, mr)) {
                                    couldTouchPetal = true;
                                    break;
                                }
                            }

                            if (couldTouchPetal) break;
                        }
                    }
                }

                if (!couldTouchPetal) continue;

                let hit = false;

                for (let i = 0; i < player.petals.length && !hit; i++) {
                    for (const part of parts) {
                        if (
                            handlePetalEntityContact(
                                player,
                                i,
                                player.petals[i],
                                mob,
                                part.radius || mob.radius || MOB.radius,
                                deadIndices,
                                mi,
                                part.x,
                                part.y,
                                player._petalCollisionCache?.[i]
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
                    const canDamageMob = canDamageFaction(player.faction, mob.faction);

                    for (const part of getMobHitParts(mob)) {
                        const mr = part.radius || MOB.radius;

                        const touchingPlayer = circlesTouch(
                            part.x,
                            part.y,
                            mr,
                            player.x,
                            player.y,
                            pr
                        );

                        // Only push from the head. Body pushing gets annoying fast.
                        if (part.isHead) {
                            resolveCircleOverlap(mob, player, mr, pr);
                        }

                        if (!touchingPlayer) continue;

                        // Mob damages player.
                        if (canDamagePlayer && mob.attackCd <= 0) {
                            applyEntityDamage(player, mob.dmg, mob);
                            mob.attackCd = 0.5;
                        }

                        // Player body damages mob and aggros it.
                        if (canDamageMob && mob.hitCd <= 0) {
                            const didDamageMob = applyEntityDamage(mob, player.bodyDmg ?? PLAYER.bodyDmg, player, {
                                targetCdProp: "hitCd",
                                targetCd: 0.12,
                                neutralAggroPlayer: player,
                                expPlayer: player
                            });

                            if (didDamageMob) {
                                pushDeadMob(deadIndices, mi, mob);
                            }
                        }

                        break;
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
                if (!canDamageFaction(o.faction, m.faction)) continue;

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
                        deadIndices,
                        null,
                        null,
                        null,
                        player._petalCollisionCache?.[i]
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

        if (!mob._expAwarded && mob.lastHitPlayerId != null && !mob.isPetalSummon) {
            const killer = players.get(mob.lastHitPlayerId);

            if (killer && killer.hp > 0) {
                const expGained = getMobKillExp(mob);
                killer.addExp(expGained);
                mob._expAwarded = true;
            }
        }

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

            if (petal) {
                if (petal.summonMobId === mob.id) {
                    petal.summonMobId = null;
                }

                if (Array.isArray(petal.summonMobIds)) {
                    for (let i = 0; i < petal.summonMobIds.length; i++) {
                        if (petal.summonMobIds[i] === mob.id) {
                            petal.summonMobIds[i] = null;
                        }
                    }

                    petal.summonMobId = petal.summonMobIds.find(id => {
                        const m = mobById.get(id);
                        return m && m.hp > 0;
                    }) ?? null;
                }
            }
        }

        mobs.splice(idx, 1);
    }

    solveCentipedeConstraints(8);
    handlePickups(DT);

    for (const p of plArr) {
        if (p.hp <= 0) {
            const deathX = p.x;
            const deathY = p.y;

            killPlayerSummons(p);

            tryBloodSacrificeOnDeath(p, deathX, deathY);

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
            tileheight: currentMapData.tileheight,
            biome: currentMapData.biome || "garden"
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

    ws.send(JSON.stringify({
        t: "chat_history",
        messages: chatHistory
    }));

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

        if (msg.t === "chat_send") {
            const now = Date.now();

            if (!Number.isFinite(p.lastChatAt)) {
                p.lastChatAt = 0;
            }

            if (now - p.lastChatAt < CHAT.cooldown * 1000) {
                return;
            }

            const text = cleanChatText(msg.text);

            if (!text) return;

            p.lastChatAt = now;
            addChatMessage(p, text);
            return;
        }

        if (msg.t === "input") {
            p.input.up = !!msg.up;
            p.input.down = !!msg.down;
            p.input.left = !!msg.left;
            p.input.right = !!msg.right;
            p.input.extend = !!msg.extend;
            p.input.retract = !!msg.retract;

            p.input.mouseMove = !!msg.mouseMove;

            const mx = Number(msg.mouseX);
            const my = Number(msg.mouseY);

            if (Number.isFinite(mx) && Number.isFinite(my)) {
                p.input.mouseX = clamp(mx, 0, WORLD.w);
                p.input.mouseY = clamp(my, 0, WORLD.h);
            }

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

        if (msg.t === "dev_set_level") {
            p.setLevel(msg.level);
            return;
        }

        if (msg.t === "dev_add_levels") {
            p.addLevels(msg.amount ?? 1);
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
            m.x = clamp(x, m.radius || MOB.radius, WORLD.w - (m.radius || MOB.radius));
            m.y = clamp(y, m.radius || MOB.radius, WORLD.h - (m.radius || MOB.radius));

            if (!tryPlaceMobInOpenSpace(m, () => {
                const a = Math.random() * Math.PI * 2;
                const d = Math.min(200, Math.max(m.radius || MOB.radius, 20 + Math.random() * 100));
                return {
                    x: x + Math.cos(a) * d,
                    y: y + Math.sin(a) * d
                };
            }, 40)) {
                console.warn(`Dev spawn failed: no open space near requested location ${x},${y}`);
                return;
            }

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
