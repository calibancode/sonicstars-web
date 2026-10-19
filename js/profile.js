const clamp01 = (v) => Math.min(1, Math.max(0, v));

function percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = Float32Array.from(values).sort();
    const index = clamp01(p) * (sorted.length - 1);
    const low = Math.floor(index);
    const high = Math.ceil(index);
    if (low === high) return sorted[low];
    const t = index - low;
    return sorted[low] * (1 - t) + sorted[high] * t;
}

function normalize(value, low, high, gamma = 0.85) {
    if (high <= low + 1e-6) return value > high ? 1 : 0;
    return Math.pow(clamp01((value - low) / (high - low)), gamma);
}

// Audiosurf-style whole-song terrain map. `channels` is an array of Float32Array.
export class SongProfile {
    constructor() {
        this.points = [];
        this.hopSeconds = 0.10;
        this.averageDrive = 0;
        this.peakDrive = 0;
        this.peakOnset = 0;
    }

    get empty() { return this.points.length === 0; }

    sample(seconds) {
        const pts = this.points;
        if (pts.length === 0) return null;
        if (seconds <= pts[0].timeSeconds) return pts[0];
        if (seconds >= pts[pts.length - 1].timeSeconds) return pts[pts.length - 1];
        const exact = seconds / this.hopSeconds;
        const index = Math.floor(exact);
        const next = Math.min(index + 1, pts.length - 1);
        const t = clamp01(exact - index);
        const a = pts[index], b = pts[next];
        const mix = (k) => a[k] * (1 - t) + b[k] * t;
        return {
            timeSeconds: seconds,
            energy: mix('energy'), bass: mix('bass'), brightness: mix('brightness'),
            onset: mix('onset'), drive: mix('drive'), section: mix('section'),
        };
    }

    summary() {
        if (this.empty) return 'profile empty';
        return `profile ${this.points.length} slices avgDrive ${this.averageDrive.toFixed(2)} ` +
            `peakDrive ${this.peakDrive.toFixed(2)} peakOnset ${this.peakOnset.toFixed(2)}`;
    }

    static build(channels, sampleRate, durationSeconds) {
        const profile = new SongProfile();
        if (!channels.length || !sampleRate) return profile;
        const totalFrames = channels[0].length;
        if (totalFrames === 0) return profile;

        // Mix down once instead of per-sample per-slice.
        const mono = new Float32Array(totalFrames);
        for (const ch of channels) for (let i = 0; i < totalFrames; ++i) mono[i] += ch[i];
        const inv = 1 / channels.length;
        for (let i = 0; i < totalFrames; ++i) mono[i] *= inv;

        const hop = profile.hopSeconds;
        const sliceCount = Math.max(1, Math.ceil(durationSeconds / hop));
        const windowFrames = Math.max(512, Math.floor(sampleRate * 0.16));
        const half = Math.floor(windowFrames / 2);
        const bassAlpha = 1 - Math.exp(-2 * Math.PI * 180 / sampleRate);

        const raw = new Array(sliceCount);
        const energies = new Float32Array(sliceCount);
        const basses = new Float32Array(sliceCount);
        const brights = new Float32Array(sliceCount);

        for (let i = 0; i < sliceCount; ++i) {
            const time = i * hop;
            const center = Math.floor(time * sampleRate);
            const start = Math.max(0, center - half);
            const end = Math.min(totalFrames, center + half);
            let e = 0, b = 0, h = 0, low = 0;
            for (let f = start; f < end; ++f) {
                const s = mono[f];
                low += bassAlpha * (s - low);
                const high = s - low;
                e += s * s; b += low * low; h += high * high;
            }
            const n = end - start;
            const ic = n > 0 ? 1 / n : 0;
            raw[i] = { timeSeconds: time, energy: Math.sqrt(e * ic), bass: Math.sqrt(b * ic), brightness: Math.sqrt(h * ic), onset: 0 };
            energies[i] = raw[i].energy; basses[i] = raw[i].bass; brights[i] = raw[i].brightness;
        }

        const fluxes = new Float32Array(sliceCount);
        for (let i = 1; i < sliceCount; ++i) {
            const r = raw[i], p = raw[i - 1];
            r.onset = Math.max(0, r.energy - p.energy) + Math.max(0, r.bass - p.bass) * 0.65 +
                Math.max(0, r.brightness - p.brightness) * 0.25;
            fluxes[i] = r.onset;
        }

        const eF = percentile(energies, 0.08), eC = percentile(energies, 0.94);
        const bF = percentile(basses, 0.08), bC = percentile(basses, 0.95);
        const hF = percentile(brights, 0.08), hC = percentile(brights, 0.95);
        const oC = Math.max(percentile(fluxes, 0.96), 1e-5);

        const nEnergy = new Float32Array(sliceCount);
        for (let i = 0; i < sliceCount; ++i) nEnergy[i] = normalize(raw[i].energy, eF, eC, 0.75);

        // Prefix sums for the section average window.
        const prefix = new Float64Array(sliceCount + 1);
        for (let i = 0; i < sliceCount; ++i) prefix[i + 1] = prefix[i] + nEnergy[i];

        const radius = Math.max(1, Math.floor(2.5 / hop));
        for (let i = 0; i < sliceCount; ++i) {
            const s0 = Math.max(0, i - radius);
            const s1 = Math.min(sliceCount, i + radius + 1);
            const point = {
                timeSeconds: raw[i].timeSeconds,
                energy: nEnergy[i],
                bass: normalize(raw[i].bass, bF, bC, 0.80),
                brightness: normalize(raw[i].brightness, hF, hC, 0.80),
                onset: clamp01(Math.pow(raw[i].onset / oC, 0.65)),
                section: (prefix[s1] - prefix[s0]) / (s1 - s0),
                drive: 0,
            };
            point.drive = clamp01(point.energy * 0.46 + point.bass * 0.20 + point.brightness * 0.10 +
                point.onset * 0.52 + point.section * 0.20);
            profile.peakDrive = Math.max(profile.peakDrive, point.drive);
            profile.peakOnset = Math.max(profile.peakOnset, point.onset);
            profile.averageDrive += point.drive;
            profile.points.push(point);
        }
        profile.averageDrive /= profile.points.length;
        return profile;
    }
}
