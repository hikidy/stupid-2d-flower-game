const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");

// Load garden tile image for background
const gardenTile = new Image();
gardenTile.src = "tiles/garden.png";
let gardenTileLoaded = false;
gardenTile.onload = () => { gardenTileLoaded = true; };

// camera zoom state (1.0 = unscaled). default zoom in by 1.5x per request.
let zoom = 1.5;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;

canvas.addEventListener("wheel", (e) => {
    e.preventDefault();

    // If inventory is open and mouse is over its scroll area, scroll inventory.
    if (
        canvasUI.inventoryOpen &&
        canvasUI.invViewport &&
        pointInRect(e.clientX, e.clientY, canvasUI.invViewport)
    ) {
        canvasUI.invScroll = clamp(
            canvasUI.invScroll + e.deltaY,
            0,
            canvasUI.invMaxScroll || 0
        );
        return;
    }

    // Otherwise, zoom camera.
    const factor = Math.exp(-e.deltaY * 0.001);
    //zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
}, { passive: false });

const statusEl = document.getElementById("status");
const meEl = document.getElementById("me");
const uiEl = document.getElementById("ui");

if (uiEl) {
    uiEl.style.display = "none";
}

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener("resize", resize);
resize();

let leftDown = false;
let rightDown = false;
let spaceDown = false;

let showHitboxes = false;
let showMobUI = true;
let mouseMovement = false;
let godMode = false;

let lastMouseWorldX = 0;
let lastMouseWorldY = 0;

const input = {
    up: false,
    down: false,
    left: false,
    right: false,
    extend: false,
    retract: false,
    deploy: false,

    mouseMove: false,
    mouseX: 0,
    mouseY: 0
};

function recomputeExtend() {
    input.retract = rightDown;
    input.extend = (leftDown || spaceDown) && !rightDown;
}

window.addEventListener("keydown", (e) => {
    if (chatOpen) {
        if (e.code === "Enter") {
            sendChatMessage();
            e.preventDefault();
            return;
        }

        if (e.code === "Escape") {
            chatInput = "";
            chatOpen = false;
            e.preventDefault();
            return;
        }

        if (e.code === "Backspace") {
            chatInput = chatInput.slice(0, -1);
            e.preventDefault();
            return;
        }

        if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (chatInput.length < 140) {
                chatInput += e.key;
            }
            e.preventDefault();
            return;
        }

        e.preventDefault();
        return;
    }

    if (e.code === "Enter") {
        chatOpen = true;
        chatInput = "";
        e.preventDefault();
        return;
    }

    if (e.code === "Space") {
        spaceDown = true;
        recomputeExtend();
        e.preventDefault();
    }
    if (e.code === "KeyW") input.up = true;
    if (e.code === "KeyS") input.down = true;
    if (e.code === "KeyA") input.left = true;
    if (e.code === "KeyD") input.right = true;
    if (e.code === "KeyH") {
        showHitboxes = !showHitboxes;
    }
    // toggle mob UI with M (HP bar + label + rarity)
    if (e.code === "KeyM") {
        showMobUI = !showMobUI;
    }
    // toggle inventory with I
    if (e.code === "KeyI") {
        canvasUI.inventoryOpen = !canvasUI.inventoryOpen;
        e.preventDefault();
    }
    // toggle god mode with G
    if (e.code === "KeyG") {
        godMode = !godMode;
        safeWsSend({ t: "godMode", enabled: godMode });
    }
    if (e.code === "KeyR") {
        safeWsSend({ t: "swap_secondary_all" });
        e.preventDefault();
    }
    if (/^Digit[0-9]$/.test(e.code)) {
        const digit = Number(e.code.slice(5));
        const slot = digit === 0 ? 9 : digit - 1;

        safeWsSend({
            t: "swap_secondary_slot",
            slot
        });

        e.preventDefault();
    }
});

window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
        spaceDown = false;
        recomputeExtend();
        e.preventDefault();
    }
    if (e.code === "KeyW") input.up = false;
    if (e.code === "KeyS") input.down = false;
    if (e.code === "KeyA") input.left = false;
    if (e.code === "KeyD") input.right = false;
});

let myId = null;
let world = { w: 2000, h: 2000 };
let state = { players: [], mobs: [], pickups: [], mobObjects: [] };
let spawnAreas = [];
let mapInfo = null;
let mapWalls = null;
let invStacks = []; // [{ typeId, count, indices:[...] }]
let craftNotice = "";
let craftNoticeUntil = 0;
let staticData = null;
let petalTypes = {};
let changelogText = "Loading changelog...";
let changelogLoaded = false;

// -------------------- Chat --------------------
const chatMessages = [];
const CHAT_MAX_MESSAGES = 40;
const CHAT_FADE_MS = 9000;

let chatOpen = false;
let chatInput = "";
let chatCursorBlink = 0;

function pushChatMessage(msg) {
    if (!msg || !msg.text) return;

    chatMessages.push({
        id: msg.id ?? `${msg.playerId ?? "?"}:${performance.now()}`,
        playerId: msg.playerId ?? null,
        name: msg.name || `Player ${msg.playerId ?? "?"}`,
        text: String(msg.text ?? ""),
        time: msg.time ?? Date.now()
    });

    while (chatMessages.length > CHAT_MAX_MESSAGES) {
        chatMessages.shift();
    }
}

function sendChatMessage() {
    const text = chatInput.trim();
    if (!text) {
        chatInput = "";
        chatOpen = false;
        return;
    }

    safeWsSend({
        t: "chat_send",
        text
    });

    chatInput = "";
    chatOpen = false;
}

function loadChangelog() {
    fetch("/CHANGELOG.md")
        .then(res => res.ok ? res.text() : Promise.reject(new Error("Missing CHANGELOG.md")))
        .then(text => {
            changelogText = text || "No changelog entries yet.";
            changelogLoaded = true;
        })
        .catch(err => {
            changelogText = "Could not load CHANGELOG.md.";
            changelogLoaded = false;
            console.warn("Failed to load changelog:", err);
        });
}

loadChangelog();

function loadStaticData() {
    fetch("/staticdata")
        .then((res) => res.json())
        .then((data) => {
            staticData = data;
            petalTypes = data?.petalTypes || {};
            window.staticData = data;
            console.log("Loaded static data", data);
        })
        .catch((err) => {
            console.warn("Failed to load static data", err);
        });
}

loadStaticData();

const canvasUI = {
    inventoryOpen: false,
    settingsOpen: false,
    changelogOpen: false,

    petalSlots: [],
    invSlots: [],
    buttons: [],
    dragging: null,
    mouseX: 0,
    mouseY: 0,

    invScroll: 0,
    invMaxScroll: 0,
    invViewport: null,
    invStackEnabled: true
};

// ----- Snapshot interpolation -----
const SNAP_BUFFER = [];
const MAX_SNAP = 30;
const INTERP_DELAY_MS = 120;

let serverOffsetMs = 0;

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpAngle(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
}

