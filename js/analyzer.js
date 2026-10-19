export const BIN_COUNT = 80;
const FFT_SIZE = 2048;

const clampByte = (v) => Math.min(255, Math.max(0, v));

export function emptyFrame() {
    return {
        left: new Float32Array(BIN_COUNT), right: new Float32Array(BIN_COUNT),
        bass: 0, mid: 0, average: 0, intensity: 0, gain: 1,
        songEnergy: 0, songBass: 0, songOnset: 0, songDrive: 0, songSection: 0,
        profiled: false, stereo: false,
    };
}

// In-place iterative radix-2 complex FFT.
class FFT {
    constructor(n) {
        this.n = n;
        this.rev = new Uint32Array(n);
        const bits = Math.log2(n);
        for (let i = 0; i < n; ++i) {
            let r = 0;
            for (let b = 0; b < bits; ++b) r |= ((i >> b) & 1) << (bits - 1 - b);
            this.rev[i] = r;
        }
        this.cos = new Float64Array(n / 2);
        this.sin = new Float64Array(n / 2);
        for (let i = 0; i < n / 2; ++i) {
            this.cos[i] = Math.cos(-2 * Math.PI * i / n);
            this.sin[i] = Math.sin(-2 * Math.PI * i / n);
        }
        this.re = new Float64Array(n);
        this.im = new Float64Array(n);
    }

    // Transforms real input; results land in this.re / this.im.
    run(input) {
        const { n, rev, re, im } = this;
        for (let i = 0; i < n; ++i) { re[rev[i]] = input[i]; im[rev[i]] = 0; }
        for (let size = 2; size <= n; size <<= 1) {
            const halfSize = size >> 1;
            const step = n / size;
            for (let start = 0; start < n; start += size) {
                for (let k = 0; k < halfSize; ++k) {
                    const wr = this.cos[k * step], wi = this.sin[k * step];
                    const a = start + k, b = a + halfSize;
                    const tr = re[b] * wr - im[b] * wi;
                    const ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] += tr; im[a] += ti;
                }
            }
        }
    }
}

const hann = new Float64Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; ++i) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1));

const binRanges = [];
for (let v = 0; v < BIN_COUNT; ++v) {
    const start = Math.max(1, Math.floor(1 + Math.pow(v / BIN_COUNT, 1.7) * 700));
    const end = Math.max(start + 1, Math.floor(1 + Math.pow((v + 1) / BIN_COUNT, 1.7) * 700));
    binRanges.push([start, end]);
}

export function summarize(frame) {
    let bass = 0, mid = 0, total = 0;
    for (let i = 0; i < BIN_COUNT; ++i) {
        const mono = (frame.left[i] + frame.right[i]) * 0.5;
        total += mono;
        if (i >= 1 && i < 5) bass += mono;
        if (i >= 5 && i < 50) mid += mono;
    }
    frame.bass = bass / 4;
    frame.mid = mid / 45;
    frame.average = total / BIN_COUNT;
    frame.intensity = Math.min(1, (frame.bass * 0.8 + frame.mid * 0.5) / 255);
    return frame;
}

export class AudioAnalyzer {
    constructor() {
        this.fft = new FFT(FFT_SIZE);
        this.input = new Float64Array(FFT_SIZE);
        this.reset();
    }

    reset() {
        this.loudnessReference = 0;
        this.visualGain = 1;
        this.lastSeconds = -1;
    }

    // channels: Float32Array[]; centerFrame: sample index the window is centered on.
    analyzeChannels(channels, centerFrame, seconds, profile) {
        const frame = emptyFrame();
        if (!channels.length) return frame;
        this.computeChannel(channels[0], centerFrame, frame.left);
        this.computeChannel(channels[channels.length > 1 ? 1 : 0], centerFrame, frame.right);
        frame.stereo = channels.length > 1;
        let out = this.normalizeForSong(summarize(frame), seconds);
        if (profile && !profile.empty) out = this.applySongProfile(out, profile, seconds);
        return out;
    }

