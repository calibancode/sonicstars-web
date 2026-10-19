const stampPattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(text) {
    const result = [];
    for (const line of text.split(/\r?\n/)) {
        const stamps = [];
        for (const m of line.matchAll(stampPattern)) {
            let ms = 0;
            if (m[3] !== undefined) {
                ms = parseInt(m[3].padEnd(3, '0').slice(0, 3), 10);
            }
            stamps.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + ms / 1000);
        }
        const lyric = line.replace(stampPattern, '').trim();
        if (!lyric || stamps.length === 0) continue;
        for (const stamp of stamps) result.push({ timeSeconds: stamp, text: lyric });
    }
    result.sort((a, b) => a.timeSeconds - b.timeSeconds);
    return result;
}

export function activeLyricIndex(lyrics, t) {
    for (let i = 0; i < lyrics.length; ++i) {
        const next = i + 1 < lyrics.length ? lyrics[i + 1].timeSeconds : 1e9;
        if (t >= lyrics[i].timeSeconds && t < next) return i;
    }
    return -1;
}

export function lyricShouldClear(lyrics, i, t) {
    if (i < 0 || i >= lyrics.length) return false;
    const next = i + 1 < lyrics.length ? lyrics[i + 1].timeSeconds : 1e9;
    return next - lyrics[i].timeSeconds > 10 && t - lyrics[i].timeSeconds > 8;
}