function indexById(list) {
    const m = new Map();
    if (!Array.isArray(list)) return m;

    for (const it of list) {
        if (it && it.id !== undefined && it.id !== null) m.set(it.id, it);
    }

    return m;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function screenToWorld(sx, sy, me = null) {
    const p = me || state.players.find(p => p.id === myId);

    if (!p) {
        return { x: sx, y: sy };
    }

    return {
        x: p.x + (sx - canvas.width / 2) / zoom,
        y: p.y + (sy - canvas.height / 2) / zoom
    };
}

function updateMouseWorldTarget() {
    const p = state.players.find(p => p.id === myId);
    const w = screenToWorld(canvasUI.mouseX, canvasUI.mouseY, p);

    lastMouseWorldX = w.x;
    lastMouseWorldY = w.y;

    input.mouseMove = mouseMovement;
    input.mouseX = w.x;
    input.mouseY = w.y;
}

function safeArray(value) {
    return Array.isArray(value) ? value : [];
}

function safeWsSend(payload) {
    if (typeof ws === "undefined" || ws.readyState !== WebSocket.OPEN) return false;

    try {
        ws.send(JSON.stringify(payload));
        return true;
    } catch (err) {
        console.warn("WebSocket send failed:", err);
        return false;
    }
}

function pushSnapshot(msg) {
    if (!msg || typeof msg !== "object") return;

    msg.now = Number.isFinite(msg.now) ? msg.now : Date.now() + serverOffsetMs;
    msg.players = safeArray(msg.players);
    msg.mobs = safeArray(msg.mobs);
    msg.pickups = safeArray(msg.pickups);
    msg.mobObjects = safeArray(msg.mobObjects);
    msg.world = msg.world || world;

    const clientNow = Date.now();
    const newOffset = msg.now - clientNow;
    serverOffsetMs = lerp(serverOffsetMs, newOffset, 0.1);

    SNAP_BUFFER.push(msg);
    if (SNAP_BUFFER.length > MAX_SNAP) SNAP_BUFFER.shift();
}

function getInterpolatedState() {
    if (SNAP_BUFFER.length === 0) return null;
    if (SNAP_BUFFER.length === 1) return SNAP_BUFFER[0];

    const renderTime = Date.now() + serverOffsetMs - INTERP_DELAY_MS;

    let s0 = null, s1 = null;
    for (let i = SNAP_BUFFER.length - 1; i >= 0; i--) {
        if (SNAP_BUFFER[i].now <= renderTime) {
            s0 = SNAP_BUFFER[i];
            s1 = SNAP_BUFFER[i + 1] || SNAP_BUFFER[i];
            break;
        }
    }
    if (!s0) {
        s0 = SNAP_BUFFER[0];
        s1 = SNAP_BUFFER[1] || SNAP_BUFFER[0];
    }

    const span = Math.max(1, (s1.now - s0.now));
    const t = clamp((renderTime - s0.now) / span, 0, 1);

    const p0 = indexById(s0.players);
    const p1 = indexById(s1.players);

    const m0 = indexById(s0.mobs);
    const m1 = indexById(s1.mobs);

    const playersOut = [];
    for (const [id, a] of p1.entries()) {
        const b = p0.get(id) || a;

        let petalPos = a.petalPos;
        if (b.petalPos && a.petalPos && b.petalPos.length === a.petalPos.length) {
            petalPos = a.petalPos.map((p1p, i) => {
                const p0p = b.petalPos[i] || p1p;
                return { x: lerp(p0p.x, p1p.x, t), y: lerp(p0p.y, p1p.y, t) };
            });
        }

        const petals = (a.petals || []).map((p1Petal, i) => {
            const p0Petal = b.petals?.[i] || p1Petal;

            let multiPetalPos = p1Petal.multiPetalPos;

            if (
                Array.isArray(p0Petal.multiPetalPos) &&
                Array.isArray(p1Petal.multiPetalPos) &&
                p0Petal.multiPetalPos.length === p1Petal.multiPetalPos.length
            ) {
                multiPetalPos = p1Petal.multiPetalPos.map((p1Sub, j) => {
                    const p0Sub = p0Petal.multiPetalPos[j] || p1Sub;

                    return {
                        ...p1Sub,
                        x: lerp(p0Sub.x, p1Sub.x, t),
                        y: lerp(p0Sub.y, p1Sub.y, t),
                        index: p1Sub.index ?? j
                    };
                });
            }

            return {
                ...p1Petal,
                multiPetalPos
            };
        });

        playersOut.push({
            ...a,
            x: lerp(b.x, a.x, t),
            y: lerp(b.y, a.y, t),
            lookAngle: lerpAngle(b.lookAngle ?? a.lookAngle ?? 0, a.lookAngle ?? b.lookAngle ?? 0, t),
            angleBase: lerpAngle(b.angleBase, a.angleBase, t),
            petalPos,
            petals,
            secondaryPetals: a.secondaryPetals ?? [],
            inv: a.inv ?? []
        });
    }

    const mobsOut = [];
    for (const [id, a] of m1.entries()) {
        const b = m0.get(id) || a;

        let bodySegments = a.bodySegments;

        if (
            Array.isArray(b.bodySegments) &&
            Array.isArray(a.bodySegments) &&
            b.bodySegments.length === a.bodySegments.length
        ) {
            bodySegments = a.bodySegments.map((segA, i) => {
                const segB = b.bodySegments[i] || segA;

                return {
                    ...segA,
                    x: lerp(segB.x ?? segA.x, segA.x, t),
                    y: lerp(segB.y ?? segA.y, segA.y, t),
                    radius: lerp(
                        segB.radius ?? segA.radius ?? a.radius ?? MOB_RADIUS,
                        segA.radius ?? a.radius ?? MOB_RADIUS,
                        t
                    )
                };
            });
        }

        mobsOut.push({
            ...a,
            x: lerp(b.x, a.x, t),
            y: lerp(b.y, a.y, t),
            vx: lerp(b.vx ?? 0, a.vx ?? 0, t),
            vy: lerp(b.vy ?? 0, a.vy ?? 0, t),
            angle: lerpAngle(b.angle ?? 0, a.angle ?? 0, t),
            bodySegments
        });
    }

    const o0 = indexById(s0.mobObjects || []);
    const o1 = indexById(s1.mobObjects || []);

    const mobObjectsOut = [];
    for (const [id, a] of o1.entries()) {
        const b = o0.get(id) || a;
        mobObjectsOut.push({
            ...a,
            x: lerp(b.x, a.x, t),
            y: lerp(b.y, a.y, t),
            vx: lerp(b.vx ?? 0, a.vx ?? 0, t),
            vy: lerp(b.vy ?? 0, a.vy ?? 0, t),
            angle: lerpAngle(b.angle ?? 0, a.angle ?? 0, t),
        });
    }

    return {
        world: s1.world,
        players: playersOut,
        mobs: mobsOut,
        pickups: s1.pickups,
        mobObjects: mobObjectsOut
    };
}

const PETAL = { count: 5, orbitRadius: 38, radius: 7.5 };
const PLAYER_RADIUS = 15;
const MOB_RADIUS = 18;

// -------------------- Death animations --------------------
const DEATH_ANIM_DURATION = .09; // seconds, fast pop-fade

const lastSeenMobs = new Map();
const deathMobs = new Map();

const lastSeenPetals = new Map();
const deathPetals = new Map();

function clientNowSec() {
    return performance.now() / 1000;
}

function rememberMobDeaths(mobs) {
    const current = new Map();

    for (const m of safeArray(mobs)) {
        if (!m || m.id == null) continue;

        current.set(m.id, {
            ...m,
            radius: m.radius || MOB_RADIUS
        });
    }

    for (const [id, oldMob] of lastSeenMobs) {
        if (!current.has(id) && !deathMobs.has(id)) {
            deathMobs.set(id, {
                ...oldMob,
                _deathStart: clientNowSec()
            });
        }
    }

    lastSeenMobs.clear();
    for (const [id, mob] of current) {
        lastSeenMobs.set(id, mob);
    }
}

function getPetalDeathId(playerId, pt, slotIndex, subIndex) {
    return `petal:${playerId}:${pt.id ?? slotIndex}:${subIndex}`;
}

function collectVisiblePetals(players) {
    const out = [];

    for (const p of safeArray(players)) {
        const playerId = p.id ?? myId ?? "unknown";
        const petals = safeArray(p.petals);

        for (let slotIndex = 0; slotIndex < petals.length; slotIndex++) {
            const pt = petals[slotIndex];
            const wp = p.petalPos?.[slotIndex];

            if (!pt || !wp) continue;

            const positions =
                Array.isArray(pt.multiPetalPos) && pt.multiPetalPos.length > 0
                    ? pt.multiPetalPos
                    : [wp];

            const baseRadius = pt.multiPetalRadius ?? pt.radius ?? PETAL.radius;

            for (const mp of positions) {
                const subIndex = mp.index ?? 0;

                // Dead/reloading petals should become death anims.
                if (mp.alive === false || mp.hp <= 0) continue;

                const id = getPetalDeathId(playerId, pt, slotIndex, subIndex);
                const radius = mp.radius ?? baseRadius;

                out.push({
                    id,
                    flashId: id,
                    typeId: pt.typeId,
                    rarity: pt.rarity ?? 0,
                    hp: mp.hp ?? pt.hp,
                    x: mp.x,
                    y: mp.y,
                    radius,
                    angle: mp.spinAngle ?? pt.spinAngle ?? mp.angle ?? pt.angle ?? 0
                });
            }
        }
    }

    return out;
}

function rememberPetalDeaths(players) {
    const currentPetals = collectVisiblePetals(players);
    const current = new Map();

    for (const petal of currentPetals) {
        current.set(petal.id, petal);
    }

    for (const [id, oldPetal] of lastSeenPetals) {
        if (!current.has(id) && !deathPetals.has(id)) {
            deathPetals.set(id, {
                ...oldPetal,
                _deathStart: clientNowSec()
            });
        }
    }

    lastSeenPetals.clear();
    for (const [id, petal] of current) {
        lastSeenPetals.set(id, petal);
    }
}

function updateDeathTracking() {
    rememberMobDeaths(state.mobs);
    rememberPetalDeaths(state.players);
}

const wsProto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${wsProto}://${location.host}`);

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointerdown", (e) => {
    canvasUI.mouseX = e.clientX;
    canvasUI.mouseY = e.clientY;
    updateMouseWorldTarget();

    // Capture pointer so dragging keeps working even outside the canvas.
    try {
        canvas.setPointerCapture(e.pointerId);
    } catch { }

    if (handleCanvasUIMouseDown(e.clientX, e.clientY, e.button, e.shiftKey)) {
        e.preventDefault();

        // Stop the game from thinking you're also holding attack.
        leftDown = false;
        rightDown = false;
        recomputeExtend();

        return;
    }

    if (e.button === 0) {
        leftDown = true;

        safeWsSend({ t: "drop_petals" });
    }

    if (e.button === 2) rightDown = true;

    recomputeExtend();
});

canvas.addEventListener("pointermove", (e) => {
    canvasUI.mouseX = e.clientX;
    canvasUI.mouseY = e.clientY;

    updateMouseWorldTarget();

    if (canvasUI.dragging) {
        e.preventDefault();
    }
});

canvas.addEventListener("pointerup", (e) => {
    canvasUI.mouseX = e.clientX;
    canvasUI.mouseY = e.clientY;
    updateMouseWorldTarget();

    if (canvasUI.dragging) {
        handleCanvasUIMouseUp(e.clientX, e.clientY);
        e.preventDefault();

        leftDown = false;
        rightDown = false;
        recomputeExtend();

        try {
            canvas.releasePointerCapture(e.pointerId);
        } catch { }

        return;
    }

    if (e.button === 0) leftDown = false;
    if (e.button === 2) rightDown = false;

    recomputeExtend();

    try {
        canvas.releasePointerCapture(e.pointerId);
    } catch { }
});

canvas.addEventListener("pointercancel", (e) => {
    canvasUI.dragging = null;
    leftDown = false;
    rightDown = false;
    recomputeExtend();

    try {
        canvas.releasePointerCapture(e.pointerId);
    } catch { }
});

ws.addEventListener("open", () => {
    if (statusEl) statusEl.textContent = "Connected";

    setInterval(() => {
        updateMouseWorldTarget();
        safeWsSend({ t: "input", ...input });
    }, 33);
});

ws.addEventListener("message", (ev) => {
    let msg;
    try {
        msg = JSON.parse(ev.data);
    } catch (err) {
        console.warn("Bad server message:", err);
        return;
    }

    if (msg.t === "hello") {
        myId = msg.id;
        if (statusEl) statusEl.textContent = `Connected as Player ${myId}`;
        if (msg.spawn) spawnAreas = msg.spawn;
        if (msg.map) mapInfo = msg.map;
        if (msg.walls) mapWalls = msg.walls;
    }

    if (msg.t === "craft_result") {
        craftNotice = msg.message || "Craft result received.";
        craftNoticeUntil = performance.now() + 2200;
    }

    if (msg.t === "chat_history") {
        chatMessages.length = 0;

        for (const chatMsg of safeArray(msg.messages)) {
            pushChatMessage(chatMsg);
        }

        return;
    }

    if (msg.t === "chat") {
        pushChatMessage(msg);
        return;
    }

    if (msg.t === "state") pushSnapshot(msg);
});

// Developer helper: call from browser devtools to spawn a mob on the server.
// Example: spawnMob(400, 300, 'ant', 2)
window.spawnMob = function (x, y, type, rarity) {
    try {
        const payload = { t: 'dev_spawn_mob', x: Number(x), y: Number(y) };
        if (typeof type === 'string') payload.type = type;
        if (Number.isFinite(Number(rarity))) payload.rarity = Number(rarity);
        safeWsSend(payload);
        console.log('spawnMob -> sent', payload);
    } catch (e) {
        console.error('spawnMob error', e);
    }
};

