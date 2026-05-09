/* global window */
"use strict";

/**
 * Mob render helpers
 * API:
 *   Render.drawMob(ctx, mob, x, y, r)
 *   Render.drawHpBar(ctx, x, y, r, hp, maxHp)
 *
 * `mob` should include `vx`/`vy` when available; the renderer will use the
 * speed to proportionaly accelerate animations (ants bobbing, beetle
 * legs, etc.).
 *
 * Coordinates passed in are SCREEN coords (already camera-adjusted).
 * r is the "base radius" you used before (MOB_RADIUS).
 */

(function () {
    const TAU = Math.PI * 2;

    function withTransform(ctx, x, y, scale, fn) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(scale, scale);
        fn();
        ctx.restore();
    }

    function drawPolygon(
        ctx,
        x,
        y,
        sides,
        radius,
        angle,
        widthStretch,
        heightStretch
    ) {
        const step = (2 * Math.PI) / sides; // Step between each vertex in the polygon
        ctx.beginPath();

        // Loop through each vertex and plot it
        for (let i = 0; i < sides; i++) {
            const currentAngle = angle + i * step; // Rotate the angle for each vertex
            const vex = x + Math.cos(currentAngle) * radius * widthStretch; // Adjust x based on width stretch
            const vey = y + Math.sin(currentAngle) * radius * heightStretch; // Adjust y based on height stretch
            if (i === 0) {
                ctx.moveTo(vex, vey); // Move to the first vertex
            } else {
                ctx.lineTo(vex, vey); // Draw lines to the next vertex
            }
        }
        ctx.closePath();
    }

    function clamp(v, a, b) {
        return Math.max(a, Math.min(b, v));
    }

    function nowSec() {
        return (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
    }

    // when a mob moves faster its local animation clock will tick more quickly.
    // this constant is multiplied by the speed (px/sec) to get a simple
    // frequency multiplier.  0.005 gives about a 75–100% boost at typical
    // mob speeds (140‑170) without getting ridiculous.  tweak as needed.
    const ANIM_SPEED_SCALE = 0.009;

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

    const FLASH_RED = "#ff0000";
    let _flashA = 0; // current mob's flash alpha (0..1)

    // flash a hex color toward red
    function F(hex) {
        if (_flashA <= 0) return hex;
        return blendHex(hex, FLASH_RED, _flashA);
    }

    // do your existing blend, then flash the result toward red
    function FB(a, b, p) {
        return F(blendHex(a, b, p));
    }

    function computeDamageFlash(id, hp) {
        const t = nowSec();

        if (id != null) {
            const prevHp = lastHpById.get(id);

            if (prevHp != null && hp != null && hp < prevHp) {
                flashEndById.set(id, t + FLASH_DURATION);
            }

            if (hp != null) {
                lastHpById.set(id, hp);
            }
        }

        let flashAlpha = 0;

        if (id != null) {
            const end = flashEndById.get(id) || 0;
            const left = end - t;

            if (left > 0) {
                const k = clamp(left / FLASH_DURATION, 0, 1);
                flashAlpha = k * FLASH_STRENGTH;
            } else if (end !== 0) {
                flashEndById.delete(id);
            }
        }

        return flashAlpha;
    }

    //most colors used from floof source code
    const colors = {
        mecha: "#999999",
        antGray: "#454545",
        darkGray: "#333333",
        account: "#7EEF6D",
        absorb: "#895adc",
        skillTree: "#dc5a5a",
        inventory: "#5a9edb",
        settings: "#C8C8C8",
        crafting: "#DB9D5A",
        mobGallery: "#DBD64A",
        team1: "#00B2E1",
        team2: "#F14E54",
        white: "#FFFFFF",
        peach: "#FFF0B7",
        cumWhite: "#ffffC9",
        black: "#000000",
        rosePink: "#FC93C5",
        irisPurple: "#CD75DE",
        pollenGold: "#FEE86B",
        peaGreen: "#8CC05B",
        sandGold: "#DDC758",
        grapePurple: "#C973D8",
        leafGreen: "#3AB54A",
        uraniumLime: "#66BB2A",
        honeyGold: "#F5D230",
        hornet: "#FED263",
        lightningTeal: "#00FFFF",
        rockGray: "#7B727C",
        stingerBlack: "#222222",
        lighterBlack: "#353535",
        cactusGreen: "#39C660",
        cactusLightGreen: "#75D68F",
        bubbleGrey: "#B8B8B8",
        playerYellow: "#FFE763",
        scorpionBrown: "#C69A2D",
        diepBlue: "#00BEFF",
        diepSquare: "#ffe46b",
        diepTriangle: "#fc7676",
        diepPentagon: "#768cfc",
        ladybugRed: "#EB4034",
        evilLadybugRed: "#962921",
        shinyLadybugGold: "#ebeb34",
        hellMobColor: "#AA1C1D",
        beeYellow: "#FFE763",
        pincer: "#2a2a2a",
        antHole: "#A8711E",
        ants: "#555555",
        fireAnt: "#a82a01",
        termite: "#d3a35b",
        wasp: "#9f4627",
        waspDark: "#34221c",
        jellyfish: "#EFEFEF",
        spider: "#4f412e",
        darkGreen: "#118240",
        beetlePurple: "#915db0",
        roach: "#9D4F23",
        roachHead: "#6C3419",
        fireFlyLight: "#EFDECC",
        sand: "#E1C85D",
        jelly: "#D5B5D3",
        orange: "#F1BC48",
        starfish: "#AA403F",
        book: "#c28043",
        bookSpine: "#c28043",
        shrubGreen: "#0b7240",
        crabBodyOrange: "#dc704b",
        crabLimbBrown: "#4d2621"
    }

    function polygonPath(ctx, sides, radius, angle, widthStretch, heightStretch) {
        for (let i = 0; i < sides; i++) {
            const currentAngle = angle + i * (TAU / sides);
            const vex = Math.cos(currentAngle) * radius * widthStretch;
            const vey = Math.sin(currentAngle) * radius * heightStretch;
            ctx.lineTo(vex, vey);
        }
    }

    function drawPolygonPath(ctx, sides, radius, angle = 0, widthStretch = 1, heightStretch = 1) {
        if (sides < 3) return;

        ctx.beginPath();

        for (let i = 0; i < sides; i++) {
            const currentAngle = angle + i * (TAU / sides);
            const vex = Math.cos(currentAngle) * radius * widthStretch;
            const vey = Math.sin(currentAngle) * radius * heightStretch;

            if (i === 0) {
                ctx.moveTo(vex, vey);
            } else {
                ctx.lineTo(vex, vey);
            }
        }

        ctx.closePath();
    }

    // ---- Damage flash tracking ----
    const lastHpById = new Map();     // id -> last known hp
    const flashEndById = new Map();   // id -> time (sec) when flash ends

    const FLASH_DURATION = 0.12;      // seconds
    const FLASH_STRENGTH = 0.85;      // 0..1 alpha cap

    function drawBabyAnt(ctx, x, y, r, t) {
        const s = r;
        const anim = Math.sin(t * 8) * 0.05;

        withTransform(ctx, x, y, s, () => {
            ctx.lineWidth = 0.375;

            ctx.strokeStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(-.1, 0.55);
            ctx.lineTo(1.25, 0.25 + anim);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(-.1, -0.55);
            ctx.lineTo(1.25, -0.25 - anim);
            ctx.stroke();

            ctx.strokeStyle = FB(colors.antGray, "#000000", 0.025);
            ctx.fillStyle = F("#555555");

            ctx.beginPath();
            ctx.arc(0, 0, 0.8, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.scale(0.7, 0.7);
            ctx.translate(0.5, 0);

            ctx.fillStyle = F(colors.darkGray);
            ctx.strokeStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(-.1, 0.55);
            ctx.lineTo(1.5, 1.3);
            ctx.quadraticCurveTo(0.6, 0.3, -.1, 0.55);
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(-.1, -0.55);
            ctx.lineTo(1.5, -1.3);
            ctx.quadraticCurveTo(0.6, -0.3, -.1, -0.55);
            ctx.fill();
            ctx.stroke();

            ctx.restore();
        });
    }

    function drawEgg(ctx, x, y, r, color) {
        withTransform(ctx, x, y, r, () => {
            ctx.lineWidth = 0.275;

            ctx.strokeStyle = FB(color, "#000000", 0.15);
            ctx.fillStyle = F(color);

            ctx.beginPath();
            ctx.arc(0, 0, 1, 0, TAU);
            ctx.fill();
            ctx.stroke();
        });
    }

    function drawWorkerAnt(ctx, x, y, r, t) {
        const s = r;
        const anim = Math.sin(t * 8) * 0.05;

        withTransform(ctx, x, y, s, () => {
            ctx.lineWidth = 0.375;

            ctx.strokeStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(0.4, 0.55);
            ctx.lineTo(1.75, 0.25 + anim);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(0.4, -0.55);
            ctx.lineTo(1.75, -0.25 - anim);
            ctx.stroke();

            ctx.strokeStyle = FB(colors.antGray, "#000000", 0.025);
            ctx.fillStyle = F("#555555");

            ctx.beginPath();
            ctx.arc(-0.45, 0, 0.57, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(0.5, 0, 0.8, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.scale(0.7, 0.7);
            ctx.translate(0.5, 0);

            ctx.fillStyle = F(colors.darkGray);
            ctx.strokeStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(0.4, 0.55);
            ctx.lineTo(2, 1.3);
            ctx.quadraticCurveTo(1.1, 0.3, 0.4, 0.55);
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0.4, -0.55);
            ctx.lineTo(2, -1.3);
            ctx.quadraticCurveTo(1.1, -0.3, 0.4, -0.55);
            ctx.fill();
            ctx.stroke();

            ctx.restore();
        });
    }
    function drawDandysWorld(ctx, x, y, r) {
        const s = r;
        withTransform(ctx, x, y, s, () => {
            ctx.lineWidth = 0.1;
            ctx.strokeStyle = FB(colors.white, "#000000", 0.15);
            ctx.fillStyle = F(colors.white);
            ctx.beginPath();
            ctx.arc(0, 0, 1, 0, TAU);
            ctx.fill();
            ctx.stroke();
        });
    }
    function drawMechaTermite(ctx, x, y, r, t) {
        const s = r;
        const anim = Math.sin(t * 8) * 0.05;

        withTransform(ctx, x, y, s, () => {
            ctx.lineWidth = 0.375;

            ctx.strokeStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(0.4, 0.55);
            ctx.lineTo(1.7, 0.45 + anim / 2);
            ctx.lineTo(1.9, 0.25 + anim);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(0.4, -0.55);
            ctx.lineTo(1.7, -0.45 - anim / 2);
            ctx.lineTo(1.9, -0.25 - anim);
            ctx.stroke();

            ctx.strokeStyle = FB(colors.mecha, "#000000", 0.15);
            ctx.fillStyle = F(colors.mecha);

            ctx.beginPath();
            ctx.arc(-0.45, 0, 0.57, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(0.5, 0, 0.8, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.scale(0.7, 0.7);
            ctx.translate(0.5, 0);

            ctx.fillStyle = F(colors.darkGray);
            ctx.strokeStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(0.4, 0.55);
            ctx.lineTo(2, 1.3);
            ctx.quadraticCurveTo(1.1, 0.3, 0.4, 0.55);
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0.4, -0.55);
            ctx.lineTo(2, -1.3);
            ctx.quadraticCurveTo(1.1, -0.3, 0.4, -0.55);
            ctx.fill();
            ctx.stroke();

            ctx.restore();
        });
    }

    function drawLadybug(ctx, x, y, r, randoms, rarity, color, color2) {
        withTransform(ctx, x, y, r, () => {
            ctx.lineWidth = 0.195;

            ctx.fillStyle = F(colors.darkGray);
            ctx.strokeStyle = FB(colors.darkGray, "#000000", 0.125);
            ctx.beginPath();
            ctx.arc(0.5, 0, 0.5, 0, TAU);
            ctx.fill();
            ctx.stroke();

            const D2R = Math.PI / 180;

            const body = new Path2D();
            body.arc(0, 0, 1, 45 * D2R, -45 * D2R);
            body.arc(1.12, 0, 0.7, -118.3 * D2R, 118.3 * D2R, true);
            body.closePath();

            // body
            ctx.fillStyle = F(color);
            ctx.strokeStyle = FB(color, "#000000", 0.125);
            ctx.fill(body);
            ctx.stroke(body);

            // ---- random spots ----
            const rr = Array.isArray(randoms) ? randoms : [];
            const n = Math.min(10, Math.max(1, 1 + Math.floor(((rr[6] ?? 0.5) * 10)))); // 1..10 from randoms[6]

            const fract = (v) => v - Math.floor(v);
            const rand01 = (i, salt) => {
                const base = rr.length ? (rr[(i * 3 + salt) % rr.length] ?? 0.5) : 0.5;
                return fract(Math.sin((base + 1) * 1000 + i * 12.9898 + salt * 78.233) * 43758.5453);
            };

            ctx.save();
            ctx.clip(body);

            ctx.fillStyle = F(color2); // spots
            ctx.lineWidth = 0.12;

            const placed = [];
            let done = 0;

            for (let t = 0; done < n && t < n * 10; t++) {
                const u = rand01(t, 0);
                const v = rand01(t, 1);
                const s = rand01(t, 2);

                // spot position range inside the shell-ish area (clip will hard-limit it anyway)
                const px = 0.05 + u * 1.05;    // ~[0.05..1.10]
                const py = -0.55 + v * 1.10;   // ~[-0.55..0.55]
                const sr = 0.10 + s * 0.16;    // ~[0.10..0.26]

                // simple overlap avoidance
                let ok = true;
                if (!ok) continue;

                placed.push({ x: px, y: py, r: sr });

                ctx.beginPath();
                ctx.arc(px, py, sr * Math.pow(1.15, rarity), 0, Math.PI * 2);
                ctx.fill();

                done++;
            }

            ctx.restore();

            ctx.strokeStyle = FB(color, "#000000", 0.125);
            ctx.stroke(body);

            //antennae
            ctx.lineWidth = 0.12;
            ctx.fillStyle = F(colors.darkGray);
            ctx.strokeStyle = F(colors.darkGray);

            ctx.beginPath();
            ctx.moveTo(0.9, 0.19);
            ctx.quadraticCurveTo(1.12, 0.19, 1.35, 0.43);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(1.35, 0.43, 0.15, 0, TAU);
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(0.9, -0.19);
            ctx.quadraticCurveTo(1.12, -0.19, 1.35, -0.43);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(1.35, -0.43, 0.15, 0, TAU);
            ctx.fill();
        });
    }

    function drawCentipede(ctx, x, y, r, t, color, id) {
        withTransform(ctx, x, y, r, () => {
            ctx.lineWidth = 0.195;

            ctx.fillStyle = F(colors.darkGray);
            ctx.strokeStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.arc(0, 0.8, 0.375, 0, TAU);
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(0, -.8, 0.375, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = F(color);
            ctx.strokeStyle = FB(color, "#000000", 0.125);
            ctx.beginPath();
            ctx.arc(0, 0, 1, 0, TAU);
            ctx.fill();
            ctx.stroke();

            //antennae
            if (id === null) {
                ctx.lineWidth = 0.07;
                ctx.fillStyle = F(colors.darkGray);
                ctx.strokeStyle = F(colors.darkGray);
                ctx.save();
                ctx.scale(1.35, 1.35);
                ctx.translate(-.29, 0);

                ctx.beginPath();
                ctx.moveTo(0.9, 0.19);
                ctx.quadraticCurveTo(1.12, 0.19, 1.35, 0.53);
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(1.35, 0.53, 0.11, 0, TAU);
                ctx.fill();

                ctx.beginPath();
                ctx.moveTo(0.9, -0.19);
                ctx.quadraticCurveTo(1.12, -0.19, 1.35, -0.53);
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(1.35, -0.53, 0.11, 0, TAU);
                ctx.fill();
                ctx.restore();
            }
        });
    }

    function drawMilipede(ctx, x, y, r, t, color, id) {
        withTransform(ctx, x, y, r, () => {
            ctx.lineWidth = 0.254;

            ctx.fillStyle = F(colors.cumWhite);
            ctx.strokeStyle = F(colors.cumWhite);
            ctx.beginPath();
            ctx.arc(0, 0.99, 0.275, 0, TAU);
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(0, -.99, 0.275, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = F(colors.crabLimbBrown);
            ctx.strokeStyle = FB(colors.crabLimbBrown, "#000000", 0.125);
            ctx.beginPath();
            ctx.arc(0, 0, 1, 0, TAU);
            ctx.fill();
            ctx.stroke();

            //antennae
            if (id === null) {
                ctx.save();
                ctx.scale(0.7, 0.7);
                ctx.translate(0.85, 0);

                ctx.fillStyle = F(colors.cumWhite);
                ctx.strokeStyle = F(colors.cumWhite);
                ctx.beginPath();
                ctx.moveTo(-.1, 0.55);
                ctx.lineTo(1.5, 1.3);
                ctx.quadraticCurveTo(0.6, 0.3, -.1, 0.55);
                ctx.fill();
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(-.1, -0.55);
                ctx.lineTo(1.5, -1.3);
                ctx.quadraticCurveTo(0.6, -0.3, -.1, -0.55);
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }
        });
    }

    function drawQueenAnt(ctx, x, y, r, t) {
        const s = r;
        const anim = Math.sin(t * 8) * 0.05;
        const wing = Math.sin(t * 12) * 0.077;

        withTransform(ctx, x, y, s, () => {
            ctx.lineWidth = 0.23;

            ctx.strokeStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(0.4, 0.55);
            ctx.lineTo(1.75, 0.15 + anim);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(0.4, -0.55);
            ctx.lineTo(1.75, -0.15 - anim);
            ctx.stroke();

            ctx.strokeStyle = FB(colors.antGray, "#000000", 0.025);
            ctx.fillStyle = F("#555555");

            ctx.beginPath();
            ctx.arc(-0.75, 0, 1.05, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(0, 0, 0.85, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = F("#9999ff");
            ctx.globalAlpha = 0.6;
            ctx.save();
            ctx.rotate(wing - 0.2);
            ctx.translate(0, 0.3);

            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.rotate(-wing + 0.2);
            ctx.translate(0, -0.3);
            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.globalAlpha = 1;
            ctx.strokeStyle = FB(colors.antGray, "#000000", 0.025);
            ctx.fillStyle = F("#555555");
            ctx.beginPath();
            ctx.arc(0.75, 0, 0.65, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.scale(0.7, 0.7);
            ctx.translate(0.5, 0);

            ctx.strokeStyle = F(colors.darkGray);
            ctx.fillStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(0.4, 0.25);
            ctx.lineTo(2, 1);
            ctx.quadraticCurveTo(1.2, 0.3, 0.4, 0.25);
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0.4, -0.25);
            ctx.lineTo(2, -1);
            ctx.quadraticCurveTo(1.2, -0.3, 0.4, -0.25);
            ctx.fill();
            ctx.stroke();

            ctx.restore();
        });
    }

    function drawFly(ctx, x, y, r, t) {
        const s = r;
        const wing = Math.sin(t * 12) * 0.077;

        withTransform(ctx, x, y, s, () => {
            ctx.lineWidth = 0.375;

            ctx.strokeStyle = FB(colors.antGray, "#000000", 0.025);
            ctx.fillStyle = F("#555555");

            ctx.beginPath();
            ctx.arc(0, 0, 0.8, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.scale(1.35, 1.35);
            ctx.translate(0.153, 0);
            ctx.fillStyle = F("#ffffff");
            ctx.globalAlpha = 0.3;
            ctx.save();
            ctx.rotate(wing - 0.2);
            ctx.translate(0, 0.3);

            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.5125, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.rotate(-wing + 0.2);
            ctx.translate(0, -0.3);
            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.5125, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();
            ctx.restore();
        });
    }

    function drawStonefly(ctx, x, y, r, t) {
        const s = r;
        const anim = Math.sin(t * 8) * 0.05;
        const wing = Math.sin(t * 8) * 0.077;

        withTransform(ctx, x, y, s, () => {
            ctx.lineWidth = 0.31;

            ctx.strokeStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(0.4, 0.55);
            ctx.lineTo(1.75, 0.15 + anim);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(0.4, -0.55);
            ctx.lineTo(1.75, -0.15 - anim);
            ctx.stroke();
            const color = blendHex(colors.diepTriangle, colors.beetlePurple, 0.5);
            ctx.strokeStyle = FB(color, "#000000", 0.15);
            ctx.fillStyle = F(color);

            ctx.beginPath();
            ctx.ellipse(-0.35, 0, 0.95, 0.6, 0, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = F("#ffffff");
            ctx.globalAlpha = 0.6;
            ctx.save();
            ctx.rotate(wing - 0.2);
            ctx.translate(0, 0.3);

            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.rotate(-wing + 0.2);
            ctx.translate(0, -0.3);
            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.globalAlpha = 1;
            ctx.strokeStyle = FB(colors.wasp, "#000000", 0.15);
            ctx.fillStyle = F(colors.wasp);
            ctx.beginPath();
            ctx.arc(0.75, 0, 0.65, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.scale(0.7, 0.7);
            ctx.translate(0.5, 0);

            ctx.strokeStyle = F(colors.darkGray);
            ctx.fillStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(0.4, 0.25);
            ctx.lineTo(3, 1);
            ctx.quadraticCurveTo(2.2, 0.3, 0.4, 0.25);
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0.4, -0.25);
            ctx.lineTo(3, -1);
            ctx.quadraticCurveTo(2.2, -0.3, 0.4, -0.25);
            ctx.fill();
            ctx.stroke();

            ctx.restore();
        });
    }

    function rotPoint(x, y, angle) {
        const c = Math.cos(angle);
        const s = Math.sin(angle);

        return {
            x: x * c - y * s,
            y: x * s + y * c
        };
    }

    function rotatedArcTo(ctx, ox, oy, angle, x1, y1, x2, y2, radius) {
        const p1 = rotPoint(x1, y1, angle);
        const p2 = rotPoint(x2, y2, angle);

        ctx.arcTo(
            ox + p1.x, oy + p1.y,
            ox + p2.x, oy + p2.y,
            radius
        );
    }

    function drawClam(ctx, x, y, r) {
        withTransform(ctx, x, y, r, () => {
            ctx.save();
            ctx.scale(1 / 50, 1 / 50);
            ctx.translate(-20, 0);

            ctx.lineWidth = 7.5;
            ctx.fillStyle = F(colors.cumWhite);
            ctx.strokeStyle = FB(colors.cumWhite, "#000000", 0.125);
            ctx.beginPath();
            ctx.moveTo(-35, 25);
            ctx.quadraticCurveTo(-20, 0, -35, -25);
            ctx.quadraticCurveTo(10, 0, -35, 25);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(-15, 20);
            ctx.lineTo(22, 45);

            // Front scalloped edge: 6 half-arcs placed along a curved front
            const scallops = 6;

            const cx = 22.5;
            const cy = 0;

            // overall front curve
            const rx = 35;
            const ry = 45;

            // scallop size
            const scallopRadius = 13;

            function pointOnEllipse(t) {
                return {
                    x: cx + Math.cos(t) * rx,
                    y: cy + Math.sin(t) * ry
                };
            }

            function drawArcBetween(p0, p1, bulge) {
                const mx = (p0.x + p1.x) / 2;
                const my = (p0.y + p1.y) / 2;

                const dx = p1.x - p0.x;
                const dy = p1.y - p0.y;
                const len = Math.hypot(dx, dy) || 1;

                // outward normal, toward the right side of the clam
                const nx = dy / len;
                const ny = -dx / len;

                const c = {
                    x: mx + nx * bulge,
                    y: my + ny * bulge
                };

                const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
                const a1 = Math.atan2(p1.y - c.y, p1.x - c.x);

                ctx.arc(c.x, c.y, scallopRadius, a0, a1, true);
            }

            for (let i = 0; i < scallops; i++) {
                const t0 = Math.PI / 2 - (Math.PI * i) / scallops;
                const t1 = Math.PI / 2 - (Math.PI * (i + 1)) / scallops;

                const p0 = pointOnEllipse(t0);
                const p1 = pointOnEllipse(t1);

                if (i === 0) {
                    ctx.lineTo(p0.x, p0.y);
                }

                drawArcBetween(p0, p1, 10);
            }

            ctx.lineTo(-15, -20);
            ctx.quadraticCurveTo(-40, 0, -15, 20);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(-10, 10);
            ctx.lineTo(25, 25);
            ctx.closePath();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(-10, -10);
            ctx.lineTo(25, -25);
            ctx.closePath();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(-5, 3);
            ctx.lineTo(35, 12);
            ctx.closePath();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(-5, -3);
            ctx.lineTo(35, -12);
            ctx.closePath();
            ctx.stroke();

            ctx.restore();
        });
    }

    function drawBeetle(ctx, x, y, r, t, faction) {
        const s = r;
        const time = t ?? nowSec();
        const bob = Math.sin(time * 5) * 0.075;

        withTransform(ctx, x, y, s, () => {
            ctx.lineWidth = 0.175;
            ctx.fillStyle = ctx.strokeStyle = F(colors.darkGray);
            ctx.save();
            ctx.rotate(bob + .15);
            ctx.translate(0, -0.7);
            ctx.beginPath();
            ctx.moveTo(0.5, 0.8);
            ctx.quadraticCurveTo(0.99, 1.5, 1.8, 0.75);
            ctx.quadraticCurveTo(0.99, 1.1, 0.5, 0.3);
            ctx.fill();
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate(-bob - .15);
            ctx.translate(0, 0.7);
            ctx.beginPath();
            ctx.moveTo(0.5, -0.8);
            ctx.quadraticCurveTo(0.99, -1.5, 1.8, -0.75);
            ctx.quadraticCurveTo(0.99, -1.1, 0.5, -0.3);
            ctx.fill();
            ctx.stroke();
            ctx.restore();

            const color =
                faction === 1 || faction === "PLAYER" || faction === "player"
                    ? colors.playerYellow
                    : colors.beetlePurple;
            ctx.fillStyle = F(color);
            ctx.strokeStyle = FB(color, "#000000", 0.15);
            const height = 1;
            ctx.beginPath();
            ctx.moveTo(-1, 0);
            ctx.bezierCurveTo(-1, height, 1, height, 1, 0);
            ctx.bezierCurveTo(1, -height, -1, -height, -1, 0);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(-0.5, 0);
            ctx.quadraticCurveTo(0, 0.05, 0.5, 0);
            ctx.stroke();

            ctx.fillStyle = FB(color, "#000000", 0.15);
            ctx.beginPath();
            ctx.arc(-0.47, 0.264, 0.11, 0, TAU);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(-0.47, -0.264, 0.11, 0, TAU);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(0.47, 0.264, 0.11, 0, TAU);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(0.47, -0.264, 0.11, 0, TAU);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(0, 0.35, 0.11, 0, TAU);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(0, -0.35, 0.11, 0, TAU);
            ctx.fill();
        });
    }

    function drawMechaBeetle(ctx, x, y, r, t) {
        const s = r;
        const time = t ?? nowSec();
        const bob = Math.sin(time * 5) * 0.075;

        withTransform(ctx, x, y, s, () => {
            ctx.lineWidth = 0.175;
            ctx.fillStyle = ctx.strokeStyle = F(colors.darkGray);
            ctx.save();
            ctx.scale(1, bob * 7.5);

            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(-1.5, 0);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(-1.5, 0.3, 0.25, 0, TAU);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(-1.5, -0.3, 0.25, 0, TAU);
            ctx.stroke();

            ctx.restore();

            ctx.save();
            ctx.rotate(bob + .15);
            ctx.translate(0, -0.7);
            ctx.beginPath();
            ctx.moveTo(0.5, 0.8);
            ctx.quadraticCurveTo(0.99, 1.5, 1.8, 0.75);
            ctx.quadraticCurveTo(0.99, 1.1, 0.5, 0.3);
            ctx.fill();
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate(-bob - .15);
            ctx.translate(0, 0.7);
            ctx.beginPath();
            ctx.moveTo(0.5, -0.8);
            ctx.quadraticCurveTo(0.99, -1.5, 1.8, -0.75);
            ctx.quadraticCurveTo(0.99, -1.1, 0.5, -0.3);
            ctx.fill();
            ctx.stroke();
            ctx.restore();

            ctx.fillStyle = F(colors.mecha);
            ctx.strokeStyle = FB(colors.mecha, "#000000", 0.15);
            const height = 1;
            ctx.beginPath();
            ctx.moveTo(-1, 0);
            ctx.bezierCurveTo(-1, height, 1, height, 1, 0);
            ctx.bezierCurveTo(1, -height, -1, -height, -1, 0);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(-0.5, 0);
            ctx.quadraticCurveTo(0, 0.05, 0.5, 0);
            ctx.stroke();

            ctx.strokeStyle = F(colors.ladybugRed);
            ctx.lineWidth = .09;
            ctx.beginPath();
            ctx.moveTo(-0.47, 0.264);
            ctx.lineTo(0, 0.35);
            ctx.lineTo(0.47, 0.264);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(-0.47, -0.264);
            ctx.lineTo(0, -0.35);
            ctx.lineTo(0.47, -0.264);
            ctx.stroke();

            ctx.fillStyle = FB(colors.mecha, "#000000", 0.15);
            ctx.beginPath();
            ctx.arc(-0.47, 0.264, 0.11, 0, TAU);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(-0.47, -0.264, 0.11, 0, TAU);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(0.47, 0.264, 0.11, 0, TAU);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(0.47, -0.264, 0.11, 0, TAU);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(0, 0.35, 0.11, 0, TAU);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(0, -0.35, 0.11, 0, TAU);
            ctx.fill();
        });
    }

    function drawPillBug(ctx, x, y, r, t) {
        const s = r;
        const wiggle = Math.sin(t * 5) * 0.025;

        withTransform(ctx, x, y, s, () => {
            ctx.lineWidth = 0.175;
            ctx.strokeStyle = F(colors.darkGray);

            drawLegs(ctx, t, 0.47, 0.47);

            ctx.fillStyle = F(colors.lighterBlack);
            ctx.strokeStyle = FB(colors.lighterBlack, "#000000", 0.15);
            ctx.save();
            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.8, 0, 0, TAU);
            ctx.fill();
            ctx.stroke();
            ctx.clip();

            ctx.lineWidth = 0.075;
            for (let i = 0; i < 7; i++) {
                const width = 0.1 + ((i + 1) * 0.3);
                const rx = Math.max(0, width / 1.35); // clamp
                ctx.beginPath();
                ctx.ellipse(0, 0, rx, 1, 0, 0, TAU);
                ctx.stroke();
            }
            ctx.restore();

            ctx.lineWidth = 0.10;
            ctx.fillStyle = ctx.strokeStyle = F(colors.stingerBlack);

            ctx.beginPath();
            ctx.moveTo(0.95, 0.26);
            ctx.quadraticCurveTo(1.26, 0.28, 1.48, 0.59 + wiggle);
            ctx.quadraticCurveTo(1.16, 0.40, 0.95, 0.26);
            ctx.moveTo(0.95, -0.26);
            ctx.quadraticCurveTo(1.26, -0.28, 1.48, -0.59 - wiggle);
            ctx.quadraticCurveTo(1.16, -0.40, 0.95, -0.26);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        });
    }

    function drawMite(ctx, x, y, r, t) {
        const s = r;
        const v = Math.sin(t * 5) * 0.025;

        withTransform(ctx, x, y, s, () => {
            ctx.lineWidth = 0.275;
            ctx.strokeStyle = FB(colors.ladybugRed, "#000000", 0.35);

            drawLegs(ctx, t, 0.57, 0.67);

            ctx.beginPath();
            ctx.moveTo(0.5, 0.2);
            ctx.quadraticCurveTo(1.7, 0.8, 2, 0.7 + v);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(0.5, -0.2);
            ctx.quadraticCurveTo(1.7, -0.8, 2, -0.7 - v);
            ctx.stroke();

            ctx.fillStyle = F(colors.ladybugRed);
            ctx.strokeStyle = FB(colors.ladybugRed, "#000000", 0.15);
            ctx.beginPath();
            ctx.ellipse(-.3, 0, 1, 0.8, 0, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.ellipse(.7, 0, 0.55, 0.63, 0, 0, TAU);
            ctx.fill();
            ctx.stroke();

        });
    }

    function drawScawwyBeetle(ctx, x, y, r, t) {
        const s = r;
        const time = t ?? nowSec();
        const bob = Math.sin(time * 5) * 0.075;

        withTransform(ctx, x, y, s, () => {
            ctx.lineWidth = 0.175;

            ctx.fillStyle = F(colors.darkGray);

            const teethCount = 6;     // how many spikes
            const ringR = 0.73;        // radius of the teeth circle
            const toothLen = 0.29;     // spike length toward center
            const toothW = 0.135;      // spike base width

            const arc = TAU / 4.6799;          // how wide the "tooth fan" is (same as your old spread)
            const centerAng = Math.PI;     // LEFT side of the teeth circle
            const step = (teethCount <= 1) ? 0 : arc / (teethCount - 1);

            for (let i = 0; i < teethCount; i++) {
                const gog = Math.sin(time * 3 + i) * 0.075;

                const ang = centerAng - arc * 0.5 + i * step;

                const ox = Math.cos(ang) * ringR + 1.32;
                const oy = Math.sin(ang) * ringR;

                // direction toward center (fixed)
                let dx = -Math.cos(ang);
                let dy = -Math.sin(ang);

                // normalize so the push is actually “forward”
                const inv = 1 / Math.hypot(dx, dy);
                dx *= inv;
                dy *= inv;

                const slide = gog * 0.3;   // scale to taste
                const sox = ox + dx * slide;
                const soy = oy + dy * slide;

                const px = -dy;
                const py = dx;

                const bx1 = ox + px * (toothW * 0.5);
                const by1 = oy + py * (toothW * 0.5);
                const bx2 = ox - px * (toothW * 0.5);
                const by2 = oy - py * (toothW * 0.5);

                // move tip back/forward along facing direction
                const len = toothLen + gog;          // or toothLen * (1 + gog)
                const tx = sox + dx * len;
                const ty = soy + dy * len;

                ctx.beginPath();
                ctx.moveTo(bx1, by1);
                ctx.lineTo(bx2, by2);
                ctx.lineTo(tx, ty);
                ctx.closePath();
                ctx.fill();
            }

            ctx.fillStyle = F(colors.hellMobColor);
            ctx.strokeStyle = FB(colors.hellMobColor, "#000000", 0.15);
            const path = new Path2D("M 0 -0.74982503 C -0.4999995 -0.74982503 -0.99993896 -0.4999995 -0.99993896 0 C -0.99993896 0.77247497 0.19331772 0.94806099 0.73638916 0.52709961 A 0.77485514 0.86942399 0 0 1 0.57567546 0 A 0.77485514 0.86942399 0 0 1 0.73638916 -0.52709961 C 0.54483131 -0.67558552 0.27247547 -0.74982503 0 -0.74982503 z");
            ctx.fill(path);
            ctx.stroke(path);

            // Giant pentagram decoration
            ctx.save();
            ctx.scale(bob - 1, bob - 1);
            ctx.translate(0.2, 0);
            ctx.rotate(time);
            ctx.lineWidth = 0.04;
            ctx.strokeStyle = FB(colors.hellMobColor, "#000000", 0.35);
            ctx.fillStyle = FB(colors.hellMobColor, "#000000", 0.6);

            // optional faint glow effect
            ctx.shadowColor = FB(colors.hellMobColor, "#ff0000", 0.4);
            ctx.shadowBlur = 0.15;

            const outerR = 0.55;
            const innerR = outerR * 0.38;
            const rot = -Math.PI / 2;

            ctx.beginPath();

            for (let i = 0; i < 5; i++) {
                const outerAngle = rot + i * TAU / 5;
                const innerAngle = outerAngle + TAU / 10;

                const ox = Math.cos(outerAngle) * outerR;
                const oy = Math.sin(outerAngle) * outerR;

                const ix = Math.cos(innerAngle) * innerR;
                const iy = Math.sin(innerAngle) * innerR;

                if (i === 0) ctx.moveTo(ox, oy);
                else ctx.lineTo(ox, oy);

                ctx.lineTo(ix, iy);
            }

            ctx.closePath();
            ctx.stroke();

            ctx.restore();
        });
    }

    function drawRockMob(ctx, x, y, r, rands, rarity) {
        withTransform(ctx, x, y, r, () => {
            ctx.lineWidth = 2.32 / r;
            ctx.lineJoin = "round";

            const pointCount = 5 + Math.floor(rands[1] * 1.2) + rarity;
            const baseRadius = 1.0;
            const variance = 0.35; // how blobby it gets

            ctx.beginPath();

            for (let i = 0; i < pointCount; i++) {
                const angle = (i / pointCount) * Math.PI * 2;

                // Map 0–1 random into radius variation
                const offset = (rands[i] - 0.25) * 1; // -1 to 1
                const radius = baseRadius + offset * variance;

                const px = Math.cos(angle) * radius;
                const py = Math.sin(angle) * radius;

                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }

            ctx.closePath();

            ctx.fillStyle = F("#808080");
            ctx.strokeStyle = F("#696969");

            ctx.fill();
            ctx.stroke();
        });
    }

    function drawCactusMob(ctx, x, y, r, rands, rarity) {
        withTransform(ctx, x, y, r, () => {
            ctx.lineWidth = 2.32 / r;
            const rand1 = rands[0];
            const radius = 1; // Fixed radius for consistent size
            const sides = Math.floor(rand1) + rarity + 8;

            // --- prepare vertex angles & positions ---
            const verts = [];
            for (let i = 0; i < sides; i++) {
                const angle = (i / sides) * 2 * Math.PI;
                const vx = Math.cos(angle) * radius;
                const vy = Math.sin(angle) * radius;
                verts.push({ angle, x: vx, y: vy });
            }

            ctx.fillStyle = ctx.strokeStyle = F(colors.stingerBlack);
            for (let i = 0; i < verts.length; i++) {
                const { angle, x: vx, y: vy } = verts[i];

                // outward unit vector and perpendicular
                const ux = Math.cos(angle);
                const uy = Math.sin(angle);
                const px = -Math.sin(angle);
                const py = Math.cos(angle);

                // scale params for thorn size (tweak these to taste)
                const tipLen = radius * 0.09;     // how far the tip sticks out from the vertex
                const baseInset = radius * 0.21;  // how much the base is inset toward the center
                const baseHalf = radius * 0.06;   // half-width of the base of the triangular thorn

                // tip point (further out than the vertex)
                const tipX = ux * (radius + tipLen);
                const tipY = uy * (radius + tipLen);

                // base points (slightly inward from the vertex, left and right along perpendicular)
                const baseCenterX = ux * (radius - baseInset);
                const baseCenterY = uy * (radius - baseInset);
                const baseLeftX = baseCenterX + px * baseHalf;
                const baseLeftY = baseCenterY + py * baseHalf;
                const baseRightX = baseCenterX - px * baseHalf;
                const baseRightY = baseCenterY - py * baseHalf;

                // draw the triangle
                ctx.beginPath();
                ctx.moveTo(baseLeftX, baseLeftY);
                ctx.lineTo(tipX, tipY);
                ctx.lineTo(baseRightX, baseRightY);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            }

            ctx.beginPath();

            for (let i = 0; i <= sides; i++) {
                // Calculate the angle for each vertex (use same paramization so shape matches thorns)
                const angle = (i / sides) * 2 * Math.PI;

                // Calculate the vertex position
                const x = Math.cos(angle) * radius;
                const y = Math.sin(angle) * radius;

                if (i === 0) {
                    // Move to the first vertex
                    ctx.moveTo(x, y);
                } else {
                    // Calculate the midpoint between the current and previous vertex
                    const prevAngle = ((i - 1) / sides) * 2 * Math.PI;
                    const midX =
                        Math.cos(prevAngle + (angle - prevAngle) / 2) * radius * 0.8; // Bulge inward
                    const midY =
                        Math.sin(prevAngle + (angle - prevAngle) / 2) * radius * 0.8; // Bulge inward

                    // Draw a quadratic curve
                    ctx.quadraticCurveTo(midX, midY, x, y);
                }
            }
            ctx.strokeStyle = FB(colors.cactusGreen, "#000000", 0.15);
            ctx.fillStyle = F(colors.cactusGreen);

            ctx.closePath();
            ctx.fill();
            ctx.stroke();

        });
    }

    function drawStalagmite(ctx, x, y, r, rands, rarity) {
        withTransform(ctx, x, y, r, () => {
            ctx.lineWidth = 2.32 / r;

            ctx.fillStyle = F(colors.crafting);
            ctx.strokeStyle = FB(colors.crafting, "#000000", 0.15);

            // Safe rand accessor: uses rands[#] like you asked.
            const R = (i) => {
                const v = rands[i % rands.length];
                return (v == null ? 0.5 : v);
            };

            const radius = 1;
            const spikeCount = 8 + rarity + Math.floor(R(0) * 3);
            const spikeScale = 0.18 + rarity * 0.012;

            for (let i = 0; i < spikeCount; i++) {
                const baseAngle = (i / spikeCount) * 2 * Math.PI;
                const jitter = (R(51 + i * 3) - 0.5) * (0.35 / spikeCount) * 2 * Math.PI;
                const angle = baseAngle + jitter;
                const ux = Math.cos(angle), uy = Math.sin(angle);
                const px = -Math.sin(angle), py = Math.cos(angle);
                const len = radius * (spikeScale * (0.9 + R(52 + i * 3) * 1.6));
                const halfBase = radius * (0.255 + rarity * 0.003);
                const halfVar = radius * (0.018 + rarity * 0.0015);
                const half = halfBase + (R(90 + i) - 0.5) * 2 * halfVar;
                const inset = radius * (0.12 + R(20 + i) * 0.14);
                const bend = (R(170 + i) - 0.5) * radius * (0.10 + rarity * 0.01);
                const tipX = ux * (radius + len) + px * bend;
                const tipY = uy * (radius + len) + py * bend;
                const baseCX = ux * (radius - inset);
                const baseCY = uy * (radius - inset);
                const baseLX = baseCX + px * half;
                const baseLY = baseCY + py * half;
                const baseRX = baseCX - px * half;
                const baseRY = baseCY - py * half;

                ctx.beginPath();
                ctx.moveTo(baseLX, baseLY);
                ctx.lineTo(tipX, tipY);
                ctx.lineTo(baseRX, baseRY);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            }

            const pointCount = 10 + Math.floor(rands[1] * 1.2) + rarity;
            const baseRadius = 1.0;
            const variance = 0.15; // how blobby it gets

            ctx.beginPath();

            for (let i = 0; i < pointCount; i++) {
                const angle = (i / pointCount) * Math.PI * 2;

                // Map 0–1 random into radius variation
                const offset = (rands[i] - 0.25) * 1; // -1 to 1
                const radius = baseRadius + offset * variance;

                const px = Math.cos(angle) * radius;
                const py = Math.sin(angle) * radius;

                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }

            ctx.closePath();

            ctx.fill();
            ctx.stroke();
        });
    }

    //got so lazy that i stole the hornet rendering code from floof
    function drawHornet(ctx, x, y, r, t) {
        const s = r;
        const wiggle = Math.sin(t * 5) * 0.025;
        const wing = Math.sin(t * 12) * 0.077;

        withTransform(ctx, x, y, s, () => {
            ctx.lineJoin = "round";
            ctx.lineCap = "round";

            // Base styles
            const hornetFill = F(colors.hornet);
            const stinger = F(colors.stingerBlack);

            ctx.lineWidth = 0.15;
            ctx.fillStyle = stinger;
            ctx.strokeStyle = stinger;

            ctx.beginPath();
            ctx.moveTo(-1.55, wiggle);
            ctx.lineTo(-0.25, -0.4);
            ctx.lineTo(-0.25, 0.4);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.lineWidth = 0.17;
            ctx.fillStyle = hornetFill;
            ctx.strokeStyle = FB(colors.hornet, "#000000", 0.15);

            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.667, 0, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.667, 0, 0, TAU);
            ctx.clip();

            ctx.fillStyle = stinger;
            ctx.beginPath();
            ctx.rect(-1.0, -1, 0.334, 2);
            ctx.rect(-0.334, -1, 0.334, 2);
            ctx.rect(0.334, -1, 0.334, 2);
            ctx.fill();

            ctx.restore();

            ctx.lineWidth = 0.10;
            ctx.fillStyle = hornetFill;
            ctx.strokeStyle = FB(colors.hornet, "#000000", 0.15);
            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.667, 0, 0, TAU);
            ctx.stroke();

            ctx.fillStyle = F("#ffffff");
            ctx.globalAlpha = 0.2;
            ctx.save();
            ctx.rotate(wing - 0.2);
            ctx.translate(0, 0.3);

            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.rotate(-wing + 0.2);
            ctx.translate(0, -0.3);
            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.globalAlpha = 1;

            //antennae
            ctx.lineWidth = 0.10;
            ctx.fillStyle = stinger;
            ctx.strokeStyle = stinger;

            ctx.beginPath();

            // upper curve
            ctx.moveTo(0.85, 0.16);
            ctx.quadraticCurveTo(1.36, 0.18, 1.68, 0.49 + wiggle);
            ctx.quadraticCurveTo(1.26, 0.30, 0.85, 0.16);

            // lower curve (mirrored)
            ctx.moveTo(0.85, -0.16);
            ctx.quadraticCurveTo(1.36, -0.18, 1.68, -0.49 - wiggle);
            ctx.quadraticCurveTo(1.26, -0.30, 0.85, -0.16);

            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        });
    }

    function drawWasp(ctx, x, y, r, t) {
        const s = r;
        const wiggle = Math.sin(t * 5) * 0.025;
        const wing = Math.sin(t * 12) * 0.077;

        withTransform(ctx, x, y, s, () => {
            ctx.lineJoin = "round";
            ctx.lineCap = "round";

            // Base styles
            const hornetFill = F(colors.wasp);
            const stinger = F(colors.stingerBlack);

            ctx.lineWidth = 0.15;
            ctx.fillStyle = stinger;
            ctx.strokeStyle = stinger;

            ctx.beginPath();
            ctx.moveTo(-1.55, wiggle);
            ctx.lineTo(-0.25, -0.54);
            ctx.lineTo(-0.25, 0.54);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.lineWidth = 0.17;
            ctx.fillStyle = hornetFill;
            ctx.strokeStyle = FB(colors.wasp, "#000000", 0.15);

            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.667, 0, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.667, 0, 0, TAU);
            ctx.clip();
            ctx.fillStyle = ctx.strokeStyle = stinger;
            ctx.lineWidth = 0.58;
            ctx.beginPath();
            ctx.arc(3.53, 0, 4, 0, TAU);
            ctx.stroke();
            ctx.lineWidth = 0.28;
            ctx.beginPath();
            ctx.arc(4.25, 0, 4, 0, TAU);
            ctx.stroke();

            ctx.restore();

            ctx.lineWidth = 0.10;
            ctx.fillStyle = hornetFill;
            ctx.strokeStyle = FB(colors.wasp, "#000000", 0.15);
            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.667, 0, 0, TAU);
            ctx.stroke();

            ctx.fillStyle = F("#ffffff");
            ctx.globalAlpha = 0.2;
            ctx.save();
            ctx.rotate(wing - 0.2);
            ctx.translate(0, 0.3);

            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.rotate(-wing + 0.2);
            ctx.translate(0, -0.3);
            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.globalAlpha = 1;

            //antennae
            ctx.lineWidth = 0.10;
            ctx.fillStyle = F(stinger);
            ctx.strokeStyle = F(stinger);

            ctx.beginPath();

            // upper curve
            ctx.moveTo(0.85, 0.16);
            ctx.quadraticCurveTo(1.36, 0.18, 1.78, 0.49 + wiggle);
            ctx.quadraticCurveTo(1.26, 0.30, 0.85, 0.16);

            ctx.moveTo(0.85, -0.16);
            ctx.quadraticCurveTo(1.36, -0.18, 1.78, -0.49 - wiggle);
            ctx.quadraticCurveTo(1.26, -0.30, 0.85, -0.16);

            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        });
    }

    function drawMechaWasp(ctx, x, y, r, t) {
        const s = r;
        const wiggle = Math.sin(t * 5) * 0.025;
        const wing = Math.sin(t * 12) * 0.077;

        withTransform(ctx, x, y, s, () => {
            ctx.lineJoin = "round";
            ctx.lineCap = "round";

            // Base styles
            const hornetFill = F(colors.mecha);
            const stinger = F(colors.wasp);

            ctx.lineWidth = 0.15;
            ctx.fillStyle = stinger;
            ctx.strokeStyle = stinger;

            ctx.beginPath();
            ctx.moveTo(-1.55, wiggle);
            ctx.lineTo(-0.25, -0.54);
            ctx.lineTo(-0.25, 0.54);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.lineWidth = 0.17;
            ctx.fillStyle = hornetFill;
            ctx.strokeStyle = FB(colors.mecha, "#000000", 0.15);

            ctx.beginPath();
            drawPolygon(ctx, 0, 0, 16, 1, 0, 1, 2 / 3);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.beginPath();
            drawPolygon(ctx, 0, 0, 16, 1, 0, 1, 2 / 3);
            ctx.clip();
            ctx.fillStyle = ctx.strokeStyle = stinger;
            ctx.lineWidth = 0.58;
            ctx.beginPath();
            ctx.arc(3.53, 0, 4, 0, TAU);
            ctx.stroke();
            ctx.lineWidth = 0.28;
            ctx.beginPath();
            ctx.arc(4.25, 0, 4, 0, TAU);
            ctx.stroke();

            ctx.restore();

            ctx.lineWidth = 0.10;
            ctx.fillStyle = hornetFill;
            ctx.strokeStyle = FB(colors.mecha, "#000000", 0.15);
            ctx.beginPath();
            drawPolygon(ctx, 0, 0, 16, 1, 0, 1, 2 / 3);
            ctx.stroke();

            ctx.fillStyle = F("#ffffff");
            ctx.globalAlpha = 0.2;
            ctx.save();
            ctx.rotate(wing - 0.2);
            ctx.translate(0, 0.3);

            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.rotate(-wing + 0.2);
            ctx.translate(0, -0.3);
            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.globalAlpha = 1;

            //antennae
            ctx.lineWidth = 0.10;
            ctx.fillStyle = F(colors.wasp);
            ctx.strokeStyle = F(colors.darkGray);

            ctx.beginPath();

            ctx.moveTo(0.85, 0.16);
            ctx.lineTo(1.315, 0.325 + (wiggle / 2));
            ctx.lineTo(1.78, 0.59 + wiggle);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.moveTo(0.85, -0.16);
            ctx.lineTo(1.315, -0.325 - (wiggle / 2));
            ctx.lineTo(1.78, -0.59 - wiggle);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

        });
    }

    function drawBee(ctx, x, y, r, t) {
        const s = r;
        const wiggle = Math.sin(t * 5) * 0.025;
        const wing = Math.sin(t * 12) * 0.077;

        withTransform(ctx, x, y, s, () => {
            const hornetFill = F(colors.beeYellow);
            const stinger = F(colors.stingerBlack);

            ctx.lineWidth = 0.175;
            ctx.fillStyle = stinger;
            ctx.strokeStyle = stinger;

            ctx.beginPath();
            ctx.moveTo(-1.287, wiggle);
            ctx.lineTo(-0.25, -0.4);
            ctx.lineTo(-0.25, 0.4);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.lineWidth = 0.17;
            ctx.fillStyle = hornetFill;
            ctx.strokeStyle = FB(colors.beeYellow, "#000000", 0.15);

            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.667, 0, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.667, 0, 0, TAU);
            ctx.clip();

            ctx.fillStyle = stinger;
            ctx.beginPath();
            ctx.rect(-1.0, -1, 0.334, 2);
            ctx.rect(-0.334, -1, 0.334, 2);
            ctx.rect(0.334, -1, 0.334, 2);
            ctx.fill();

            ctx.restore();

            ctx.lineWidth = 0.10;
            ctx.fillStyle = hornetFill;
            ctx.strokeStyle = FB(colors.beeYellow, "#000000", 0.15);
            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.667, 0, 0, TAU);
            ctx.stroke();

            ctx.fillStyle = F("#ffffff");
            ctx.globalAlpha = 0.2;
            ctx.save();
            ctx.rotate(wing - 0.2);
            ctx.translate(0, 0.3);

            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.rotate(-wing + 0.2);
            ctx.translate(0, -0.3);
            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.globalAlpha = 1;

            //antennae
            ctx.lineWidth = 0.12;
            ctx.fillStyle = stinger;
            ctx.strokeStyle = stinger;

            ctx.beginPath();
            ctx.moveTo(0.9, 0.19);
            ctx.quadraticCurveTo(1.12, 0.19, 1.35, 0.43 + wiggle);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(1.35, 0.43 + wiggle, 0.15, 0, TAU);
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(0.9, -0.19);
            ctx.quadraticCurveTo(1.12, -0.19, 1.35, -0.43 - wiggle);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(1.35, -0.43 - wiggle, 0.15, 0, TAU);
            ctx.fill();
        });
    }

    function drawBeeQueen(ctx, x, y, r, t) {
        const s = r;
        const wiggle = Math.sin(t * 5) * 0.025;
        const wing = Math.sin(t * 12) * 0.077;

        withTransform(ctx, x, y, s, () => {
            const hornetFill = F(colors.beeYellow);
            const stinger = F(colors.stingerBlack);
            const lw = 0.09987543210;

            ctx.lineWidth = lw * 1.5;
            ctx.fillStyle = stinger;
            ctx.strokeStyle = stinger;

            ctx.beginPath();
            ctx.moveTo(-1.287, wiggle);
            ctx.lineTo(-0.25, -0.4);
            ctx.lineTo(-0.25, 0.4);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.lineWidth = lw;
            ctx.fillStyle = hornetFill;
            ctx.strokeStyle = FB(colors.beeYellow, "#000000", 0.15);

            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.667, 0, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.667, 0, 0, TAU);
            ctx.clip();

            ctx.fillStyle = stinger;
            ctx.beginPath();
            ctx.rect(-1.0, -1, 0.334, 2);
            ctx.rect(-0.334, -1, 0.334, 2);
            ctx.rect(0.334, -1, 0.334, 2);
            ctx.fill();

            ctx.restore();

            ctx.lineWidth = lw;
            ctx.fillStyle = hornetFill;
            ctx.strokeStyle = FB(colors.beeYellow, "#000000", 0.15);
            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.667, 0, 0, TAU);
            ctx.stroke();

            ctx.fillStyle = F("#ffffff");
            ctx.globalAlpha = 0.2;
            ctx.save();
            ctx.rotate(wing - 0.2);
            ctx.translate(0, 0.3);

            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.rotate(-wing + 0.2);
            ctx.translate(0, -0.3);
            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.globalAlpha = 1;

            ctx.save();

            ctx.fillStyle = F(colors.cumWhite);
            ctx.strokeStyle = FB(colors.cumWhite, "#000000", 0.1);
            ctx.lineWidth = lw * 0.8;

            ctx.beginPath();

            const fuzzRadiusX = -0.1;
            const fuzzRadiusY = 0.55;
            const scallops = 10;

            for (let i = 0; i <= scallops; i++) {
                const a = -Math.PI / 2 + (i / scallops) * Math.PI;
                const xOff = Math.cos(a) * fuzzRadiusX * 0.9 + 0.35;
                const yOff = Math.sin(a) * fuzzRadiusY * 0.9;

                const puff = 0.12 + Math.sin(i * 3) * 0.02; // tiny variation
                ctx.moveTo(xOff + puff, yOff);
                ctx.arc(xOff, yOff, puff, 0, TAU);
            }

            ctx.fill();
            ctx.stroke();

            ctx.restore();

            //antennae
            ctx.lineWidth = 0.12;
            ctx.fillStyle = stinger;
            ctx.strokeStyle = stinger;

            ctx.beginPath();
            ctx.moveTo(0.9, 0.19);
            ctx.quadraticCurveTo(1.12, 0.19, 1.35, 0.43 + wiggle);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(1.35, 0.43 + wiggle, 0.15, 0, TAU);
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(0.9, -0.19);
            ctx.quadraticCurveTo(1.12, -0.19, 1.35, -0.43 - wiggle);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(1.35, -0.43 - wiggle, 0.15, 0, TAU);
            ctx.fill();
        });
    }

    function drawBumblebee(ctx, x, y, r, t) {
        const s = r;
        const wiggle = Math.sin(t * 5) * 0.025;
        const wing = Math.sin(t * 12) * 0.077;

        withTransform(ctx, x, y, s, () => {
            const hornetFill = F(colors.honeyGold);
            const stinger = F(colors.stingerBlack);

            ctx.lineWidth = 0.175;
            ctx.fillStyle = stinger;
            ctx.strokeStyle = stinger;

            ctx.beginPath();
            ctx.moveTo(-1.287, wiggle);
            ctx.lineTo(-0.25, -0.4);
            ctx.lineTo(-0.25, 0.4);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.lineWidth = 0.17;
            ctx.fillStyle = hornetFill;
            ctx.strokeStyle = FB(colors.honeyGold, "#000000", 0.15);

            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.767, 0, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.767, 0, 0, TAU);
            ctx.clip();

            ctx.fillStyle = stinger;
            ctx.beginPath();
            ctx.rect(0.667, -1, 0.334, 2);
            ctx.rect(-0.667, -1, 0.334, 2);
            ctx.rect(0, -1, 0.334, 2);
            ctx.fill();

            ctx.fillStyle = F(colors.cumWhite);
            ctx.beginPath();
            ctx.rect(-1, -1, 0.334, 2);
            ctx.fill();

            ctx.restore();

            ctx.lineWidth = 0.10;
            ctx.fillStyle = hornetFill;
            ctx.strokeStyle = FB(colors.honeyGold, "#000000", 0.15);
            ctx.beginPath();
            ctx.ellipse(0, 0, 1, 0.767, 0, 0, TAU);
            ctx.stroke();

            ctx.fillStyle = F("#ffffff");
            ctx.globalAlpha = 0.2;
            ctx.save();
            ctx.rotate(wing - 0.2);
            ctx.translate(0, 0.3);

            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.rotate(-wing + 0.2);
            ctx.translate(0, -0.3);
            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.92, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.globalAlpha = 1;

            //antennae
            ctx.lineWidth = 0.12;
            ctx.fillStyle = stinger;
            ctx.strokeStyle = stinger;

            ctx.beginPath();
            ctx.moveTo(0.9, 0.19);
            ctx.quadraticCurveTo(1.12, 0.19, 1.35, 0.43 + wiggle);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(1.35, 0.43 + wiggle, 0.15, 0, TAU);
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(0.9, -0.19);
            ctx.quadraticCurveTo(1.12, -0.19, 1.35, -0.43 - wiggle);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(1.35, -0.43 - wiggle, 0.15, 0, TAU);
            ctx.fill();
        });
    }

    function drawScorpion(ctx, x, y, r, t) {
        withTransform(ctx, x, y, r, () => {
            const DEG_TO_RAD = Math.PI / 180;
            const S = 1 / 50;

            const ngpo = Math.sin(t * 5) * 6;

            ctx.save();
            ctx.scale(S, S);
            ctx.translate(4.5, 0);

            // ---------- legs ----------
            ctx.lineWidth = 7.5;
            ctx.lineCap = "round";
            ctx.strokeStyle = F(colors.darkGray);

            const SWING_AMPLITUDE = 5.92;
            const SWING_SPEED = 3;
            const ROTATION_MULT = 1.2;

            const swingyNgpoA = SWING_AMPLITUDE * Math.sin(Math.sin(t * SWING_SPEED));
            const swingyNgpoB = SWING_AMPLITUDE * Math.sin(Math.sin(t * SWING_SPEED + 2));
            const swingyNgpoC = SWING_AMPLITUDE * Math.sin(Math.sin(t * SWING_SPEED + 4));
            const swingyNgpoD = SWING_AMPLITUDE * Math.sin(Math.sin(t * SWING_SPEED + 6));

            const legScale = 0.40;

            function drawLeg(rotDeg, sx, sy, cx, cy, ex, ey) {
                ctx.save();
                ctx.rotate(rotDeg * DEG_TO_RAD);
                ctx.beginPath();
                ctx.moveTo(sx * legScale, sy * legScale);
                ctx.quadraticCurveTo(cx * legScale, cy * legScale, ex * legScale, ey * legScale);
                ctx.stroke();
                ctx.restore();
            }

            drawLeg(swingyNgpoA * ROTATION_MULT - 5, 85 * 0.95, 53 * 1.4, 40, 0, -9, 0);
            drawLeg(swingyNgpoA * ROTATION_MULT - 5, 85 * 0.95, -53 * 1.4, 40, 0, -9, 0);

            drawLeg(swingyNgpoB * ROTATION_MULT + 40, -80 * 1.2, -53 * 1.08, -30, 0, 0, 0);
            drawLeg(swingyNgpoC * ROTATION_MULT - 50, 80 * 1.2, -53 * 1.08, 30, 0, 0, 0);

            drawLeg(swingyNgpoB * ROTATION_MULT + 40, 80 * 1.2, 53 * 1.08, 30, 0, 0, 0);
            drawLeg(swingyNgpoC * ROTATION_MULT - 50, -80 * 1.2, 53 * 1.08, -30, 0, 0, 0);

            drawLeg(swingyNgpoD * ROTATION_MULT - 5, -85 * 0.95, 53 * 1.4, -40, 0, 9, 0);
            drawLeg(swingyNgpoD * ROTATION_MULT - 5, -85 * 0.95, -53 * 1.4, -40, 0, 9, 0);

            // ---------- pincers ----------
            const cp1x = 35;
            const cp1y = 9.5;
            const cp2x = 25;
            const cp2y = -3;

            ctx.save();
            ctx.scale(0.75, 0.55);
            ctx.translate(-12, 0);

            function drawPincer(y, rotDeg, flip) {
                ctx.save();
                ctx.translate(35, y);
                ctx.rotate(rotDeg * DEG_TO_RAD);

                ctx.strokeStyle = F(colors.darkGray);
                ctx.fillStyle = F(colors.darkGray);

                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.quadraticCurveTo(cp1x, cp1y * flip, 50, -12.9 * flip);
                ctx.quadraticCurveTo(cp2x, cp2y * flip, 0, -15 * flip);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();

                ctx.restore();
            }

            drawPincer(25, ngpo, 1);
            drawPincer(-25, -ngpo, -1);

            ctx.restore();

            // ---------- body ----------
            ctx.lineWidth = 7.5;
            ctx.strokeStyle = FB(colors.scorpionBrown, "#000000", 0.15);
            ctx.fillStyle = F(colors.scorpionBrown);

            ctx.beginPath();
            const points = [20, 33, 58, 63.5, 50];

            ctx.moveTo(0, points[1]);
            ctx.bezierCurveTo(points[2], points[0], points[2], -points[0], 0, -points[1]);
            ctx.bezierCurveTo(-points[3], -points[4], -points[3], points[4], 0, points[1]);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // ---------- body stripes ----------
            ctx.beginPath();

            ctx.moveTo(20, 10);
            ctx.quadraticCurveTo(30, 0, 20, -10);

            ctx.moveTo(6, 15);
            ctx.quadraticCurveTo(9, 0, 6, -15);

            ctx.moveTo(-6, 20);
            ctx.quadraticCurveTo(-9, 0, -6, -20);

            ctx.moveTo(-20, 15);
            ctx.quadraticCurveTo(-23, 0, -20, -15);

            ctx.stroke();

            // ---------- tail ----------
            ctx.save();
            ctx.translate(-15, 0);

            ctx.lineWidth = 6.5;
            ctx.strokeStyle = FB(colors.scorpionBrown, "#000000", 0.15);
            ctx.fillStyle = F(colors.scorpionBrown);

            ctx.beginPath();
            ctx.moveTo(-22, 20 + ngpo / 5);
            ctx.quadraticCurveTo(5, ngpo / 5, -22, -20 + ngpo / 5);
            ctx.bezierCurveTo(-52, -20, -52, 20, -22, 20 + ngpo / 5);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(-22, 10 + ngpo / 5);
            ctx.quadraticCurveTo(-30, ngpo / 5, -22, -10 + ngpo / 5);

            ctx.moveTo(-32, 10 + ngpo / 5);
            ctx.quadraticCurveTo(-40, ngpo / 5, -32, -10 + ngpo / 5);

            ctx.stroke();

            // ---------- stinger ----------
            const missile = 10;
            const base1 = -12;
            const base2 = 1;

            ctx.lineWidth = 5;
            ctx.strokeStyle = F("#292929");
            ctx.fillStyle = F("#333333");

            ctx.beginPath();
            ctx.moveTo(base1, missile + ngpo / 5);
            ctx.lineTo(base1, -missile + ngpo / 5);
            ctx.lineTo(base2, ngpo / 5);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.restore();

            ctx.restore();
        });
    }

    function drawStorm(ctx, x, y, r, t) {
        withTransform(ctx, x, y, r, () => {
            const hex1 = F("#d5c7a6");
            const hex2 = FB("#d5c7a6", "#000000", 0.125);
            const hex3 = FB("#d5c7a6", "#000000", 0.25);
            ctx.lineWidth = 0.15;
            ctx.strokeStyle = ctx.fillStyle = hex1;
            ctx.save();
            ctx.rotate(t * 10);
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const a = Math.PI / 6 + i * (Math.PI * 2 / 6);
                const px = Math.cos(a) * 1;
                const py = Math.sin(a) * 1;
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();

            ctx.strokeStyle = ctx.fillStyle = hex2;
            ctx.save();
            ctx.rotate(t * -10);
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const a = Math.PI / 6 + i * (Math.PI * 2 / 6);
                const px = Math.cos(a) * .70;
                const py = Math.sin(a) * .70;
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();

            ctx.strokeStyle = ctx.fillStyle = hex3;
            ctx.save();
            ctx.rotate(t * 10);
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const a = Math.PI / 6 + i * (Math.PI * 2 / 6);
                const px = Math.cos(a) * .35;
                const py = Math.sin(a) * .35;
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        });
    }

    function drawGarbage(ctx, x, y, radius, r) {
        withTransform(ctx, x, y, radius, () => {
            ctx.strokeStyle = F("#202020");
            ctx.fillStyle = F("#292929");
            const xpos = [35, 15, -25, -41];
            const ypos = [29, 39, 45, 24];
            ctx.lineWidth = .092;
            ctx.beginPath();
            ctx.moveTo(0.9, 0);
            for (let i = 0; i < xpos.length; i++) {
                ctx.lineTo(xpos[i] * .02, ypos[i] * .02);
            }
            ctx.lineTo(-0.86, 0);
            for (let i = xpos.length - 1; i >= 0; i--) {
                ctx.lineTo(xpos[i] * .02, -ypos[i] * .02);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();

            ctx.moveTo(0.7, 0.1675);
            ctx.quadraticCurveTo(0.88, 0, 0.7, -0.1675);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(0.7, 0.1675);
            ctx.quadraticCurveTo(0.88, 0, 0.7, -0.1675);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(0.86, 0.1);
            ctx.quadraticCurveTo(0.6, 0, 0.86, -0.1);
            ctx.lineTo(1.16, -0.2);
            ctx.lineTo(1.1 + (r[0] + 1) * 0.02, -0.14 + (r[1] + 1) * 0.02);
            ctx.lineTo(1.14 + (r[2] + 1) * 0.02, (r[0] + 1) * 0.02);
            ctx.lineTo(1.1 + (r[1] + 1) * 0.02, 0.14 + (r[2] + 1) * 0.02);
            ctx.lineTo(1.16, 0.2);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        });
    }

    function drawLegs(ctx, t, w, h) {

        ctx.lineCap = "round";

        let swingyNgpoA = 5.92 * Math.sin(Math.sin(t * 3));
        let swingyNgpoB = 5.92 * Math.sin(Math.sin(t * 3 + 2));
        let swingyNgpoC = 5.92 * Math.sin(Math.sin(t * 3 + 4));
        let swingyNgpoD = 5.92 * Math.sin(Math.sin(t * 3 + 6));

        ctx.save();
        ctx.rotate((Math.PI / 180) * (swingyNgpoA * 1.2 - 5));
        ctx.beginPath();
        ctx.moveTo((85 * 0.95) * 0.02 * w, (53 * 1.4) * 0.02 * h);
        ctx.quadraticCurveTo(40 * 0.02 * w, 0, -9 * 0.02 * w, 0);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.rotate((Math.PI / 180) * (swingyNgpoA * 1.2 - 5));
        ctx.beginPath();
        ctx.moveTo((85 * 0.95) * 0.02 * w, (-53 * 1.4) * 0.02 * h);
        ctx.quadraticCurveTo(40 * 0.02 * w, 0, -9 * 0.02 * w, 0);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.rotate((Math.PI / 180) * (swingyNgpoB * 1.2 + 40));
        ctx.beginPath();
        ctx.moveTo((-80 * 1.2) * 0.02 * w, (-53 * 1.08) * 0.02 * h);
        ctx.quadraticCurveTo(-30 * 0.02 * w, 0, 0, 0);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.rotate((Math.PI / 180) * (swingyNgpoC * 1.2 - 50));
        ctx.beginPath();
        ctx.moveTo((80 * 1.2) * 0.02 * w, (-53 * 1.08) * 0.02 * h);
        ctx.quadraticCurveTo(30 * 0.02 * w, 0, 0, 0);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.rotate((Math.PI / 180) * (swingyNgpoB * 1.2 + 40));
        ctx.beginPath();
        ctx.moveTo((80 * 1.2) * 0.02 * w, (53 * 1.08) * 0.02 * h);
        ctx.quadraticCurveTo(30 * 0.02 * w, 0, 0, 0);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.rotate((Math.PI / 180) * (swingyNgpoC * 1.2 - 50));
        ctx.beginPath();
        ctx.moveTo((-80 * 1.2) * 0.02 * w, (53 * 1.08) * 0.02 * h);
        ctx.quadraticCurveTo(-30 * 0.02 * w, 0, 0, 0);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.rotate((Math.PI / 180) * (swingyNgpoD * 1.2 - 5));
        ctx.beginPath();
        ctx.moveTo((-85 * 0.95) * 0.02 * w, (53 * 1.4) * 0.02 * h);
        ctx.quadraticCurveTo(-40 * 0.02 * w, 0, 9 * 0.02 * w, 0);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.rotate((Math.PI / 180) * (swingyNgpoD * 1.2 - 5));
        ctx.beginPath();
        ctx.moveTo((-85 * 0.95) * 0.02 * w, (-53 * 1.4) * 0.02 * h);
        ctx.quadraticCurveTo(-40 * 0.02 * w, 0, 9 * 0.02 * w, 0);
        ctx.stroke();
        ctx.restore();
    }

    function drawSpider(ctx, x, y, r, t) {
        withTransform(ctx, x, y, r, () => {
            ctx.lineWidth = 0.29;

            ctx.lineCap = "round";
            ctx.strokeStyle = F(colors.darkGray);

            let swingyNgpoA = 5.92 * Math.sin(Math.sin(t * 3));
            let swingyNgpoB = 5.92 * Math.sin(Math.sin(t * 3 + 2));
            let swingyNgpoC = 5.92 * Math.sin(Math.sin(t * 3 + 4));
            let swingyNgpoD = 5.92 * Math.sin(Math.sin(t * 3 + 6));

            ctx.save();
            ctx.rotate((Math.PI / 180) * (swingyNgpoA * 1.2 - 5));
            ctx.beginPath();
            ctx.moveTo((85 * 0.95) * 0.02, (53 * 1.4) * 0.02);
            ctx.quadraticCurveTo(40 * 0.02, 0, -9 * 0.02, 0);
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate((Math.PI / 180) * (swingyNgpoA * 1.2 - 5));
            ctx.beginPath();
            ctx.moveTo((85 * 0.95) * 0.02, (-53 * 1.4) * 0.02);
            ctx.quadraticCurveTo(40 * 0.02, 0, -9 * 0.02, 0);
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate((Math.PI / 180) * (swingyNgpoB * 1.2 + 40));
            ctx.beginPath();
            ctx.moveTo((-80 * 1.2) * 0.02, (-53 * 1.08) * 0.02);
            ctx.quadraticCurveTo(-30 * 0.02, 0, 0, 0);
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate((Math.PI / 180) * (swingyNgpoC * 1.2 - 50));
            ctx.beginPath();
            ctx.moveTo((80 * 1.2) * 0.02, (-53 * 1.08) * 0.02);
            ctx.quadraticCurveTo(30 * 0.02, 0, 0, 0);
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate((Math.PI / 180) * (swingyNgpoB * 1.2 + 40));
            ctx.beginPath();
            ctx.moveTo((80 * 1.2) * 0.02, (53 * 1.08) * 0.02);
            ctx.quadraticCurveTo(30 * 0.02, 0, 0, 0);
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate((Math.PI / 180) * (swingyNgpoC * 1.2 - 50));
            ctx.beginPath();
            ctx.moveTo((-80 * 1.2) * 0.02, (53 * 1.08) * 0.02);
            ctx.quadraticCurveTo(-30 * 0.02, 0, 0, 0);
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate((Math.PI / 180) * (swingyNgpoD * 1.2 - 5));
            ctx.beginPath();
            ctx.moveTo((-85 * 0.95) * 0.02, (53 * 1.4) * 0.02);
            ctx.quadraticCurveTo(-40 * 0.02, 0, 9 * 0.02, 0);
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate((Math.PI / 180) * (swingyNgpoD * 1.2 - 5));
            ctx.beginPath();
            ctx.moveTo((-85 * 0.95) * 0.02, (-53 * 1.4) * 0.02);
            ctx.quadraticCurveTo(-40 * 0.02, 0, 9 * 0.02, 0);
            ctx.stroke();
            ctx.restore();

            // Body
            ctx.strokeStyle = FB(colors.spider, "#000000", 0.15);
            ctx.fillStyle = F(colors.spider);

            ctx.beginPath();
            ctx.arc(0, 0, 42 * 0.02, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        });
    }

    function drawMosquito(ctx, x, y, r, t) {
        const s = r;
        const wing = Math.sin(t * 12) * 0.077;

        withTransform(ctx, x, y, s, () => {
            ctx.save();
            ctx.translate(1 / 3, 0);

            ctx.lineWidth = 0.3;

            ctx.strokeStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(1.625 + wing, 0);
            ctx.stroke();

            const bodycolor = blendHex(colors.fireAnt, colors.spider, 0.625);
            const abdoColor = blendHex(colors.fireAnt, colors.hellMobColor, 0.625);
            ctx.strokeStyle = FB(abdoColor, "#000000", 0.15);
            ctx.fillStyle = F(abdoColor);

            ctx.beginPath();
            ctx.ellipse(-1.15, 0, 1.05, 0.7, 0, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.scale(1.35, 1.35);
            ctx.translate(-.553, 0);
            ctx.fillStyle = F("#ffffff");
            ctx.globalAlpha = 0.3;

            ctx.save();
            ctx.rotate(wing - 0.2);
            ctx.translate(0, 0.3);
            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.5125, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.rotate(-wing + 0.2);
            ctx.translate(0, -0.3);
            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.5125, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.restore();

            ctx.strokeStyle = FB(bodycolor, "#000000", 0.15);
            ctx.fillStyle = F(bodycolor);

            ctx.lineWidth = 0.23;

            ctx.beginPath();
            ctx.arc(0, 0, 1, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(0, 0, 0.85, 0, TAU);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        });
    }

    function drawLovebug(ctx, x, y, r, t) {
        const s = r;
        const wing = Math.sin(t * 12) * 0.077;

        withTransform(ctx, x, y, s, () => {
            ctx.save();
            ctx.translate(1 / 3, 0);

            ctx.lineWidth = 0.3;

            ctx.strokeStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(1.625 + wing, 0);
            ctx.stroke();

            const bodycolor = blendHex(colors.fireAnt, colors.spider, 0.625);
            const abdoColor = blendHex(colors.fireAnt, colors.hellMobColor, 0.625);
            ctx.strokeStyle = FB(colors.darkGray, "#000000", 0.15);
            ctx.fillStyle = F(colors.darkGray);

            ctx.beginPath();
            ctx.ellipse(-1.15, 0, 1.05, 0.7, 0, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.save();
            ctx.scale(1.35, 1.35);
            ctx.translate(-.553, 0);
            ctx.fillStyle = F("#ffffff");
            ctx.globalAlpha = 0.3;

            ctx.save();
            ctx.rotate(wing - 0.2);
            ctx.translate(0, 0.3);
            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.5125, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.rotate(-wing + 0.2);
            ctx.translate(0, -0.3);
            ctx.beginPath();
            ctx.ellipse(-0.92 / 2, 0, 0.5125, 0.35, 0, 0, TAU);
            ctx.fill();
            ctx.restore();

            ctx.restore();

            ctx.strokeStyle = FB(colors.orange, "#000000", 0.15);
            ctx.fillStyle = F(colors.orange);

            ctx.lineWidth = 0.23;

            ctx.beginPath();
            ctx.arc(0, 0, 1, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(0, 0, 0.85, 0, TAU);
            ctx.fill();
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.scale(0.7, 0.7);
            ctx.translate(0.5, 0);

            ctx.lineWidth = 0.23;
            ctx.fillStyle = F(colors.darkGray);
            ctx.strokeStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(0.4, 0.55);
            ctx.lineTo(3, 1.3);
            ctx.quadraticCurveTo(1.1, 0.3, 0.4, 0.55);
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0.4, -0.55);
            ctx.lineTo(3, -1.3);
            ctx.quadraticCurveTo(1.1, -0.3, 0.4, -0.55);
            ctx.fill();
            ctx.stroke();

            ctx.restore();
        });
    }

    function drawHole(ctx, x, y, r, color) {
        withTransform(ctx, x, y, r, () => {
            ctx.fillStyle = F(color);
            ctx.beginPath();
            ctx.arc(0, 0, 1, 0, TAU);
            ctx.fill();

            ctx.fillStyle = FB(color, "#000000", 0.15);
            ctx.beginPath();
            ctx.arc(0, 0, .66, 0, TAU);
            ctx.fill();

            ctx.fillStyle = FB(color, "#000000", 0.3);
            ctx.beginPath();
            ctx.arc(0, 0, .33, 0, TAU);
            ctx.fill();
        });
    }

    function drawStinkbug(ctx, x, y, r, t) {
        const legAngle = Math.sin(t * 3) * 0.25;
        const legAngleA = Math.sin(t * 6) * 0.25;
        withTransform(ctx, x, y, r, () => {
            // grr stop hacking around with ctx state just to draw legs
            ctx.strokeStyle = F(colors.darkGray);
            ctx.lineWidth = .1;

            ctx.save();
            ctx.rotate(legAngle);
            ctx.beginPath();
            ctx.moveTo(-1.25, -1);
            ctx.quadraticCurveTo(0, -1, 0, 0);
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate(-legAngle);
            ctx.beginPath();
            ctx.moveTo(-1.25, 1);
            ctx.quadraticCurveTo(0, 1, 0, 0);
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate(-legAngle);
            ctx.beginPath();
            ctx.moveTo(1.25, -1);
            ctx.quadraticCurveTo(0, -1, 0, 0);
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate(legAngle);
            ctx.beginPath();
            ctx.moveTo(1.25, 1);
            ctx.quadraticCurveTo(0, 1, 0, 0);
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate(legAngle);
            ctx.beginPath();
            ctx.moveTo(0, -1.53);
            ctx.lineTo(0, 0);
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate(-legAngle);
            ctx.beginPath();
            ctx.moveTo(0, 1.53);
            ctx.lineTo(0, 0);
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.rotate(Math.PI);

            ctx.strokeStyle = FB(colors.cactusLightGreen, "#000000", 0.15);
            ctx.fillStyle = F(colors.cactusLightGreen);
            ctx.beginPath();
            ctx.arc(.25, 0, 0.95, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.strokeStyle = FB(colors.leafGreen, "#000000", 0.15);
            ctx.fillStyle = F(colors.leafGreen);
            ctx.beginPath();
            ctx.ellipse(0, 0, 0.975, 0.925, 0, Math.PI * 0.5, -Math.PI * 0.5);
            ctx.lineTo(1, 0);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        });
    }

    function drawBubble(ctx, x, y, r) {
        withTransform(ctx, x, y, r, () => {
            ctx.lineWidth = 0.05;
            ctx.strokeStyle = F(colors.bubbleGrey);
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.arc(0, 0, 1, 0, TAU);
            ctx.stroke();
            ctx.fillStyle = F(colors.bubbleGrey);
            ctx.globalAlpha = 0.25;
            ctx.fill();

            ctx.fillStyle = F(colors.white);
            ctx.beginPath();
            ctx.arc(.35, .35, .25, 0, TAU);
            ctx.fill();
            ctx.globalAlpha = 1;
        });
    }

    function drawJellyfish(ctx, x, y, r, t) {
        withTransform(ctx, x, y, r, () => {
            ctx.lineWidth = 0.05;
            ctx.strokeStyle = F(colors.jellyfish);
            ctx.globalAlpha = 0.95;
            ctx.beginPath();
            ctx.arc(0, 0, 1, 0, TAU);
            ctx.stroke();
            ctx.fillStyle = F(colors.jellyfish);
            ctx.globalAlpha = 0.45;
            ctx.fill();

            //tentacles
            ctx.lineWidth = 0.25;
            ctx.globalAlpha = 0.95;
            ctx.strokeStyle = F(colors.jellyfish);
            for (let i = 0; i < 8; i++) {
                const angle = (TAU / 8) * i;
                const wiggle = Math.sin(t * 7 + i) * 0.05;
                ctx.save();
                ctx.rotate(angle);

                ctx.beginPath();
                ctx.moveTo(0.7, 0);
                ctx.quadraticCurveTo(1.5, 0, 1.5, wiggle);
                ctx.stroke();

                ctx.restore();
            }
            ctx.globalAlpha = 1;
        });
    }

    function drawCrab(ctx, x, y, r, t) {
        const legSwingSpeed = 3;
        const legSwingAmount = 0.4;

        const clawSwing = -0.4 * Math.cos(t * legSwingSpeed);
        withTransform(ctx, x, y, r, () => {
            ctx.lineWidth = .15;
            ctx.fillStyle = F(colors.crabBodyOrange);
            ctx.strokeStyle = FB(colors.crabBodyOrange, "#000000", 0.2);
            ctx.beginPath();
            ctx.ellipse(0, 0, 0.675, 0.9, 0, 0, TAU);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(.375, .3);
            ctx.quadraticCurveTo(0, .1625, -.375, .3);
            ctx.moveTo(.375, -.3);
            ctx.quadraticCurveTo(0, -.1625, -.375, -.3);
            ctx.stroke();

            ctx.restore();
        });
    }

    function drawLeech(ctx, mob, x, y, r, t) {
        const bodyColor = colors.stingerBlack;
        const outlineColor = blendHex(colors.stingerBlack, "#000000", 0.15);
        const mouthColor = colors.stingerBlack;

        const segs = Array.isArray(mob.bodySegments) ? mob.bodySegments : [];
        const anim = Math.sin(t * 8) * 0.05;

        withTransform(ctx, 0, 0, r, () => {
            const wiggle = Math.sin(t * 7) * 0.05;

            ctx.lineWidth = 0.375;

            ctx.strokeStyle = F(colors.darkGray);
            ctx.beginPath();
            ctx.moveTo(-.1, 0.75);
            ctx.lineTo(1.45, 0.45 + anim);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(-.1, -0.75);
            ctx.lineTo(1.45, -0.45 - anim);
            ctx.stroke();
        });

        ctx.save();
        ctx.rotate(-(mob.angle || 0));
        ctx.translate(-x, -y);

        const points = [];

        for (let i = segs.length - 1; i >= 0; i--) {
            const seg = segs[i];
            if (!seg) continue;

            points.push({
                x: x + ((seg.x ?? mob.x) - (mob.x ?? 0)),
                y: y + ((seg.y ?? mob.y) - (mob.y ?? 0)),
                r: seg.radius || r * 0.75
            });
        }

        points.push({ x, y, r });

        if (points.length >= 2) {
            const avgR =
                points.reduce((sum, p) => sum + (p.r || r), 0) / points.length;

            ctx.lineCap = "round";
            ctx.lineJoin = "round";

            // darker outline underneath
            ctx.strokeStyle = FB(outlineColor, "#000000", 0.15);
            ctx.lineWidth = 2 * r;

            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);

            for (let i = 1; i < points.length - 1; i++) {
                const mx = (points[i].x + points[i + 1].x) * 0.5;
                const my = (points[i].y + points[i + 1].y) * 0.5;
                ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
            }

            const last = points[points.length - 1];
            ctx.lineTo(last.x, last.y);
            ctx.stroke();

            // main body line
            ctx.strokeStyle = F(bodyColor);
            ctx.lineWidth = .78 * r * 2;

            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);

            for (let i = 1; i < points.length - 1; i++) {
                const mx = (points[i].x + points[i + 1].x) * 0.5;
                const my = (points[i].y + points[i + 1].y) * 0.5;
                ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
            }

            ctx.lineTo(last.x, last.y);
            ctx.stroke();
        }

        ctx.restore();
    }

    const georgeImg = new Image();
    georgeImg.src = "george.png";

    function drawGeorge(ctx, x, y, r, a) {
        if (!georgeImg.complete || georgeImg.naturalWidth === 0) return;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-a)

        const size = r * 2;
        ctx.drawImage(georgeImg, -size / 2, -size / 2, size, size);

        ctx.restore();
    }

    // -------------------- Fallback --------------------
    function drawFallback(ctx, x, y, r) {
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
    }

    function drawMobObject(ctx, x, y, r, angle = 0, type) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(r, r);
        ctx.rotate(angle);
        switch (type) {
            case "hornetMissile": {
                ctx.lineWidth = 0.15;
                ctx.fillStyle = F(colors.stingerBlack);
                ctx.strokeStyle = F(colors.stingerBlack);
                const x = 1;

                ctx.beginPath();
                ctx.moveTo(1.55 * x, 0);
                ctx.lineTo(0.25 * x, -0.4 * x);
                ctx.lineTo(0.25 * x, 0.4 * x);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                break;
            }
            case "dandelionMissile": {
                ctx.lineWidth = 0.75;
                ctx.strokeStyle = F(colors.darkGray);
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.lineTo(-1.8, 0);
                ctx.stroke();

                ctx.fillStyle = F(colors.white);
                ctx.strokeStyle = FB(colors.white, "#000000", 0.15);
                ctx.lineWidth = 0.3;
                ctx.beginPath();
                ctx.arc(0, 0, 1, 0, TAU);
                ctx.fill();
                ctx.stroke();
                break;
            }
            default: {
                ctx.fillStyle = F("#111111");
                ctx.beginPath();
                ctx.arc(0, 0, 1, 0, TAU);
                ctx.fill();
                break;
            }
        }

        ctx.restore();
    }

    function drawHpBar(ctx, x, y, r, hp, maxHp, rarity) {
        const w = 45 * Math.pow(1.05, rarity);
        const pct = clamp(maxHp > 0 ? hp / maxHp : 0, 0, 1);

        const startX = x - w / 2;
        const endX = startX + w;
        const yPos = y + r + 12;

        ctx.lineCap = "round";

        // Background line
        ctx.lineWidth = 5;
        ctx.strokeStyle = "#1b1b1b";
        ctx.beginPath();
        ctx.moveTo(startX, yPos);
        ctx.lineTo(endX, yPos);
        ctx.stroke();

        // HP percent line
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#95ff7a";
        ctx.beginPath();
        ctx.moveTo(startX, yPos);
        ctx.lineTo(startX + w * pct, yPos);
        ctx.stroke();

    }
    const petalRarityStatic = {
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
        10: { name: "Sublime", color: "#222222" }
    };

    function petalRarityBorderColor(rarity = 0) {
        const rr = Number.isFinite(rarity) ? rarity : 0;
        return petalRarityStatic[rr]?.color || "#ffffff";
    }

    function drawPetalCircle(ctx, x, y, r) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
    }

    function drawPetalArt(ctx, typeId, rarity, x, y, radius, opts = {}) {
        ctx.save();

        ctx.translate(x, y);
        ctx.scale(radius, radius);

        // existing drawPetalArt switch goes here
        // keep basic exactly how it already was
        // use unit-sized drawing values, not r * values

        switch (typeId) {
            case "basic": {
                ctx.lineWidth = 0.3;
                ctx.fillStyle = F(colors.white);
                ctx.strokeStyle = FB(colors.white, "#000000", 0.15);

                ctx.beginPath();
                ctx.arc(0, 0, 1, 0, TAU);
                ctx.fill();
                ctx.stroke();
                break;
            }
            case "rose": {
                ctx.lineWidth = 0.3 * (4 / 3);
                ctx.fillStyle = F(colors.rosePink);
                ctx.strokeStyle = FB(colors.rosePink, "#000000", 0.15);

                ctx.beginPath();
                ctx.arc(0, 0, 1, 0, TAU);
                ctx.fill();
                ctx.stroke();
                break;
            }
            case "stinger": {
                ctx.lineWidth = 0.3;
                ctx.fillStyle = F(colors.stingerBlack);
                ctx.strokeStyle = FB(colors.stingerBlack, "#000000", 0.15);
                drawPolygonPath(ctx, 3, 1.5, TAU / 3, 1, 1);
                ctx.fill();
                ctx.stroke();
                break;
            }
            default: {
                ctx.lineWidth = 0.3;
                ctx.fillStyle = F(colors.white);
                ctx.strokeStyle = FB(colors.white, "#000000", 0.15);

                ctx.beginPath();
                ctx.arc(0, 0, 1, 0, TAU);
                ctx.fill();
                ctx.stroke();
                break;
            }
        }
        ctx.restore();
    }

    function drawPetalArtFlash(ctx, petal, x, y, size, opts = {}) {
        if (!petal) return;

        const id = opts.flashId ?? petal.flashId ?? petal.id ?? null;
        const hp = petal.hp ?? null;

        _flashA = computeDamageFlash(id, hp);

        const angle =
            opts.angle ??
            petal.spinAngle ??
            petal.angle ??
            0;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);

        drawPetalArt(
            ctx,
            petal.typeId,
            petal.rarity ?? 0,
            0,
            0,
            size,
            opts
        );

        ctx.restore();

        _flashA = 0;
    }

    function drawPetalArtRotated(ctx, typeId, rarity, x, y, size, angle = 0, opts = {}) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);

        drawPetalArt(
            ctx,
            typeId,
            rarity ?? 0,
            0,
            0,
            size,
            opts
        );

        ctx.restore();
    }

    const Render = {
        drawMob(ctx, mob, x, y, r) {
            const t = nowSec();

            // calculate speed (units per second) and drive animation rate
            const vx = mob.vx || 0;
            const vy = mob.vy || 0;
            const speed = Math.hypot(vx, vy);
            // faster mobs should animate more quickly; keep original time as base
            const animTime = t * (0.8 + speed * ANIM_SPEED_SCALE);

            // Fix: it's lineCap, not lineEnd
            ctx.lineJoin = "round";
            ctx.lineCap = "round";

            // --- Detect damage by comparing HP vs last frame ---
            const id = mob.id; // assumes your server gives mobs a stable id
            if (id != null) {
                const prevHp = lastHpById.get(id);
                if (prevHp != null && mob.hp != null && mob.hp < prevHp) {
                    flashEndById.set(id, t + FLASH_DURATION);
                }
                if (mob.hp != null) lastHpById.set(id, mob.hp);
            }

            // Compute flash alpha (fades out)
            let flashAlpha = 0;
            if (id != null) {
                const end = flashEndById.get(id) || 0;
                const left = end - t;
                if (left > 0) {
                    const k = clamp(left / FLASH_DURATION, 0, 1); // 1 -> 0
                    flashAlpha = k * FLASH_STRENGTH;
                } else if (end !== 0) {
                    flashEndById.delete(id); // cleanup
                }
            }

            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(mob.angle || 0);

            // set per-mob flash amount for the helper functions
            _flashA = flashAlpha;

            // Draw the mob normally first, then draw the flash on top so it doesn't get obscured by the mob's own pixels.
            let out;
            switch (mob.type) {
                // pass the adjusted animation time to the drawing helpers so they
                // can run faster when the mob is moving quickly
                case "george": out = drawGeorge(ctx, 0, 0, r, mob.angle); break;
                //must start with the best mob obv
                case "stinkbug": out = drawStinkbug(ctx, 0, 0, r, animTime); break;
                case "ant": out = drawWorkerAnt(ctx, 0, 0, r, animTime); break;
                case "mechaAnt": out = drawMechaTermite(ctx, 0, 0, r, animTime); break;
                case "beetle": out = drawBeetle(ctx, 0, 0, r, animTime, mob.faction); break;
                case "beetle_hel": out = drawScawwyBeetle(ctx, 0, 0, r, animTime); break;
                case "mechaBeetle": out = drawMechaBeetle(ctx, 0, 0, r, animTime); break;
                case "rockMob": out = drawRockMob(ctx, 0, 0, r, mob.randoms, mob.rarity); break;
                case "bubble": out = drawBubble(ctx, 0, 0, r); break;
                case "jellyfish": out = drawJellyfish(ctx, 0, 0, r); break;
                case "queenAnt": out = drawQueenAnt(ctx, 0, 0, r, animTime); break;
                case "ladybug": out = drawLadybug(ctx, 0, 0, r, mob.randoms, mob.rarity, colors.ladybugRed, colors.darkGray); break;
                case "centipede": out = drawCentipede(ctx, 0, 0, r, animTime, colors.peaGreen, mob.chainPrevId); break;
                case "centipedeDesert": out = drawCentipede(ctx, 0, 0, r, animTime, colors.sand, mob.chainPrevId); break;
                case "hornet": out = drawHornet(ctx, 0, 0, r, animTime); break;
                case "wasp": out = drawWasp(ctx, 0, 0, r, animTime); break;
                case "mechaWasp": out = drawMechaWasp(ctx, 0, 0, r, animTime); break;
                case "bee": out = drawBee(ctx, 0, 0, r, animTime); break;
                case "beeQueen": out = drawBeeQueen(ctx, 0, 0, r, animTime); break;
                case "antBaby": out = drawBabyAnt(ctx, 0, 0, r, animTime); break;
                case "bumblebee": out = drawBumblebee(ctx, 0, 0, r, animTime); break;
                case "cactus": out = drawCactusMob(ctx, 0, 0, r, mob.randoms, mob.rarity); break;
                case "scorpion": out = drawScorpion(ctx, 0, 0, r, animTime); break;
                case "fly": out = drawFly(ctx, 0, 0, r, animTime); break;
                case "ladybugShiny": out = drawLadybug(ctx, 0, 0, r, mob.randoms, mob.rarity, colors.shinyLadybugGold, colors.darkGray); break;
                case "sandstorm": out = drawStorm(ctx, 0, 0, r, animTime); break;
                case "garbage": out = drawGarbage(ctx, 0, 0, r, mob.randoms); break;
                case "spider": out = drawSpider(ctx, 0, 0, r, animTime); break;
                case "mosquito": out = drawMosquito(ctx, 0, 0, r, animTime); break;
                case "lovebug": out = drawLovebug(ctx, 0, 0, r, animTime); break;
                case "clam": out = drawClam(ctx, 0, 0, r); break;
                case "beeEgg": out = drawEgg(ctx, 0, 0, r, colors.beeYellow); break;
                case "antEgg": out = drawEgg(ctx, 0, 0, r, colors.cumWhite); break;
                case "stalagmite": out = drawStalagmite(ctx, 0, 0, r, mob.randoms, mob.rarity); break;
                case "stonefly": out = drawStonefly(ctx, 0, 0, r, animTime); break;
                case "pillbug": out = drawPillBug(ctx, 0, 0, r, animTime); break;
                case "milipede": out = drawMilipede(ctx, 0, 0, r, animTime, colors.peaGreen, mob.chainPrevId); break;
                case "mite": out = drawMite(ctx, 0, 0, r, animTime); break;
                case "dandelion": out = drawDandysWorld(ctx, 0, 0, r); break;
                case "antHole": out = drawHole(ctx, 0, 0, r, colors.antHole); break;
                case "crab": out = drawCrab(ctx, 0, 0, r, animTime); break;
                case "leech": out = drawLeech(ctx, mob, x, y, r, animTime); break;
                default: out = drawFallback(ctx, 0, 0, r); break;
            }

            // IMPORTANT: reset so UI/text/etc doesn't get “mysteriously” tinted
            _flashA = 0;

            ctx.restore();
            return out;
        },
        drawMobObject(ctx, o, x, y, r) {
            const t = nowSec();

            // Use a separate key so mob id 5 and mobObject id 5 don't share flash state.
            const id = o?.id != null ? `obj:${o.id}` : null;

            // Detect damage by comparing HP to last frame.
            if (id != null) {
                const prevHp = lastHpById.get(id);

                if (prevHp != null && o.hp != null && o.hp < prevHp) {
                    flashEndById.set(id, t + FLASH_DURATION);
                }

                if (o.hp != null) {
                    lastHpById.set(id, o.hp);
                }
            }

            // Compute flash fade.
            let flashAlpha = 0;

            if (id != null) {
                const end = flashEndById.get(id) || 0;
                const left = end - t;

                if (left > 0) {
                    const k = clamp(left / FLASH_DURATION, 0, 1);
                    flashAlpha = k * FLASH_STRENGTH;
                } else if (end !== 0) {
                    flashEndById.delete(id);
                }
            }

            _flashA = flashAlpha;

            drawMobObject(ctx, x, y, r, o.angle ?? 0, o.type);

            // Reset so UI/other renders don't become accidentally red.
            _flashA = 0;
        },
        drawHpBar,
        drawPetalArt,
        drawPetalArtFlash,
        drawPetalArtRotated
    };

    window.Render = Render;
})();