    analyze(channels, sampleRate, seconds, profile) {
        const center = Math.floor(Math.min(Math.max(seconds, 0), 86400) * sampleRate);
        return this.analyzeChannels(channels, center, seconds, profile);
    }

    computeChannel(samples, centerFrame, bins) {
        const start = centerFrame - FFT_SIZE / 2;
        const total = samples.length;
        const input = this.input;
        for (let i = 0; i < FFT_SIZE; ++i) {
            const idx = start + i;
            input[i] = (idx >= 0 && idx < total ? samples[idx] : 0) * hann[i];
        }
        this.fft.run(input);
        const { re, im } = this.fft;
        for (let v = 0; v < BIN_COUNT; ++v) {
            const [s, e] = binRanges[v];
            let sum = 0, count = 0;
            for (let b = s; b < e && b <= FFT_SIZE / 2; ++b) {
                sum += Math.sqrt(re[b] * re[b] + im[b] * im[b]);
                ++count;
            }
            const avg = count > 0 ? sum / count : 0;
            const normalized = avg / (FFT_SIZE * 0.20);
            bins[v] = clampByte(Math.pow(Math.max(0, normalized), 0.45) * 255);
        }
    }

    normalizeForSong(frame, seconds) {
        if (this.lastSeconds >= 0 && seconds < this.lastSeconds - 1) this.reset();
        this.lastSeconds = seconds;

        const measured = frame.average;
        if (measured < 0.35) {
            frame.gain = this.visualGain;
            return frame;
        }
        const first = this.loudnessReference <= 0;
        if (first) {
            this.loudnessReference = measured;
        } else {
            const attack = measured > this.loudnessReference ? 0.08 : 0.003;
            this.loudnessReference += (measured - this.loudnessReference) * attack;
        }
        const targetGain = Math.min(18, Math.max(0.45, 68 / Math.max(this.loudnessReference, 1)));
        this.visualGain = first ? targetGain : this.visualGain + (targetGain - this.visualGain) * 0.12;

        for (let i = 0; i < BIN_COUNT; ++i) {
            frame.left[i] = clampByte(frame.left[i] * this.visualGain);
            frame.right[i] = clampByte(frame.right[i] * this.visualGain);
        }
        frame.gain = this.visualGain;
        return summarize(frame);
    }

    applySongProfile(frame, profile, seconds) {
        const p = profile.sample(seconds);
        frame.profiled = true;
        frame.songEnergy = p.energy;
        frame.songBass = p.bass;
        frame.songOnset = p.onset;
        frame.songDrive = p.drive;
        frame.songSection = p.section;
        frame.average = Math.max(frame.average, 18 + p.drive * 90);
        frame.bass = Math.max(frame.bass, p.bass * 210 + p.onset * 60);
        frame.mid = Math.max(frame.mid, p.energy * 150 + p.onset * 45);
        frame.intensity = Math.max(frame.intensity, clampByte(p.drive * 210 + p.onset * 80) / 255);
        return frame;
    }

    demoFrame(seconds, active) {
        const frame = emptyFrame();
        const drive = active ? 1 : 0.35;
        const bassPulse = 0.5 + 0.5 * Math.sin(seconds * 3.6);
        const midPulse = 0.5 + 0.5 * Math.sin(seconds * 7.1 + 1.8);
        for (let i = 0; i < BIN_COUNT; ++i) {
            const t = i / BIN_COUNT;
            const ripple = 0.5 + 0.5 * Math.sin(seconds * (2 + t * 9) + t * 18);
            const bassW = Math.exp(-t * 7);
            const midW = Math.exp(-Math.abs(t - 0.35) * 5);
            const value = drive * (30 + 170 * ripple * (0.35 + bassW * bassPulse + midW * midPulse));
            frame.left[i] = clampByte(value);
            frame.right[i] = clampByte(value * (0.82 + 0.18 * Math.sin(seconds * 2 + t * 9)));
        }
        frame.stereo = true;
        return summarize(frame);
    }
}