// Developer helper: set a petal slot on the server from browser console.
// Example: setSlot(1, 'ant', 2) sets the first slot to an ant of rarity 2.
window.setSlot = function (slot, type, rarity) {
    try {
        const slotNumber = Number(slot);
        if (!Number.isFinite(slotNumber)) throw new Error('slot must be a number');

        let slotIndex = slotNumber | 0;
        if (slotIndex >= 0 && slotIndex <= 9) {
            slotIndex = slotNumber;
        }
        if (slotIndex < 0 || slotIndex > 9) throw new Error('slot must be 0-9 or 1-10');

        const payload = {
            t: 'dev_set_slot',
            slot: slotIndex,
            type: typeof type === 'string' ? type : 'basic',
            rarity: Number.isFinite(Number(rarity)) ? Number(rarity) : 0
        };

        safeWsSend(payload);
        console.log('setSlot -> sent', payload);
    } catch (e) {
        console.error('setSlot error', e);
    }
};

// -------------------- Colors --------------------
function getRarityInfo(rarity = 0) {
    const rr = Number.isFinite(rarity) ? rarity : 0;
    return rarityStatic[rr] || { name: `R${rr}`, color: "#ffffff" };
}

function rarityBorderColor(rarity = 0) {
    return getRarityInfo(rarity).color;
}

function rarityLabelShort(rarity = 0) {
    return `R${rarity | 0}`;
}

function invItemTypeId(item) {
    return typeof item === "string" ? item : item?.typeId;
}

function invItemRarity(item) {
    return typeof item === "string" ? 0 : (item?.rarity ?? 0);
}

function colorForType(typeId) {
    if (typeId === "basic") return "#d9d9d9";
    if (typeId === "rose") return "#ff7bbf";
    if (typeId === "rock") return "#a7a7ff";
    if (typeId === "rice") return "#ffe7a6";
    return "#ffffff";
}
// -------------------- Canvas UI + Inventory --------------------

function pointInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
        ctx.fill();
        ctx.stroke();
        return;
    }

    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
}

function roundedRectPath(ctx, x, y, w, h, r) {
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
        return;
    }

    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function drawReloadSpiral(ctx, x, y, w, h, pctLeft, color) {
    pctLeft = clamp(Number(pctLeft) || 0, 0, 1);

    const cx = x + w / 2;
    const cy = y + h / 2;
    const maxR = Math.hypot(w, h) * 0.58;

    const progress = 1 - pctLeft;
    const TAU = Math.PI * 2;

    ctx.save();

    // Clip to inner card area.
    roundedRectPath(ctx, x, y, w, h, 0);
    ctx.clip();

    ctx.translate(cx, cy);

    // As reload goes down, this rotates.
    ctx.rotate(performance.now() * 0.008 - pctLeft * TAU * 2.25);

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(3, Math.min(w, h) * 0.09);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();

    const turns = 3.15;
    const maxA = TAU * turns;
    const visibleR = maxR * (0.18 + progress * 0.82);

    for (let a = 0; a <= maxA; a += 0.08) {
        const u = a / maxA;
        const r = u * visibleR;

        const wob = Math.sin(a * 2.0) * 0.05 * visibleR;
        const px = Math.cos(a) * (r + wob);
        const py = Math.sin(a) * (r + wob);

        if (a === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }

    ctx.stroke();

    // Small pulsing center dot, because reloading should look alive.
    ctx.globalAlpha *= 0.75;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(2, Math.min(w, h) * 0.045), 0, TAU);
    ctx.fill();

    ctx.restore();
}

function rebuildInvStacks(me) {
    if (!me) return;

    const inv = me.inv ?? [];
    const map = new Map();

    for (let i = 0; i < inv.length; i++) {
        const item = inv[i];
        const typeId = invItemTypeId(item);
        const rarity = invItemRarity(item);

        if (!typeId) continue;

        let key;

        if (canvasUI.invStackEnabled) {
            // Stack exact same petal + exact same rarity.
            // Example: rock R0 + rock R0 = rock x2
            // But rock R0 and rock R1 stay separate.
            key = `${typeId}@@${rarity}`;
        } else {
            // Non-stack mode: every item is its own card.
            key = `single@@${i}`;
        }

        let st = map.get(key);

        if (!st) {
            st = {
                typeId,
                label: item.label || typeId,
                rarity,
                count: 0,
                indices: [],
                highestInvIndex: i
            };
            map.set(key, st);
        }

        st.count++;
        st.indices.push(i);

        // Keep a real inventory index for dragging/equipping.
        st.highestInvIndex = st.indices[0];
    }

    invStacks = Array.from(map.values()).sort((a, b) => {
        if ((b.rarity ?? 0) !== (a.rarity ?? 0)) {
            return (b.rarity ?? 0) - (a.rarity ?? 0);
        }

        if (a.typeId !== b.typeId) {
            return String(a.typeId).localeCompare(String(b.typeId));
        }

        return (a.indices[0] ?? 0) - (b.indices[0] ?? 0);
    });
}

function drawCanvasButton(label, x, y, w, h, active) {
    ctx.fillStyle = active ? "rgba(255,255,255,0.24)" : "rgba(0,0,0,0.35)";
    ctx.strokeStyle = active ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 12);

    ctx.fillStyle = "#ffffff";
    ctx.font = "800 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + w / 2, y + h / 2);

    canvasUI.buttons.push({ label, x, y, w, h });
}

function drawChatOverlay() {
    const now = Date.now();

    ctx.save();

    const x = 18;
    const bottom = canvas.height - 150;
    const w = Math.min(460, canvas.width - 36);
    const lineH = 19;
    const pad = 10;

    const visibleMessages = chatMessages.filter(msg => {
        return chatOpen || now - msg.time < CHAT_FADE_MS;
    });

    const maxShown = chatOpen ? 12 : 6;
    const shown = visibleMessages.slice(-maxShown);

    let y = bottom - shown.length * lineH - pad * 2;

    if (shown.length > 0 || chatOpen) {
        const boxH = shown.length * lineH + pad * 2 + (chatOpen ? 38 : 0);

        ctx.fillStyle = chatOpen
            ? "rgba(0,0,0,0.62)"
            : "rgba(0,0,0,0.34)";

        ctx.strokeStyle = chatOpen
            ? "rgba(255,255,255,0.22)"
            : "rgba(255,255,255,0.08)";

        ctx.lineWidth = 1;
        roundRect(ctx, x, y, w, boxH, 12);

        ctx.font = "700 14px Ubuntu, Arial, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";

        let textY = y + pad;

        for (const msg of shown) {
            const age = now - msg.time;
            const fade = chatOpen ? 1 : clamp(1 - age / CHAT_FADE_MS, 0, 1);

            ctx.globalAlpha = fade;

            const isMe = msg.playerId === myId;
            const name = isMe ? "You" : msg.name;

            ctx.fillStyle = isMe ? "#ffe56b" : "#ffffff";
            ctx.fillText(`${name}:`, x + pad, textY);

            const nameW = ctx.measureText(`${name}: `).width;

            ctx.fillStyle = "rgba(255,255,255,0.88)";
            ctx.fillText(msg.text, x + pad + nameW, textY);

            textY += lineH;
        }

        ctx.globalAlpha = 1;

        if (chatOpen) {
            const inputY = y + boxH - 32;
            const inputX = x + pad;
            const inputW = w - pad * 2;
            const inputH = 24;

            ctx.fillStyle = "rgba(255,255,255,0.10)";
            ctx.strokeStyle = "rgba(255,255,255,0.22)";
            ctx.lineWidth = 1;
            roundRect(ctx, inputX, inputY, inputW, inputH, 8);

            ctx.fillStyle = "#ffffff";
            ctx.font = "700 14px Ubuntu, Arial, sans-serif";
            ctx.textBaseline = "middle";

            chatCursorBlink += 1;
            const cursor = Math.floor(chatCursorBlink / 28) % 2 === 0 ? "|" : "";

            ctx.fillText(`> ${chatInput}${cursor}`, inputX + 8, inputY + inputH / 2);
        }
    }

    ctx.restore();
}

function getSettingsRows() {
    return [
        {
            kind: "checkbox",
            label: "Hitboxes",
            enabled: showHitboxes,
            buttonLabel: "SET_HITBOXES"
        },
        {
            kind: "checkbox",
            label: "Mob UI",
            enabled: showMobUI,
            buttonLabel: "SET_MOB_UI"
        },
        {
            kind: "checkbox",
            label: "Mouse Movement",
            enabled: mouseMovement,
            buttonLabel: "SET_MOUSE_MOVE"
        },
        {
            kind: "button",
            label: "View Changelog",
            buttonLabel: "SET_CHANGELOG"
        }
    ];
}

function measureSettingsPanel(rows) {
    const panelPadX = 12;
    const panelPadY = 12;

    const boxSize = 28;
    const rowGap = 8;
    const buttonH = 36;

    const labelFont = "bold 22px Ubuntu, Arial, sans-serif";
    const buttonFont = "bold 22px Ubuntu, Arial, sans-serif";

    let maxW = 0;
    let totalH = panelPadY * 2;

    ctx.save();

    for (const row of rows) {
        if (row.kind === "checkbox") {
            ctx.font = labelFont;

            const textW = ctx.measureText(row.label).width;
            const rowW = panelPadX * 2 + boxSize + 10 + textW;

            maxW = Math.max(maxW, rowW);
            totalH += boxSize + rowGap;
        }

        if (row.kind === "button") {
            ctx.font = buttonFont;

            const textW = ctx.measureText(row.label).width;
            const rowW = panelPadX * 2 + textW + 34;

            maxW = Math.max(maxW, rowW);
            totalH += buttonH + rowGap;
        }
    }

    ctx.restore();

    if (rows.length > 0) {
        totalH -= rowGap;
    }

    const minPanelW = 230;
    const maxPanelW = Math.max(180, canvas.width - 20);

    const panelW = clamp(Math.ceil(maxW), minPanelW, maxPanelW);
    const panelH = Math.ceil(totalH);

    return {
        panelW,
        panelH,
        panelPadX,
        panelPadY,
        boxSize,
        rowGap,
        buttonH
    };
}

