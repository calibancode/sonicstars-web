import { AudioAnalyzer, emptyFrame } from './analyzer.js';
import { SongProfile } from './profile.js';
import { Visualizer, hsl } from './visualizer.js';
import { parseLrc, activeLyricIndex, lyricShouldClear } from './lyrics.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const ctx = canvas.getContext('2d');
const audio = $('audio');
const hud = $('hud');

const analyzer = new AudioAnalyzer();
const visualizer = new Visualizer();

const state = {
    mode: 'demo',            // 'demo' | 'pending' | 'track'
    demoActive: true,
    demoSeconds: 0,
    track: null,             // { name, channels, sampleRate, duration, profile }
    lyrics: [],
    status: 'Procedural demo mode — open a file or drop one here',
    hudIdle: 0,
    pointerInHud: false,
};

let audioCtx = null;

// <audio>.currentTime only advances every ~15-250ms depending on the browser,
// which made the bars step. Extrapolate between updates with the frame clock.
const clock = {
    base: 0, at: 0,
    resync() { this.base = audio.currentTime; this.at = performance.now(); },
    now() {
        const reported = audio.currentTime;
        if (audio.paused || audio.seeking) { this.resync(); return reported; }
        const est = this.base + (performance.now() - this.at) / 1000 * audio.playbackRate;
        // Snap on seeks/loops/drift; otherwise keep the smooth estimate.
        if (Math.abs(est - reported) > 0.3) { this.resync(); return reported; }
        if (reported > this.base) { this.base = reported; this.at = performance.now(); }
        return Math.max(est, reported);
    },
};

function ensureAudioCtx() {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function setStatus(text) {
    state.status = text;
    $('status').textContent = text;
}

// ---------- loading ----------

let loadToken = 0;
async function loadFiles(fileList) {
    const files = [...fileList];
    const lrc = files.find((f) => /\.lrc$/i.test(f.name));
    const audioFile = files.find((f) => f.type.startsWith('audio/') || /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|webm)$/i.test(f.name));

    if (!audioFile && lrc) {
        state.lyrics = parseLrc(await lrc.text());
        setStatus(`Loaded lyrics ${lrc.name} (${state.lyrics.length} lines)`);
        return;
    }
    if (!audioFile) {
        setStatus('No audio file found in selection.');
        return;
    }

    if (audio.src) URL.revokeObjectURL(audio.src);
    audio.src = URL.createObjectURL(audioFile);
    audio.loop = false;
    state.mode = 'pending';
    state.track = null;
    state.lyrics = [];
    const token = ++loadToken;
    // play() inside the drop/click gesture unlocks the element for autoplay;
    // hold it paused until analysis is ready so audio and visuals start together.
    audio.muted = true;
    const playAttempt = audio.play().then(() => {
        if (token === loadToken && state.mode === 'pending') audio.pause();
        return true;
    }, () => false);
    setStatus(`Decoding ${audioFile.name}…`);
    try {
        const ac = ensureAudioCtx();
        const buffer = await ac.decodeAudioData(await audioFile.arrayBuffer());
        const channels = [];
        for (let c = 0; c < buffer.numberOfChannels; ++c) channels.push(buffer.getChannelData(c));
        setStatus(`Profiling ${audioFile.name}…`);
        await new Promise((r) => setTimeout(r, 0));
        if (token !== loadToken) return;
        const profile = SongProfile.build(channels, buffer.sampleRate, buffer.duration);

        analyzer.reset();
        state.track = { name: audioFile.name, channels, sampleRate: buffer.sampleRate, duration: buffer.duration, profile };
        state.mode = 'track';
        state.lyrics = lrc ? parseLrc(await lrc.text()) : [];
        const unlocked = await playAttempt;
        if (token !== loadToken) return;
        audio.currentTime = 0;
        audio.muted = false;
        const played = unlocked && await audio.play().then(() => true, () => false);
        clock.resync();
        setStatus(`Loaded ${audioFile.name}${state.lyrics.length ? ' with lyrics' : ''}` +
            (played ? '' : ' - press Space to play'));
    } catch (err) {
        if (token !== loadToken) return;
        console.error(err);
        setStatus(`Could not load ${audioFile.name}: ${err.message || err}. Using demo mode.`);
        audio.pause();
        audio.muted = false;
        audio.removeAttribute('src');
        state.mode = 'demo';
    }
    refreshControls();
}

