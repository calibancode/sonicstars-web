const rand = (min, max) => min + Math.random() * (max - min);

export function hsl(h, s, l, a = 1) {
    h = ((h % 360) + 360) % 360;
    return `hsla(${h.toFixed(1)},${(s * 100).toFixed(0)}%,${(l * 100).toFixed(0)}%,${a.toFixed(3)})`;
}

function randomStarPosition() {
    let x, y;
    do {
        x = rand(-0.5, 0.5) * 5000;
        y = rand(-0.5, 0.5) * 5000;
    } while (x * x + y * y < 100 * 100);
    return [x, y];
}

export class Visualizer {
    constructor() {
        this.stars = [];
        for (let i = 0; i < 1000; ++i) {
            const [x, y] = randomStarPosition();
            this.stars.push({ x, y, z: rand(0, 2000), size: rand(0.5, 2) });
        }
        this.speed = 0;
        this.shake = 0;
        this.hue = 240;
        this.targetHue = 240;
    }

    draw(ctx, w, h, spectrum, dtSeconds) {
        const cx = w * 0.5, cy = h * 0.5;
        const dt = Math.min(6, Math.max(0, dtSeconds / (1 / 60)));

        const liveDrive = Math.max(spectrum.average, Math.max(spectrum.mid * 0.85, spectrum.bass * 0.35));
        const profiledDrive = spectrum.profiled ? spectrum.songDrive : Math.min(1, Math.max(0, liveDrive / 110));
        const onsetKick = spectrum.profiled ? spectrum.songOnset : 0;
        const targetSpeed = 2 + Math.pow(liveDrive / 32, 2.4) + profiledDrive * 38 + onsetKick * 28;
        if (Number.isFinite(targetSpeed)) this.speed += (targetSpeed - this.speed) * 0.05 * dt;
        if (!Number.isFinite(this.speed)) this.speed = 2;

        const intensity = Math.max(spectrum.intensity, spectrum.songDrive * 0.7 + spectrum.songOnset * 0.35);
        this.targetHue = intensity > 0.92 ? 10 : intensity > 0.6 ? 180 : 260;
        this.hue += (this.targetHue - this.hue) * 0.05 * dt;

        if (spectrum.bass > 250 || spectrum.songOnset > 0.82) {
            this.shake = Math.max(this.shake, 5 + Math.max(0, spectrum.bass - 200) * 0.2 + spectrum.songOnset * 10);
        }
        this.shake *= Math.pow(0.9, dt);
        const sx = rand(-0.5, 0.5) * this.shake;
        const sy = rand(-0.5, 0.5) * this.shake;

        const speed = this.speed;
        const streaking = speed > 20;
        // Bucket by alpha so we can batch paths instead of one fill per star.
        const buckets = 16;
        const paths = Array.from({ length: buckets }, () => new Path2D());
        const widths = streaking ? Array.from({ length: buckets }, () => []) : null;

        for (const star of this.stars) {
            star.z -= speed * dt;
            if (star.z <= 0) {
                [star.x, star.y] = randomStarPosition();
                star.z += 2000;
                if (star.z <= 0) star.z = 2000;
            }
            const persp = 500 / star.z;
            const px = cx + star.x * persp + sx;
            const py = cy + star.y * persp + sy;
            if (px < -100 || px > w + 100 || py < -100 || py > h + 100) continue;

            const dot = Math.max(0.5, star.size * persp);
            const alpha = Math.min(1, Math.max(0, (2000 - star.z) / 1000));
            const bucket = Math.min(buckets - 1, Math.floor(alpha * buckets));
            if (streaking) {
                const len = Math.min(100, speed * persp * 0.5);
                const ang = Math.atan2(py - cy, px - cx);
                widths[bucket].push(px, py, px - Math.cos(ang) * len, py - Math.sin(ang) * len, dot);
            } else {
                const r = dot * 0.5;
                paths[bucket].rect(px - r, py - r, dot, dot);
            }
        }

        for (let b = 0; b < buckets; ++b) {
            const color = hsl(this.hue, 0.8, 0.85, (b + 0.5) / buckets);
            if (streaking) {
                ctx.strokeStyle = color;
                ctx.lineCap = 'butt';
                const list = widths[b];
                for (let i = 0; i < list.length; i += 5) {
                    ctx.lineWidth = list[i + 4];
                    ctx.beginPath();
                    ctx.moveTo(list[i], list[i + 1]);
                    ctx.lineTo(list[i + 2], list[i + 3]);
                    ctx.stroke();
                }
            } else {
                ctx.fillStyle = color;
                ctx.fill(paths[b]);
            }
        }

        const bars = 40;
        const roadWidth = Math.min(w, h) * 0.8;
        const bottomY = h + 200 + sy;
        for (const side of [-1, 1]) {
            const target = side === -1 ? spectrum.left : spectrum.right;
            for (let i = 0; i < bars; ++i) {
                const val = target[Math.min(i * 2, target.length - 1)];
                const t = i / bars, nt = (i + 1) / bars;
                const xBase = cx + sx + side * (t * roadWidth * 0.5);
                const xEnd = cx + sx + side * (nt * roadWidth * 0.5);
                const barHeight = val * 1.5 + speed * 2;
                const topY = h - barHeight * (1 - t) + sy;

                ctx.fillStyle = hsl(this.hue + i * 2, 1, 0.5, 0.6);
                ctx.beginPath();
                ctx.moveTo(xBase, bottomY); ctx.lineTo(xEnd, bottomY);
                ctx.lineTo(xEnd, topY); ctx.lineTo(xBase, topY);
                ctx.fill();

                const ry = h + barHeight * 0.5 + 50;
                ctx.fillStyle = hsl(this.hue + i * 2, 1, 0.5, 0.1);
                ctx.beginPath();
                ctx.moveTo(xBase, bottomY); ctx.lineTo(xEnd, bottomY);
                ctx.lineTo(xEnd * 1.5 - cx * 0.5, ry); ctx.lineTo(xBase * 1.5 - cx * 0.5, ry);
                ctx.fill();
            }
        }
    }
}