function drawSettingsCheckboxRow(x, y, rowW, label, enabled, buttonLabel) {
    const boxSize = 28;

    ctx.fillStyle = enabled ? "#d2d2d2" : "#2a2a2a";
    ctx.strokeStyle = "#6e6e6e";
    ctx.lineWidth = 3;
    ctx.fillRect(x, y, boxSize, boxSize);
    ctx.strokeRect(x, y, boxSize, boxSize);

    if (enabled) {
        ctx.strokeStyle = "#ababab";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(x + 5, y + 15);
        ctx.lineTo(x + 11, y + 22);
        ctx.lineTo(x + 23, y + 7);
        ctx.stroke();
    }

    ctx.fillStyle = "#000000";
    ctx.font = "bold 22px Ubuntu, Arial, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + boxSize + 10, y + boxSize / 2);

    canvasUI.buttons.push({
        label: buttonLabel,
        x,
        y,
        w: rowW,
        h: boxSize
    });
}

function drawSettingsFlatButton(x, y, w, h, label, buttonLabel) {
    ctx.fillStyle = "#8d8d8d";
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = 4;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    ctx.fillStyle = "#000000";
    ctx.font = "bold 22px Ubuntu, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);

    canvasUI.buttons.push({
        label: buttonLabel,
        x,
        y,
        w,
        h
    });
}

function drawSettingsMenu() {
    const gearX = 10;
    const gearY = 10;
    const gearSize = 68;

    ctx.save();

    // Gear button
    ctx.fillStyle = "#d9d9d9";
    ctx.strokeStyle = "#8d8d8d";
    ctx.lineWidth = 6;
    ctx.fillRect(gearX, gearY, gearSize, gearSize);
    ctx.strokeRect(gearX, gearY, gearSize, gearSize);

    ctx.fillStyle = "#ffffff";
    ctx.font = "48px Ubuntu, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("⚙", gearX + gearSize / 2, gearY + gearSize / 2 + 1);

    canvasUI.buttons.push({
        label: "SETTINGS_TOGGLE",
        x: gearX,
        y: gearY,
        w: gearSize,
        h: gearSize
    });

    if (!canvasUI.settingsOpen) {
        ctx.restore();
        return;
    }

    const rows = getSettingsRows();
    const metrics = measureSettingsPanel(rows);

    const panelX = 10;
    const panelY = 95;
    const panelW = metrics.panelW;
    const panelH = metrics.panelH;

    ctx.fillStyle = "#bfbfbf";
    ctx.strokeStyle = "#8d8d8d";
    ctx.lineWidth = 5;
    ctx.fillRect(panelX, panelY, panelW, panelH);
    ctx.strokeRect(panelX, panelY, panelW, panelH);

    let y = panelY + metrics.panelPadY;

    for (const row of rows) {
        const rowX = panelX + metrics.panelPadX;
        const rowW = panelW - metrics.panelPadX * 2;

        if (row.kind === "checkbox") {
            drawSettingsCheckboxRow(
                rowX,
                y,
                rowW,
                row.label,
                row.enabled,
                row.buttonLabel
            );

            y += metrics.boxSize + metrics.rowGap;
        }

        if (row.kind === "button") {
            const buttonTextPad = 34;

            ctx.font = "bold 22px Ubuntu, Arial, sans-serif";
            const measuredW = Math.ceil(ctx.measureText(row.label).width + buttonTextPad);

            const btnW = Math.min(rowW, measuredW);
            const btnX = panelX + panelW / 2 - btnW / 2;

            drawSettingsFlatButton(
                btnX,
                y,
                btnW,
                metrics.buttonH,
                row.label,
                row.buttonLabel
            );

            y += metrics.buttonH + metrics.rowGap;
        }
    }

    ctx.restore();
}

function drawRarityBadge(rarity, x, y) {
    const color = rarityBorderColor(rarity);

    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = rarity === 1 || rarity === 7 ? "#000" : "#fff";
    ctx.font = "800 10px Ubuntu, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(rarity), x, y + 0.5);
}

function drawPetalOrMulti(pt, wp, slotIndex = 0, playerId = "unknown") {
    const rarity = pt.rarity ?? 0;
    const reloading = pt.reloadLeft > 0 || pt.hp <= 0;

    const positions =
        Array.isArray(pt.multiPetalPos) && pt.multiPetalPos.length > 0
            ? pt.multiPetalPos
            : [wp];

    const baseRadius = pt.multiPetalRadius ?? pt.radius ?? PETAL.radius;

    ctx.save();

    if (reloading) {
        ctx.globalAlpha = 0.18;
    }

    for (const mp of positions) {
        if (mp.alive === false || mp.hp <= 0) continue;

        const subIndex = mp.index ?? 0;
        const radius = mp.radius ?? baseRadius;

        Render.drawPetalArtFlash(
            ctx,
            {
                typeId: pt.typeId,
                rarity,
                hp: mp.hp ?? pt.hp,
                angle: mp.spinAngle ?? pt.spinAngle ?? mp.angle ?? pt.angle ?? 0,
                flashId: `petal:${playerId}:${pt.id ?? slotIndex}:${subIndex}`
            },
            mp.x,
            mp.y,
            radius
        );

        if (showHitboxes) {
            drawHitCircle(mp.x, mp.y, radius);
        }
    }

    ctx.restore();
}