// ---------- controls ----------

function togglePlay() {
    if (state.mode === 'pending') return;
    if (state.mode === 'track' || state.mode === 'pending') {
        audio.paused ? audio.play() : audio.pause();
    } else {
        state.demoActive = !state.demoActive;
        setStatus(state.demoActive ? 'Procedural demo mode' : 'Demo paused');
    }
    refreshControls();
}

function seekBy(s) {
    if (state.mode !== 'track') return;
    audio.currentTime = Math.min(Math.max(0, audio.currentTime + s), state.track.duration);
}

function setVolume(v) {
    audio.volume = Math.min(1, Math.max(0, v));
    $('volume').value = audio.volume;
}

function stopAll() {
    if (state.mode === 'track') {
        audio.pause();
        audio.currentTime = 0;
    } else {
        analyzer.reset();
        state.demoSeconds = 0;
    }
    refreshControls();
}

function toggleLoop() {
    audio.loop = !audio.loop;
    refreshControls();
}

function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
}

function isActive() {
    return state.mode === 'track' || state.mode === 'pending' ? !audio.paused : state.demoActive;
}

function refreshControls() {
    const isTrack = state.mode === 'track';
    $('play').textContent = isActive() ? 'Pause' : 'Play';
    $('loop').classList.toggle('on', audio.loop);
    for (const id of ['loop', 'stop', 'back', 'fwd']) $(id).disabled = !isTrack && id !== 'stop';
    $('volume').disabled = !isTrack;
    $('hint').textContent = isTrack
        ? 'SPACE play/pause   ← → seek   ↑ ↓ volume   L loop   S stop   F fullscreen'
        : 'SPACE pause/resume   S reset demo   F fullscreen';
}

$('open').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
$('play').addEventListener('click', togglePlay);
$('stop').addEventListener('click', stopAll);
$('back').addEventListener('click', () => seekBy(-5));
$('fwd').addEventListener('click', () => seekBy(5));
$('loop').addEventListener('click', toggleLoop);
$('fs').addEventListener('click', toggleFullscreen);
$('volume').addEventListener('input', (e) => setVolume(parseFloat(e.target.value)));
audio.addEventListener('play', () => { clock.resync(); refreshControls(); });
audio.addEventListener('seeked', () => clock.resync());
audio.addEventListener('pause', refreshControls);

$('progress').addEventListener('pointerdown', (e) => {
    if (state.mode !== 'track') return;
    const seek = (ev) => {
        const r = $('progress').getBoundingClientRect();
        audio.currentTime = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * state.track.duration;
    };
    seek(e);
    const move = (ev) => seek(ev);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
});

window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    const keys = { ' ': togglePlay, ArrowLeft: () => seekBy(-5), ArrowRight: () => seekBy(5),
        ArrowUp: () => setVolume(audio.volume + 0.05), ArrowDown: () => setVolume(audio.volume - 0.05),
        l: toggleLoop, L: toggleLoop, s: stopAll, S: stopAll, f: toggleFullscreen, F: toggleFullscreen };
    const fn = keys[e.key];
    if (fn) {
        e.preventDefault();
        fn();
        wakeHud();
    }
});

// Drag & drop anywhere.
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