function blendHex(color1, color2, percent) {
    // Clamp percent between 0 and 1
    percent = Math.max(0, Math.min(1, percent));

    // Remove #
    color1 = color1.replace("#", "");
    color2 = color2.replace("#", "");

    // Convert to RGB
    const r1 = parseInt(color1.substring(0, 2), 16);
    const g1 = parseInt(color1.substring(2, 4), 16);
    const b1 = parseInt(color1.substring(4, 6), 16);

    const r2 = parseInt(color2.substring(0, 2), 16);
    const g2 = parseInt(color2.substring(2, 4), 16);
    const b2 = parseInt(color2.substring(4, 6), 16);

    // Blend
    const r = Math.round(r1 + (r2 - r1) * percent);
    const g = Math.round(g1 + (g2 - g1) * percent);
    const b = Math.round(b1 + (b2 - b1) * percent);

    // Convert back to hex
    const toHex = (c) => c.toString(16).padStart(2, "0");

    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function drawPetalCard(x, y, typeId, rarity = 0, opts = {}) {
    const size = opts.size ?? 86;
    const label = opts.label ?? typeId;
    const dimmed = opts.dimmed === true;
    const alpha = opts.alpha ?? 1;
    const keyText = opts.keyText ?? "";

    const hp = Number(opts.hp);
    const maxHp = Number(opts.maxHp);
    const reloadLeft = Number(opts.reloadLeft ?? 0);
    const reloadTime = Number(opts.reloadTime ?? petalTypes[typeId]?.reload ?? 1);

    const hasHp = Number.isFinite(hp) && Number.isFinite(maxHp) && maxHp > 0;
    const hpPct = hasHp ? clamp(hp / maxHp, 0, 1) : 1;

    const isReloading = reloadLeft > 0 && reloadTime > 0;
    const reloadPctLeft = isReloading
        ? clamp(reloadLeft / reloadTime, 0, 1)
        : 0;

    const rarityColor = rarityBorderColor(rarity);
    const outerColor = blendHex(rarityColor, "#000000", 0.15);

    const innerEmptyColor = blendHex(
        rarityColor,
        "#000000",
        0.45
    );

    const innerBrightColor = rarityColor;

    ctx.save();

    ctx.translate(x, y);
    ctx.globalAlpha *= alpha;

    const radius = size * 0.055;

    const borderRatio = 0.085;
    const innerRatio = 0.83;

    const border = size * borderRatio;

    const innerX = size * borderRatio;
    const innerY = size * borderRatio;
    const innerW = size * innerRatio;
    const innerH = size * innerRatio;

    // Outer rarity frame.
    ctx.fillStyle = outerColor;
    ctx.strokeStyle = outerColor;
    ctx.lineWidth = 0;
    roundRect(ctx, 0, 0, size, size, radius);

    // Empty/dark inner panel.
    ctx.fillStyle = innerEmptyColor;
    ctx.fillRect(innerX, innerY, innerW, innerH);

    // Bright HP fill or reload triangle.
    ctx.save();

    ctx.beginPath();
    ctx.rect(innerX, innerY, innerW, innerH);
    ctx.clip();

    if (isReloading) {
        const cx = innerX + innerW / 2;
        const cy = innerY + innerH / 2;

        const reloadProgress = 1 - reloadPctLeft;

        const maxR = Math.hypot(innerW, innerH) * 0.85;

        // Length stays mostly large so the wedge reaches outward.
        const len = maxR;

        // Starts thin, gets wider as reload finishes.
        const minSpread = Math.PI * 0.035;
        const maxSpread = Math.PI * 0.85;
        const spread = minSpread + (maxSpread - minSpread) * reloadProgress;

        // Spins constantly while also slightly offsetting based on reload.
        const a = performance.now() * 0.008 - reloadPctLeft * Math.PI * 2;

        ctx.fillStyle = innerBrightColor;
        ctx.globalAlpha *= 0.95;

        ctx.beginPath();

        // Point at the center.
        ctx.moveTo(cx, cy);

        // Two outer points get farther apart as spread increases.
        ctx.lineTo(
            cx + Math.cos(a - spread) * len * 2,
            cy + Math.sin(a - spread) * len * 2
        );

        ctx.lineTo(
            cx + Math.cos(a + spread) * len * 2,
            cy + Math.sin(a + spread) * len * 2
        );

        ctx.closePath();
        ctx.fill();
    } else {
        const fillH = innerH * hpPct;
        const fillY = innerY + innerH - fillH;

        ctx.fillStyle = innerBrightColor;
        ctx.fillRect(innerX, fillY, innerW, fillH);
    }

    ctx.restore();
    // Clip icon and label to the whole card.
    roundedRectPath(ctx, 0, 0, size, size, radius);
    ctx.clip();

    const TAU = Math.PI * 2;
    const pt = petalTypes[typeId] || {};

    const multiCount = Array.isArray(pt.multi)
        ? pt.multi[rarity] ?? pt.multi[pt.multi.length - 1] ?? 1
        : pt.multi ?? 1;

    const iconCenterX = size / 2;
    const iconCenterY = size * 0.43;

    const baseIconSize = (pt.radius ?? 1) / 6.7 * size;
    const iconSize = baseIconSize * (pt.sizeRatio ?? 1);

    if (multiCount > 1) {
        const ringRadius = size * 0.17;

        for (let i = 0; i < multiCount; i++) {
            const angle = (i / multiCount) * TAU - Math.PI / 2;

            const px = iconCenterX + Math.cos(angle) * ringRadius;
            const py = iconCenterY + Math.sin(angle) * ringRadius;

            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(angle + Math.PI / 2);

            Render.drawPetalArt(
                ctx,
                typeId,
                rarity,
                0,
                0,
                iconSize
            );

            ctx.restore();
        }
    } else {
        Render.drawPetalArt(
            ctx,
            typeId,
            rarity,
            iconCenterX,
            iconCenterY,
            iconSize
        );
    }

    if (keyText) {
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = Math.max(2, size * 0.035);
        ctx.font = `900 ${Math.round(size * 0.14)}px Ubuntu, Arial, sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";

        ctx.strokeText(String(keyText), size * 0.08, size * 0.065);
        ctx.fillText(String(keyText), size * 0.08, size * 0.065);
    }

    if (label) {
        const labelText = String(label);
        const maxTextWidth = size * 0.78;

        let fontSize = size * 0.21;
        const minFontSize = size * 0.10;

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round";

        do {
            ctx.font = `900 ${Math.round(fontSize)}px Ubuntu, Arial, sans-serif`;
            fontSize -= 1;
        } while (
            ctx.measureText(labelText).width > maxTextWidth &&
            fontSize > minFontSize
        );

        ctx.lineWidth = Math.max(2, fontSize * 0.25);
        ctx.strokeStyle = "#000000";
        ctx.fillStyle = "#ffffff";

        ctx.strokeText(labelText, size / 2, size * 0.74);
        ctx.fillText(labelText, size / 2, size * 0.74);
    }

    ctx.restore();
}

function drawCanvasPetalSlot(slot, item, indexText, countText, reloadText, opts = {}) {
    const { x, y, w, h } = slot;
    const cardStyle = opts.cardStyle === true;

    const isDragging =
        canvasUI.dragging &&
        canvasUI.dragging.kind === slot.kind &&
        canvasUI.dragging.index === slot.index;

    if (cardStyle) {
        ctx.save();

        // Empty fallback slot, so the UI doesn't become invisible
        if (!item || !item.typeId) {
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = "rgba(255,255,255,0.10)";
            ctx.strokeStyle = "rgba(255,255,255,0.22)";
            ctx.lineWidth = 1;
            roundRect(ctx, x, y, w, h, 10);
            ctx.restore();
            return;
        }

        drawPetalCard(x, y, item.typeId, item.rarity ?? 0, {
            size: Math.min(w, h),
            label: item.label || item.typeId,
            dimmed: item.dim || !!reloadText,
            alpha: isDragging ? 0.45 : 1,
            keyText: indexText,

            hp: item.hp,
            maxHp: item.maxHp,
            reloadLeft: item.reloadLeft,
            reloadTime: item.reloadTime
        });

        ctx.restore();
        return;
    }

    ctx.save();
    ctx.globalAlpha = isDragging ? 0.45 : 1;

    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.strokeStyle = "rgba(255,255,255,0.20)";
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 10);

    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.font = "700 11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(indexText, x + 6, y + 5);

    if (item) {
        const typeId = item.typeId;
        const rarity = item.rarity ?? 0;

        if (item.dim) ctx.globalAlpha = 0.35;

        Render.drawPetalArt(ctx, typeId, rarity, x + w / 2, y + h / 2 + 1, 30);

        ctx.globalAlpha = isDragging ? 0.45 : 1;

        drawRarityBadge(rarity, x + w - 10, y + 10);

        ctx.fillStyle = "#fff";
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";

        const label = reloadText || countText || typeId;
        ctx.fillText(label, x + w / 2, y + h - 5);
    }

    ctx.restore();
}

function getNearbyBossMob(me, mobs, range = 750) {
    if (!me || !Array.isArray(mobs)) return null;

    const range2 = range * range;
    let best = null;
    let bestScore = -Infinity;

    for (const m of mobs) {
        if (!m || m.hp <= 0) continue;
        if ((m.rarity ?? 0) < 7) continue;

        const dx = m.x - me.x;
        const dy = m.y - me.y;
        const d2 = dx * dx + dy * dy;

        if (d2 > range2) continue;

        // Prefer higher rarity, then closer mobs.
        const score = (m.rarity ?? 0) * 1000000 - d2;

        if (score > bestScore) {
            bestScore = score;
            best = m;
        }
    }

    return best;
}

function drawBossHpBar(mob) {
    if (!mob) return;

    const rarity = mob.rarity ?? 0;
    const info = rarityStatic[rarity];

    const hp = Number(mob.hp ?? 0);
    const maxHp = Math.max(1, Number(mob.maxHp ?? hp ?? 1));
    const pct = clamp(hp / maxHp, 0, 1);

    ctx.save();

    const barW = Math.min(535, canvas.width * 0.42);
    const barThickness = 58;

    const x = canvas.width / 2 - barW / 2;
    const y = canvas.height * 0.12;

    const x1 = x;
    const x2 = x + barW;
    const cy = y;

    const bossName = mob.label || mob.type || "Boss";
    const rarityText = info?.name || `Rarity ${rarity}`;

    // Thick dark line background
    ctx.lineCap = "round";
    ctx.lineWidth = barThickness;
    ctx.strokeStyle = "rgba(24,24,24,0.90)";
    ctx.beginPath();
    ctx.moveTo(x1, cy);
    ctx.lineTo(x2, cy);
    ctx.stroke();

    // Thick green HP line
    ctx.lineWidth = barThickness * 0.62;
    ctx.strokeStyle = "#95ff7a";
    ctx.beginPath();
    ctx.moveTo(x1, cy);
    ctx.lineTo(x1 + barW * pct, cy);
    ctx.stroke();

    // Boss name
    ctx.font = "900 48px Ubuntu, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 9;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.fillStyle = "#ffffff";
    ctx.strokeText(bossName, x + barW / 2, cy - 6);
    ctx.fillText(bossName, x + barW / 2, cy - 6);

    // Optional slight dark overlay so it feels like the screenshot
    ctx.lineWidth = barThickness;
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    ctx.beginPath();
    ctx.moveTo(x1, cy);
    ctx.lineTo(x2, cy);
    ctx.stroke();

    // Rarity label
    ctx.font = "900 30px Ubuntu, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.fillStyle = info?.color || "#ffffff";
    ctx.strokeText(rarityText, x + barW / 2, cy + 22);
    ctx.fillText(rarityText, x + barW / 2, cy + 22);

    ctx.restore();
}

function drawCanvasBottomUI(me) {
    canvasUI.petalSlots = [];
    canvasUI.buttons = [];

    const slotSize = 86;
    const slotW = slotSize;
    const slotH = slotSize;
    const gap = 12;
    const buttonSize = 46;
    const buttonGap = 8;

    const petals = safeArray(me.petals);
    const count = petals.length;

    // Inventory button stays bottom-left
    const invButtonX = 18;
    const invButtonY = canvas.height - buttonSize - 18;
    drawCanvasButton("INV", invButtonX, invButtonY, buttonSize, buttonSize, canvasUI.inventoryOpen);

    drawSettingsMenu();

    // If there are no petals, do not do spooky invisible math
    if (count <= 0) return;

    const petalBarW = count * slotW + Math.max(0, count - 1) * gap;

    // Center ONLY the petal bar, not the debug buttons too
    const barX = canvas.width / 2 - petalBarW / 2;
    const barY = canvas.height - slotH * 2 - 18;

    // Debug buttons sit to the left of the petal bar
    //const debugX = Math.max(18, barX - buttonSize * 2 - buttonGap - 18);
    //drawCanvasButton("HB", debugX, barY + 20, buttonSize, buttonSize, showHitboxes);
    //drawCanvasButton("MOB", debugX + buttonSize + buttonGap, barY + 20, buttonSize, buttonSize, showMobUI);

    for (let i = 0; i < count; i++) {
        const pt = petals[i];
        if (!pt) continue;

        const reloading = (pt.reloadLeft ?? 0) > 0 || (pt.hp ?? 1) <= 0;

        const slot = {
            kind: "slot",
            index: i,
            label: pt.label || pt.typeId || "petal",
            x: barX + i * (slotW + gap),
            y: barY,
            w: slotW,
            h: slotH
        };

        canvasUI.petalSlots.push(slot);

        drawCanvasPetalSlot(
            slot,
            {
                typeId: pt.typeId || "basic",
                rarity: pt.rarity ?? 0,
                dim: reloading,
                label: pt.label || pt.typeId || "petal",

                hp: pt.hp,
                maxHp: pt.maxHp,
                reloadLeft: pt.reloadLeft,
                reloadTime: pt.reloadTime
            },
            String(i + 1),
            null,
            reloading ? `${(pt.reloadLeft ?? 0).toFixed(1)}s` : null,
            { cardStyle: true }
        );
    }

    const secondary = safeArray(me.secondaryPetals);
    const secondaryCount = Math.min(count, secondary.length);
    const secondarySize = slotW * 0.75;
    const secondaryStep = (slotW + gap) * 0.75;
    const secondaryTotalW =
        secondaryCount > 0
            ? secondarySize + (secondaryCount - 1) * secondaryStep
            : 0;

    const secondaryX = barX + (petalBarW - secondaryTotalW) / 2;

    for (let i = 0; i < secondaryCount; i++) {
        const pt = secondary[i];
        if (!pt) continue;

        drawPetalCard(
            secondaryX + i * secondaryStep,
            barY + slotH + 6,
            pt.typeId || "basic",
            pt.rarity ?? 0,
            {
                size: secondarySize,
                label: pt.label || pt.typeId || "petal",
                alpha: 0.62,
                keyText: "",

                hp: pt.hp,
                maxHp: pt.maxHp,
                reloadLeft: pt.reloadLeft,
                reloadTime: pt.reloadTime
            }
        );
    }
}

function drawChangelogOverlay() {
    if (!canvasUI.changelogOpen) return;

    const panelW = Math.min(620, canvas.width - 40);
    const panelH = Math.min(520, canvas.height - 40);
    const panelX = canvas.width / 2 - panelW / 2;
    const panelY = canvas.height / 2 - panelH / 2;

    ctx.save();

    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "rgba(18,18,24,0.96)";
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 2;
    roundRect(ctx, panelX, panelY, panelW, panelH, 18);

    ctx.fillStyle = "#ffffff";
    ctx.font = "900 28px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("Changelog", panelX + 24, panelY + 20);

    const closeW = 86;
    const closeH = 34;
    const closeX = panelX + panelW - closeW - 18;
    const closeY = panelY + 18;

    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    roundRect(ctx, closeX, closeY, closeW, closeH, 10);

    ctx.fillStyle = "#ffffff";
    ctx.font = "800 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Close", closeX + closeW / 2, closeY + closeH / 2);

    canvasUI.buttons.push({
        label: "CHANGELOG_CLOSE",
        x: closeX,
        y: closeY,
        w: closeW,
        h: closeH
    });

    const textX = panelX + 24;
    const textY = panelY + 74;
    const textW = panelW - 48;
    const lineH = 20;

    ctx.font = "600 15px Consolas, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    const lines = markdownToPlainLines(changelogText);
    let y = textY;

    for (const line of lines) {
        if (y > panelY + panelH - 30) break;

        const wrapped = wrapCanvasText(line, textW);

        for (const part of wrapped) {
            if (y > panelY + panelH - 30) break;

            ctx.fillStyle = line.startsWith("#")
                ? "#ffffff"
                : "rgba(255,255,255,0.84)";

            ctx.fillText(part, textX, y);
            y += line.startsWith("#") ? lineH + 6 : lineH;
        }
    }

    ctx.restore();
}

function markdownToPlainLines(md) {
    return String(md || "")
        .replace(/\r/g, "")
        .split("\n")
        .map(line => {
            return line
                .replace(/^### /, "• ")
                .replace(/^## /, "")
                .replace(/^# /, "")
                .replace(/\*\*/g, "")
                .replace(/`/g, "");
        });
}

function wrapCanvasText(text, maxW) {
    const words = String(text || "").split(" ");
    const lines = [];
    let line = "";

    for (const word of words) {
        const test = line ? `${line} ${word}` : word;

        if (ctx.measureText(test).width > maxW && line) {
            lines.push(line);
            line = word;
        } else {
            line = test;
        }
    }

    lines.push(line);
    return lines;
}

function drawCanvasInventory(me) {
    canvasUI.invSlots = [];
    rebuildInvStacks(me);

    const cols = 5;
    const visibleRows = 7;

    const cardSize = 60;
    const gap = 10;

    const panelPad = 24;
    const titleH = 78;
    const filterH = 64;
    const sectionHeaderH = 28;

    const gridW = cols * cardSize + (cols - 1) * gap;
    const viewportH = visibleRows * cardSize + Math.max(0, visibleRows - 1) * gap;

    const panelW = gridW + panelPad * 2;
    const panelH = titleH + filterH + viewportH + panelPad;

    // Bottom-left, beside INV button.
    const invButtonX = 18;
    const invButtonW = 46;

    const panelX = Math.min(
        invButtonX + invButtonW + 18,
        canvas.width - panelW - 10
    );

    const panelY = Math.max(10, canvas.height - panelH - 18);

    ctx.save();

    // Main panel
    ctx.fillStyle = "#5aa1dc";
    ctx.strokeStyle = "#3e82bf";
    ctx.lineWidth = 6;
    roundRect(ctx, panelX, panelY, panelW, panelH, 0);

    // Title
    ctx.font = "900 24px Ubuntu, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#000000";
    ctx.fillStyle = "#ffffff";
    ctx.strokeText("Inventory", panelX + panelW / 2, panelY + 14);
    ctx.fillText("Inventory", panelX + panelW / 2, panelY + 14);

    // Close button
    const closeSize = 30;
    const closeX = panelX + panelW - closeSize - 12;
    const closeY = panelY + 12;

    ctx.fillStyle = "#c95b5b";
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 2;
    roundRect(ctx, closeX, closeY, closeSize, closeSize, 7);

    ctx.font = "900 25px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.fillText("×", closeX + closeSize / 2, closeY + closeSize / 2 + 1);

    canvasUI.buttons.push({
        label: "INV_CLOSE",
        x: closeX,
        y: closeY,
        w: closeSize,
        h: closeSize
    });

    // Subtitle
    ctx.font = "900 15px Ubuntu, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#000000";
    ctx.fillStyle = "#ffffff";
    ctx.strokeText("Drag a petal to equip it", panelX + panelW / 2, panelY + 62);
    ctx.fillText("Drag a petal to equip it", panelX + panelW / 2, panelY + 62);

    // Stack checkbox
    const checkX = panelX + panelPad + 2;
    const checkY = panelY + titleH + 16;
    const checkSize = 28;

    ctx.fillStyle = canvasUI.invStackEnabled ? "#dddddd" : "#303030";
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 2;
    ctx.fillRect(checkX, checkY, checkSize, checkSize);
    ctx.strokeRect(checkX, checkY, checkSize, checkSize);

    if (canvasUI.invStackEnabled) {
        ctx.strokeStyle = "#111111";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(checkX + 6, checkY + 15);
        ctx.lineTo(checkX + 12, checkY + 22);
        ctx.lineTo(checkX + 23, checkY + 7);
        ctx.stroke();
    }

    canvasUI.buttons.push({
        label: "INV_STACK",
        x: checkX,
        y: checkY,
        w: checkSize + 90,
        h: checkSize
    });

    ctx.font = "900 16px Ubuntu, Arial, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#000000";
    ctx.fillStyle = "#ffffff";
    ctx.strokeText("Stack", checkX + checkSize + 12, checkY + checkSize / 2);
    ctx.fillText("Stack", checkX + checkSize + 12, checkY + checkSize / 2);

    // Search box, visual only
    const searchX = panelX + panelPad + 104;
    const searchY = checkY - 2;
    const searchW = panelW - panelPad * 2 - 104;
    const searchH = 32;

    ctx.fillStyle = "#dddddd";
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 3;
    ctx.fillRect(searchX, searchY, searchW, searchH);
    ctx.strokeRect(searchX, searchY, searchW, searchH);

    // Build rarity groups, highest rarity first.
    const groups = new Map();

    for (const st of invStacks) {
        const rarity = st.rarity ?? 0;
        if (!groups.has(rarity)) groups.set(rarity, []);
        groups.get(rarity).push(st);
    }

    const rarityOrder = Array.from(groups.keys()).sort((a, b) => b - a);

    // Build layout entries.
    const entries = [];
    let contentY = 0;

    for (const rarity of rarityOrder) {
        const items = groups.get(rarity) || [];
        if (items.length <= 0) continue;

        entries.push({
            kind: "header",
            rarity,
            y: contentY,
            h: sectionHeaderH
        });

        contentY += sectionHeaderH;

        for (let i = 0; i < items.length; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);

            entries.push({
                kind: "card",
                stack: items[i],
                index: invStacks.indexOf(items[i]),
                x: col * (cardSize + gap),
                y: contentY + row * (cardSize + gap),
                w: cardSize,
                h: cardSize
            });
        }

        const rowsUsed = Math.ceil(items.length / cols);
        contentY += rowsUsed * cardSize + Math.max(0, rowsUsed - 1) * gap + 8;
    }

    const contentH = Math.max(0, contentY);
    canvasUI.invMaxScroll = Math.max(0, contentH - viewportH);
    canvasUI.invScroll = clamp(canvasUI.invScroll, 0, canvasUI.invMaxScroll);

    const gridX = panelX + panelPad;
    const viewportX = gridX;
    const viewportY = panelY + titleH + filterH;
    const viewportW = gridW;

    canvasUI.invViewport = {
        x: viewportX,
        y: viewportY,
        w: viewportW,
        h: viewportH
    };

    // Clip scrolling area.
    ctx.save();
    ctx.beginPath();
    ctx.rect(viewportX, viewportY, viewportW, viewportH);
    ctx.clip();

    const scroll = canvasUI.invScroll;

    for (const entry of entries) {
        const drawY = viewportY + entry.y - scroll;

        if (drawY > viewportY + viewportH) continue;
        if (drawY + entry.h < viewportY) continue;

        if (entry.kind === "header") {
            const rarity = entry.rarity;
            const info = rarityStatic[rarity] || {
                name: `Rarity ${rarity}`,
                color: "#ffffff"
            };

            const lineY = drawY + sectionHeaderH / 2;

            ctx.strokeStyle = "rgba(40,80,120,0.65)";
            ctx.lineWidth = 4;

            ctx.beginPath();
            ctx.moveTo(gridX, lineY);
            ctx.lineTo(panelX + panelW / 2 - 42, lineY);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(panelX + panelW / 2 + 42, lineY);
            ctx.lineTo(gridX + gridW, lineY);
            ctx.stroke();

            ctx.font = "900 14px Ubuntu, Arial, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.lineWidth = 3;
            ctx.strokeStyle = "#000000";
            ctx.fillStyle = info.color;

            ctx.strokeText(info.name, panelX + panelW / 2, lineY);
            ctx.fillText(info.name, panelX + panelW / 2, lineY);

            continue;
        }

        if (entry.kind === "card") {
            const st = entry.stack;

            const x = gridX + entry.x;
            const y = viewportY + entry.y - scroll;

            if (y + cardSize < viewportY || y > viewportY + viewportH) continue;

            const canCraft = st.count >= 5 && (st.rarity ?? 0) < 8;

            const slot = {
                kind: "inv",
                index: entry.index,
                invIndex: canvasUI.invStackEnabled
                    ? (st.highestInvIndex ?? st.indices[0])
                    : st.indices[0],
                x,
                y,
                w: cardSize,
                h: cardSize,
                craftZone: canCraft
                    ? {
                        x: x + cardSize - 26,
                        y: y + cardSize - 26,
                        w: 22,
                        h: 22
                    }
                    : null
            };

            canvasUI.invSlots.push(slot);

            drawPetalCard(x, y, st.typeId || "basic", st.rarity ?? 0, {
                size: cardSize,
                label: st.label || st.typeId || "petal"
            });

            if (canCraft) {
                ctx.save();

                ctx.fillStyle = "rgba(0,0,0,0.72)";
                ctx.strokeStyle = "rgba(255,255,255,0.85)";
                ctx.lineWidth = 2;
                roundRect(
                    ctx,
                    slot.craftZone.x,
                    slot.craftZone.y,
                    slot.craftZone.w,
                    slot.craftZone.h,
                    6
                );

                ctx.fillStyle = "#ffffff";
                ctx.font = "900 14px Ubuntu, Arial, sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(
                    "↑",
                    slot.craftZone.x + slot.craftZone.w / 2,
                    slot.craftZone.y + slot.craftZone.h / 2 + 1
                );

                ctx.restore();
            }

            if (st.count > 1) {
                ctx.font = "900 15px Ubuntu, Arial, sans-serif";
                ctx.textAlign = "right";
                ctx.textBaseline = "top";
                ctx.lineWidth = 4;
                ctx.strokeStyle = "#000000";
                ctx.fillStyle = "#ffffff";

                const countText = `x${st.count}`;
                ctx.strokeText(countText, x + cardSize - 3, y + 1);
                ctx.fillText(countText, x + cardSize - 3, y + 1);
            }
        }
    }

    ctx.restore();

    // Scrollbar
    if (canvasUI.invMaxScroll > 0) {
        const trackX = panelX + panelW - 15;
        const trackY = viewportY;
        const trackH = viewportH;
        const thumbH = Math.max(32, trackH * (viewportH / contentH));
        const thumbY = trackY + (trackH - thumbH) * (canvasUI.invScroll / canvasUI.invMaxScroll);

        ctx.fillStyle = "rgba(0,0,0,0.16)";
        roundRect(ctx, trackX, trackY, 7, trackH, 4);

        ctx.fillStyle = "rgba(255,255,255,0.28)";
        roundRect(ctx, trackX, thumbY, 7, thumbH, 4);
    }

    ctx.restore();
}