// HUD auto-hide: shows on any pointer movement, hides after 2.5s idle while active.
function wakeHud() { state.hudIdle = 0; }
window.addEventListener('pointermove', wakeHud);
window.addEventListener('pointerdown', wakeHud);
hud.addEventListener('pointerenter', () => { state.pointerInHud = true; });
hud.addEventListener('pointerleave', () => { state.pointerInHud = false; });

// ---------- render loop ----------

function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const fmt = (s) => {
    if (!Number.isFinite(s) || s <= 0) return '0:00';
    const t = Math.floor(s);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

function currentSeconds() {
    if (state.mode === 'track') return clock.now();
    return state.demoSeconds;
}

function computeSpectrum() {
    if (state.mode === 'track') {
        // Paused: feed silence so warp speed and shake settle instead of
        // re-triggering on the frozen frame.
        if (audio.paused) return emptyFrame();
        const t = state.track;
        return analyzer.analyze(t.channels, t.sampleRate, clock.now(), t.profile);
    }
    return analyzer.demoFrame(state.demoSeconds, state.demoActive);
}

function updateHud(spectrum, dt) {
    const active = isActive();
    if (!active || state.pointerInHud) state.hudIdle = 0;
    else state.hudIdle += dt;
    document.body.classList.toggle('hud-hidden', state.hudIdle >= 2.5);

    const accent = hsl(visualizer.hue, 0.82, 0.67);
    document.documentElement.style.setProperty('--accent', accent);

    let mode, modeColor = accent;
    if (state.mode === 'track') mode = audio.paused ? 'PAUSED' : 'PLAYING';
    else if (state.mode === 'pending') mode = 'LOADING';
    else mode = state.demoActive ? 'DEMO ACTIVE' : 'DEMO PAUSED';
    if (!active) modeColor = 'rgb(169,181,211)';
    $('mode').textContent = mode;
    document.documentElement.style.setProperty('--mode', modeColor);

    $('title').textContent = state.mode === 'track' ? state.track.name
        : (state.demoActive ? 'SonicStars procedural demo' : 'SonicStars procedural demo paused');

    const now = currentSeconds();
    const dur = state.mode === 'track' ? state.track.duration : 0;
    $('time').textContent = `${fmt(now)} / ${fmt(dur)}`;
    $('progress-fill').style.width = `${dur > 0 ? Math.min(1, now / dur) * 100 : 0}%`;

    $('m-avg').textContent = spectrum.average.toFixed(0);
    $('m-bass').textContent = spectrum.bass.toFixed(0);
    $('m-drive').textContent = `${(Math.min(1, Math.max(0, spectrum.profiled ? spectrum.songDrive : spectrum.intensity)) * 100).toFixed(0)}%`;
    $('m-speed').textContent = visualizer.speed.toFixed(1);
}

let lastLyric = '';
function updateLyrics(now) {
    const L = state.lyrics;
    const i = activeLyricIndex(L, now);
    const show = i >= 0 && !lyricShouldClear(L, i, now);
    const key = show ? `${i}` : '';
    if (key === lastLyric) return;
    lastLyric = key;
    $('lyric-prev').textContent = show && i > 0 ? L[i - 1].text : '';
    $('lyric-cur').textContent = show ? L[i].text : '';
    $('lyric-next').textContent = show && i + 1 < L.length ? L[i + 1].text : '';
}

let last = performance.now();
function frame(nowMs) {
    const dt = Math.min((nowMs - last) / 1000, 0.1);
    last = nowMs;
    if (state.mode !== 'track' && state.demoActive) state.demoSeconds += dt;

    const spectrum = computeSpectrum();
    const w = innerWidth, h = innerHeight;
    ctx.fillStyle = 'rgb(5,5,10)';
    ctx.fillRect(0, 0, w, h);
    visualizer.draw(ctx, w, h, spectrum, dt);
    updateHud(spectrum, dt);
    updateLyrics(currentSeconds());
    requestAnimationFrame(frame);
}

setStatus(state.status);
refreshControls();
requestAnimationFrame(frame);