function drawDraggedCanvasItem(me) {
    const drag = canvasUI.dragging;
    if (!drag) return;

    let item = null;

    if (drag.kind === "slot") {
        const pt = me.petals[drag.index];
        if (pt) {
            item = {
                typeId: pt.typeId,
                rarity: pt.rarity ?? 0,
                label: pt.label || pt.typeId || "petal"
            };
        }
    } else if (drag.kind === "inv") {
        const st = invStacks[drag.index];
        if (st) {
            item = {
                typeId: st.typeId,
                rarity: st.rarity ?? 0,
                label: st.label || st.typeId || "petal"
            };
        }
    }

    if (!item) return;

    const dragSize = 86;

    drawPetalCard(
        canvasUI.mouseX - dragSize / 2,
        canvasUI.mouseY - dragSize / 2,
        item.typeId,
        item.rarity,
        {
            size: dragSize,
            label: item.label,
            alpha: 0.88
        }
    );
}

function handleCanvasUIMouseDown(mx, my, button, shiftCraft = false) {
    if (button !== 0) return false;

    for (const btn of canvasUI.buttons) {
        if (pointInRect(mx, my, btn)) {
            if (btn.label === "⚙") {
                canvasUI.settingsOpen = !canvasUI.settingsOpen;
                return true;
            }

            if (btn.label === "SETTINGS_TOGGLE") {
                canvasUI.settingsOpen = !canvasUI.settingsOpen;
                return true;
            }

            if (btn.label === "SET_HITBOXES") {
                showHitboxes = !showHitboxes;
                return true;
            }

            if (btn.label === "SET_MOB_UI") {
                showMobUI = !showMobUI;
                return true;
            }

            if (btn.label === "SET_MOUSE_MOVE") {
                mouseMovement = !mouseMovement;
                input.mouseMove = mouseMovement;
                return true;
            }

            if (btn.label === "SET_CHANGELOG") {
                canvasUI.changelogOpen = !canvasUI.changelogOpen;
                return true;
            }

            if (btn.label === "CHANGELOG_CLOSE") {
                canvasUI.changelogOpen = false;
                return true;
            }

            if (btn.label === "HB") showHitboxes = !showHitboxes;
            if (btn.label === "MOB") showMobUI = !showMobUI;
            if (btn.label === "INV") canvasUI.inventoryOpen = !canvasUI.inventoryOpen;
            if (btn.label === "INV_CLOSE") canvasUI.inventoryOpen = false;
            if (btn.label === "INV_STACK") {
                canvasUI.invStackEnabled = !canvasUI.invStackEnabled;
                canvasUI.invScroll = 0;
            }

            return true;
        }
    }

    const allSlots = [...canvasUI.petalSlots, ...canvasUI.invSlots];

    for (const slot of allSlots) {
        if (pointInRect(mx, my, slot)) {
            // Inventory cards can be crafted by clicking the little craft zone.
            // Normal click = one craft attempt.
            // Shift click = craft all possible attempts.
            if (slot.kind === "inv" && slot.craftZone && pointInRect(mx, my, slot.craftZone)) {
                const st = invStacks[slot.index];

                if (st && st.count >= 5) {
                    safeWsSend({
                        t: shiftCraft ? "craft_all_petals" : "craft_petal",
                        typeId: st.typeId,
                        rarity: st.rarity ?? 0
                    });
                }

                return true;
            }

            canvasUI.dragging = {
                kind: slot.kind,
                index: slot.index,
                invIndex: slot.invIndex ?? null
            };
            return true;
        }
    }

    return false;
}

function handleCanvasUIMouseUp(mx, my) {
    const src = canvasUI.dragging;
    if (!src) return;

    const allSlots = [...canvasUI.petalSlots, ...canvasUI.invSlots];
    const dst = allSlots.find(slot => pointInRect(mx, my, slot));

    if (!dst || ws.readyState !== WebSocket.OPEN) {
        canvasUI.dragging = null;
        return;
    }

    if (src.kind === dst.kind && src.index === dst.index) {
        canvasUI.dragging = null;
        return;
    }

    if (src.kind === "slot" && dst.kind === "slot") {
        safeWsSend({
            t: "petal_swap",
            a: src.index,
            b: dst.index
        });
    }

    if (src.kind === "inv" && dst.kind === "slot") {
        safeWsSend({
            t: "inv_swap_slot",
            inv: src.invIndex,
            slot: dst.index
        });
    }

    if (src.kind === "slot" && dst.kind === "inv") {
        safeWsSend({
            t: "inv_swap_slot",
            inv: dst.invIndex,
            slot: src.index
        });
    }

    if (src.kind === "inv" && dst.kind === "inv") {
        safeWsSend({
            t: "inv_swap_inv",
            a: src.invIndex,
            b: dst.invIndex
        });
    }

    canvasUI.dragging = null;
}

// -------------------- Drawing --------------------
function drawCircle(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
}

function drawGardenBackground(viewMinX, viewMaxX, viewMinY, viewMaxY) {
    if (!gardenTileLoaded) return;

    ctx.imageSmoothingEnabled = false;

    if (mapWalls) {
        const tw = mapWalls.tilewidth || 32;
        const th = mapWalls.tileheight || 32;
        const width = mapWalls.width || Math.ceil(world.w / tw);
        const height = mapWalls.height || Math.ceil(world.h / th);

        const startTx = clamp(Math.floor(viewMinX / tw) - 1, 0, Math.max(0, width - 1));
        const endTx = clamp(Math.ceil(viewMaxX / tw) + 1, 0, Math.max(0, width - 1));
        const startTy = clamp(Math.floor(viewMinY / th) - 1, 0, Math.max(0, height - 1));
        const endTy = clamp(Math.ceil(viewMaxY / th) + 1, 0, Math.max(0, height - 1));

        for (let ty = startTy; ty <= endTy; ty++) {
            for (let tx = startTx; tx <= endTx; tx++) {
                ctx.drawImage(gardenTile, tx * tw, ty * th, tw + 1, th + 1);
            }
        }
        return;
    }

    const tw = 32;
    const th = 32;
    const width = Math.ceil(world.w / tw);
    const height = Math.ceil(world.h / th);

    const startTx = clamp(Math.floor(viewMinX / tw) - 1, 0, Math.max(0, width - 1));
    const endTx = clamp(Math.ceil(viewMaxX / tw) + 1, 0, Math.max(0, width - 1));
    const startTy = clamp(Math.floor(viewMinY / th) - 1, 0, Math.max(0, height - 1));
    const endTy = clamp(Math.ceil(viewMaxY / th) + 1, 0, Math.max(0, height - 1));

    for (let ty = startTy; ty <= endTy; ty++) {
        for (let tx = startTx; tx <= endTx; tx++) {
            ctx.drawImage(gardenTile, tx * tw, ty * th, tw + 1, th + 1);
        }
    }
}

function drawMapWalls(viewMinX, viewMaxX, viewMinY, viewMaxY) {
    if (!mapWalls || !Array.isArray(mapWalls.data)) return;

    ctx.fillStyle = "#00000044";
    ctx.imageSmoothingEnabled = false;

    const tw = mapWalls.tilewidth || 32;
    const th = mapWalls.tileheight || 32;
    const width = mapWalls.width || 0;
    const height = mapWalls.height || 0;

    if (!width || !height) return;

    const startTx = clamp(Math.floor(viewMinX / tw) - 1, 0, width - 1);
    const endTx = clamp(Math.ceil(viewMaxX / tw) + 1, 0, width - 1);
    const startTy = clamp(Math.floor(viewMinY / th) - 1, 0, height - 1);
    const endTy = clamp(Math.ceil(viewMaxY / th) + 1, 0, height - 1);

    for (let ty = startTy; ty <= endTy; ty++) {
        const row = ty * width;
        for (let tx = startTx; tx <= endTx; tx++) {
            const idx = row + tx;
            if (mapWalls.data[idx] > 0) {
                ctx.fillRect(tx * tw, ty * th, tw + 1, th + 1);
            }
        }
    }
}

const rarityStatic = {
    0: { name: "Common", color: "#7EEF6D" },
    1: { name: "Uncommon", color: "#FFE65D" },
    2: { name: "Rare", color: "#4C56DB" },
    3: { name: "Epic", color: "#861FDE" },
    4: { name: "Legendary", color: "#DE1F1F" },
    5: { name: "Mythical", color: "#1FDBDE" },
    6: { name: "Ultimate", color: "#FF2B75" },
    7: { name: "Supreme", color: "#2BFFA3" },
    8: { name: "Exotic", color: "#C643FF" },
    9: { name: "Majestic", color: "#FF9B11" },
    10: { name: "Sublime", color: "#222222", },
};

function drawDeathMobs(viewMinX, viewMaxX, viewMinY, viewMaxY) {
    const t = clientNowSec();

    for (const [id, mob] of deathMobs) {
        const p = (t - mob._deathStart) / DEATH_ANIM_DURATION;

        if (p >= 1) {
            deathMobs.delete(id);
            continue;
        }

        const x = mob.x;
        const y = mob.y;
        const r = mob.radius || MOB_RADIUS;

        if (
            x + r * 2 < viewMinX ||
            x - r * 2 > viewMaxX ||
            y + r * 2 < viewMinY ||
            y - r * 2 > viewMaxY
        ) {
            continue;
        }

        Render.drawMob(
            ctx,
            {
                ...mob,
                _deathProgress: p
            },
            x,
            y,
            r
        );
    }
}

function drawDeathPetals(viewMinX, viewMaxX, viewMinY, viewMaxY) {
    const t = clientNowSec();

    for (const [id, petal] of deathPetals) {
        const p = (t - petal._deathStart) / DEATH_ANIM_DURATION;

        if (p >= 1) {
            deathPetals.delete(id);
            continue;
        }

        const x = petal.x;
        const y = petal.y;
        const r = petal.radius || PETAL.radius;

        if (
            x + r * 2 < viewMinX ||
            x - r * 2 > viewMaxX ||
            y + r * 2 < viewMinY ||
            y - r * 2 > viewMaxY
        ) {
            continue;
        }

        Render.drawPetalArtFlash(
            ctx,
            {
                typeId: petal.typeId,
                rarity: petal.rarity ?? 0,
                hp: petal.hp,
                angle: petal.angle ?? 0,
                flashId: petal.flashId ?? id,
                _deathProgress: p
            },
            x,
            y,
            r
        );
    }
}

function render() {
    requestAnimationFrame(render);

    const view = getInterpolatedState();
    if (view) {
        world = view.world || world;
        state.players = safeArray(view.players);
        state.mobs = safeArray(view.mobs);
        state.pickups = safeArray(view.pickups);
        state.mobObjects = safeArray(view.mobObjects);
    }

    updateDeathTracking();

    const me = state.players.find(p => p.id === myId);
    if (me) rebuildInvStacks(me);

    // clear screen
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // camera center in world coords
    const camX = me ? me.x : world.w / 2;
    const camY = me ? me.y : world.h / 2;

    // WORLD -> SCREEN: scale, then translate so cam is centered
    ctx.setTransform(
        zoom, 0, 0, zoom,
        canvas.width / 2 - camX * zoom,
        canvas.height / 2 - camY * zoom
    );

    // derive world-space viewport rectangle for cheap culling
    const halfW = canvas.width / 2 / zoom;
    const halfH = canvas.height / 2 / zoom;
    const viewMinX = camX - halfW;
    const viewMaxX = camX + halfW;
    const viewMinY = camY - halfH;
    const viewMaxY = camY + halfH;

    // from here on: draw EVERYTHING in WORLD coords, WORLD radii

    // draw only the visible background/walls instead of redrawing the entire map every frame
    drawGardenBackground(viewMinX, viewMaxX, viewMinY, viewMaxY);
    drawMapWalls(viewMinX, viewMaxX, viewMinY, viewMaxY);

    ctx.globalAlpha = 1;

    // spawn areas
    /*if (spawnAreas.length > 0) {
        ctx.fillStyle = "rgba(0,255,0,0.15)";
        for (const area of spawnAreas) {
            if (area.polygon && area.polygon.length > 0) {
                ctx.beginPath();
                area.polygon.forEach((p, i) => {
                    const x = p.x + area.x;
                    const y = p.y + area.y;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                });
                ctx.closePath();
                ctx.fill();
            } else {
                ctx.beginPath();
                ctx.arc(area.x, area.y, 10, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }*/

    // mobObjects (projectiles, etc.)
    if (state.mobObjects && state.mobObjects.length) {
        for (const o of state.mobObjects) {
            const x = o.x;
            const y = o.y;
            const r = (o.radius || 6);

            if (x + r < viewMinX || x - r > viewMaxX || y + r < viewMinY || y - r > viewMaxY) continue;
            ctx.save();
            Render.drawMobObject(ctx, o, x, y, r);
            if (showHitboxes) drawHitCircle(x, y, r);
            ctx.restore();
        }
    }

    // pickups
    for (const k of state.pickups) {
        const cardSize = 34;
        const half = cardSize / 2;

        if (
            k.x + half < viewMinX ||
            k.x - half > viewMaxX ||
            k.y + half < viewMinY ||
            k.y - half > viewMaxY
        ) continue;

        ctx.save();

        // drawPetalCard expects top-left x/y, not center x/y.
        drawPetalCard(
            k.x - half,
            k.y - half,
            k.typeId,
            k.rarity ?? 0,
            {
                size: cardSize,
                label: k.label || k.typeId
            }
        );

        ctx.restore();
    }

    // mobs (ALWAYS draw mobs; only UI is toggleable)
    {
        // styles that don't change per-mob are set once outside the loop
        ctx.font = "bold 7px Ubuntu, sans-serif";
        ctx.textBaseline = "bottom";
        ctx.strokeStyle = "#000";

        for (const m of state.mobs) {
            const x = m.x;
            const y = m.y;
            const r = (m.radius || MOB_RADIUS);

            // simple bounding square cull
            if (x + r < viewMinX || x - r > viewMaxX || y + r < viewMinY || y - r > viewMaxY) continue;

            // mob body ALWAYS
            Render.drawMob(ctx, m, x, y, r);
            if (showHitboxes) drawHitCircle(x, y, r);

            // mob UI OPTIONAL
            if (showMobUI) {
                Render.drawHpBar(ctx, x, y, r, m.hp, m.maxHp, m.rarity);
                const barW = 45 * Math.pow(1.05, m.rarity);
                const yPos = y + r + 10;
                const nameY = yPos - 1;
                const rarityY = yPos + 12;

                if (m.label) {
                    ctx.textAlign = "left";
                    ctx.strokeStyle = "#000";
                    ctx.fillStyle = "#fff";
                    const tx = x - (barW / 2);
                    ctx.lineWidth = 2;
                    ctx.strokeText(m.label, tx, nameY);
                    ctx.fillText(m.label, tx, nameY);
                }

                if (m.rarity !== undefined && m.rarity !== null) {
                    const rr = Number(m.rarity);
                    const info = rarityStatic[rr];
                    ctx.textAlign = "right";
                    ctx.strokeStyle = "#000";
                    ctx.fillStyle = info?.color || "#fff";
                    const tx = x + (barW / 2);
                    const txt = info?.name || "Unknown";
                    ctx.lineWidth = 2;
                    ctx.strokeText(txt, tx, rarityY);
                    ctx.fillText(txt, tx, rarityY);
                }
            }
        }

        drawDeathMobs(viewMinX, viewMaxX, viewMinY, viewMaxY);
    }

    // players + petals
    for (const p of state.players) {
        const x = p.x;
        const y = p.y;
        const r = p.radius || PLAYER_RADIUS;

        // simple viewport cull
        if (
            x + r < viewMinX ||
            x - r > viewMaxX ||
            y + r < viewMinY ||
            y - r > viewMaxY
        ) {
            continue;
        }

        const flowerRenderState =
            p.id === myId
                ? {
                    ...p,
                    isSelf: true,
                    offensiveMode: !!input.extend,
                    defensiveMode: !!input.retract
                }
                : {
                    ...p,
                    isSelf: false,
                    offensiveMode: false,
                    defensiveMode: false
                };

        Render.drawPlayerFlower(ctx, x, y, r, flowerRenderState);

        // player hp bar
        const bw = 52, bh = 7;
        const pct = clamp((p.hp ?? p.maxHp ?? 1) / Math.max(1, p.maxHp ?? 1), 0, 1);

        ctx.fillStyle = "rgba(42, 56, 44, 0.55)";
        ctx.fillRect(x - bw / 2, y + r + 10, bw, bh);

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x - bw / 2, y + r + 10, bw * pct, bh);

        const playerPetals = safeArray(p.petals);
        for (let i = 0; i < playerPetals.length; i++) {
            const pt = playerPetals[i];
            const wp = p.petalPos?.[i];
            if (!wp) continue;

            drawPetalOrMulti(pt, wp, i, p.id ?? myId ?? "unknown");
        }
    }

    drawDeathPetals(viewMinX, viewMaxX, viewMinY, viewMaxY);

    // reset transform back to screen space for canvas UI
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (me) {
        const bossMob = getNearbyBossMob(me, state.mobs, 750);
        drawBossHpBar(bossMob);

        drawCanvasBottomUI(me);
        if (canvasUI.inventoryOpen) drawCanvasInventory(me);
        drawDraggedCanvasItem(me);
        drawChangelogOverlay();
        drawCraftNotice();
        drawChatOverlay();
        ctx.fillStyle = "#000000";
        ctx.font = "10px Ubuntu, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(`${me.x}, ${me.y}`, canvas.width / 100 + 1000, canvas.height / 100);
    }

    function drawCraftNotice() {
        if (!craftNotice || performance.now() > craftNoticeUntil) return;

        ctx.save();

        const w = Math.min(620, canvas.width - 40);
        const h = 44;
        const x = canvas.width / 2 - w / 2;
        const y = 24;

        ctx.fillStyle = "rgba(0,0,0,0.68)";
        ctx.strokeStyle = "rgba(255,255,255,0.24)";
        ctx.lineWidth = 2;
        roundRect(ctx, x, y, w, h, 14);

        ctx.fillStyle = "#ffffff";
        ctx.font = "900 17px Ubuntu, Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(craftNotice, x + w / 2, y + h / 2);

        ctx.restore();
    }

    // UI text for me (DOM debug text)
    if (me && meEl) {
        const lines = [];
        lines.push(`HP: ${Math.floor(me.hp)}/${me.maxHp}`);
        lines.push(`Pos: ${Math.floor(me.x)}, ${Math.floor(me.y)}`);
        lines.push(`Petals: drag bottom boxes to swap (swapped petals reload)`);
        lines.push(`Inventory: ${me.inv?.length ?? 0} items (press I)`);
        for (let i = 0; i < safeArray(me.petals).length; i++) {
            const pt = me.petals[i];
            const reloadLeft = pt.reloadLeft ?? 0;
            const status = (reloadLeft > 0 || (pt.hp ?? 1) <= 0)
                ? `RELOAD ${reloadLeft.toFixed(1)}s`
                : `${pt.hp ?? "?"}/${pt.maxHp ?? "?"}`;
            lines.push(`  ${i + 1}. ${pt.typeId} R${pt.rarity ?? 0} (${status})`);
        }
        meEl.textContent = lines.join("\n");
    }
}

function drawHitCircle(x, y, r) {
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

render();
