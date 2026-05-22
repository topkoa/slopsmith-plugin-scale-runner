// Scale Runner — Guitarcade-style 3D arcade mini-game plugin for Slopsmith.
//
// The user picks a scale + key + difficulty, then plays the next correct note
// in the scale to dodge each oncoming obstacle. Pitch detection is delegated
// to the `note_detect` plugin via `createNoteDetector({ highway, container })`
// with a custom in-memory highway shim, so we reuse all of note_detect's
// pitch/onset/timing logic without touching playSong / the WebSocket layer.

(function () {
    'use strict';

    // ── Three.js loader (pattern from highway_3d/screen.js:710-725) ───────
    const THREE_URL = '/static/vendor/three/three.module.min.js';
    const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';
    let T = null;
    let threeLoadPromise = null;
    function loadThree() {
        if (!threeLoadPromise) {
            threeLoadPromise = import(THREE_URL)
                .then(mod => { T = mod; return mod; })
                .catch(() => import(THREE_CDN)
                    .then(mod => { T = mod; return mod; })
                    .catch(e => {
                        console.error('[scale_runner] Three.js load failed:', e);
                        threeLoadPromise = null;
                        throw e;
                    }));
        }
        return threeLoadPromise;
    }

    // ── Scale theory ──────────────────────────────────────────────────────
    const INTERVALS = {
        minor_pent: [0, 3, 5, 7, 10],
        major_pent: [0, 2, 4, 7, 9],
    };
    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    // Standard tuning, slopsmith convention: string 0 = low E2, string 5 = high E4.
    const OPEN_MIDI = [40, 45, 50, 55, 59, 64];
    const DEGREE_LABELS = {
        minor_pent: { 0: '1', 3: 'b3', 5: '4', 7: '5', 10: 'b7' },
        major_pent: { 0: '1', 2: '2', 4: '3', 7: '5', 9: '6' },
    };

    // Root MIDI for each key, chosen in the low-E octave (E2..D#3 range)
    // so the first 2 octaves of any pentatonic land comfortably on the
    // fretboard's playable region.
    function rootMidiForKey(keyName) {
        const idx = NOTE_NAMES.indexOf(keyName);
        // C..D# map to C3..D#3 (48..51); E..B map to E2..B2 (40..47).
        return idx <= 3 ? (48 + idx) : (40 + idx);
    }

    function getScaleMidiSequence(rootMidi, intervalSet, octaves) {
        const out = [];
        for (let o = 0; o < octaves; o++) {
            for (const i of intervalSet) out.push(rootMidi + 12 * o + i);
        }
        return out;
    }

    // Prefer the highest string whose open note <= midi and resulting fret <= 12.
    // Tends to pick high-string low-fret voicings, easier at arcade pace.
    function midiToStringFret(midi) {
        for (let s = 5; s >= 0; s--) {
            const f = midi - OPEN_MIDI[s];
            if (f >= 0 && f <= 12) return { s, f };
        }
        return { s: 0, f: Math.max(0, midi - OPEN_MIDI[0]) };
    }

    function degreeNameFor(scaleKey, semis) {
        return DEGREE_LABELS[scaleKey][semis % 12] || '?';
    }

    // ── Difficulty tiers ──────────────────────────────────────────────────
    const DIFFICULTIES = {
        easy:   { cadence: 2.5, timingTol: 0.200, pitchTol: 60, lives: 5, label: 'Easy' },
        medium: { cadence: 2.0, timingTol: 0.150, pitchTol: 50, lives: 3, label: 'Medium' },
        hard:   { cadence: 1.5, timingTol: 0.100, pitchTol: 40, lives: 2, label: 'Hard' },
    };

    // ── World constants ───────────────────────────────────────────────────
    const V_FWD = 8;            // m/s — obstacle speed toward runner
    const SPAWN_Z = -20;        // obstacles spawn this far ahead of runner
    const HIT_Z = 0;            // runner sits at Z=0; obstacles trigger here
    const PASS_Z = 1.5;         // beyond this, the obstacle has visibly passed
    const PREROLL_S = 2.5;      // time from game start to first obstacle arrival
    const OCTAVES = 2;          // number of scale octaves per run (10 notes pent)

    // ── Persistence ───────────────────────────────────────────────────────
    const PREFS_KEY = 'scale_runner.prefs';
    const MIC_SEEN_KEY = 'scale_runner.micExplainerShown';
    function loadPrefs() {
        try {
            const raw = localStorage.getItem(PREFS_KEY);
            if (!raw) return null;
            const p = JSON.parse(raw);
            // Validate so a hand-edited or stale localStorage doesn't break boot.
            if (!INTERVALS[p.scale] || !NOTE_NAMES.includes(p.key) || !DIFFICULTIES[p.difficulty]) return null;
            return p;
        } catch (e) { return null; }
    }
    function savePrefs(p) {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {}
    }

    // ── Per-session state ─────────────────────────────────────────────────
    // All mutable state lives at module scope so teardown() can null it.
    let rootEl = null;          // #plugin-scale_runner
    let srRoot = null;          // #sr-root
    let canvasEl = null;
    let renderer = null;
    let scene = null;
    let camera = null;
    let runner = null;
    let ground = null;
    let labelTextureCache = new Map();
    let labelMaterialCache = new Map();
    let obstaclePool = [];      // recycled boxes
    let activeObstacles = [];   // currently in flight, in spawn order
    let coinPool = [];          // fading "coin" meshes after a hit
    let activeCoins = [];
    let geometriesToDispose = [];
    let materialsToDispose = [];
    let rafId = null;
    let lastFrameMs = 0;
    let gameClockSec = 0;
    let detector = null;
    let priorDefaultEnabled = false;
    let resizeObserver = null;
    let escListener = null;
    let backHandler = null;
    let screenChangedHandler = null;
    let wasOnScreen = false;

    let prefs = null;           // { scale, key, difficulty }
    let syntheticNotes = [];    // [{ s, f, t, sus: 0, ho: 0 }, ...]
    let obstacleMeta = [];      // parallel to syntheticNotes: { spawned, judged, midi, degree, spawnTime }
    let nextSpawnIdx = 0;
    let gameState = 'menu';     // 'menu' | 'playing' | 'paused' | 'gameover' | 'win'
    let stats = { score: 0, combo: 0, bestCombo: 0, hits: 0, misses: 0, lives: 0 };

    // ── DOM refs (set in bindUi) ──────────────────────────────────────────
    let panels = {};
    let hudEls = {};
    let pickerEls = {};

    // ── Highway shim ──────────────────────────────────────────────────────
    // Read-only surface that note_detect's detector reads from. Everything
    // it might call is stubbed with sane defaults; only the getters we
    // actually drive (getNotes, getTime, getSongInfo, getStringCount) carry
    // real state. Per [[note_detect/screen.js:1077-1144]] the detector
    // resolves these lazily and tolerates missing fields on songInfo.
    function makeHighwayShim() {
        return {
            getNotes: () => syntheticNotes,
            getChords: () => [],
            getChordTemplates: () => [],
            getSections: () => [],
            getBeats: () => [],
            getAnchors: () => [],
            getTime: () => gameClockSec,
            getAvOffset: () => 0,
            getSongInfo: () => ({
                arrangement: 'lead',
                arrangement_index: 0,
            }),
            getStringCount: () => 6,
            getLefty: () => false,
            getInverted: () => false,
            isDefaultRenderer: () => false,
            isVisible: () => gameState === 'playing',
            // No-op draw hooks — we don't render note_detect's 2D highway.
            fillTextUnmirrored: () => {},
            project: () => ({ x: 0, y: 0 }),
            fretX: () => 0,
            addDrawHook: () => {},
            removeDrawHook: () => {},
            fireDrawHooks: () => {},
            setNoteStateProvider: () => {},
            getNoteStateProvider: () => null,
            getNoteState: () => null,
        };
    }

    // ── Synthetic notes ───────────────────────────────────────────────────
    function buildSyntheticNotes(scaleKey, keyName, difficulty) {
        const intervals = INTERVALS[scaleKey];
        const root = rootMidiForKey(keyName);
        const midis = getScaleMidiSequence(root, intervals, OCTAVES);
        const cadence = DIFFICULTIES[difficulty].cadence;
        syntheticNotes = [];
        obstacleMeta = [];
        for (let i = 0; i < midis.length; i++) {
            const midi = midis[i];
            const sf = midiToStringFret(midi);
            const t = PREROLL_S + i * cadence;
            syntheticNotes.push({ s: sf.s, f: sf.f, t, sus: 0, ho: 0 });
            obstacleMeta.push({
                spawned: false,
                judged: null,     // 'hit' | 'miss' | null
                midi,
                semis: midi - root,
                degree: degreeNameFor(scaleKey, midi - root),
                spawnTime: t - PREROLL_S,
                arrivalTime: t,
                mesh: null,
                label: null,
            });
        }
        nextSpawnIdx = 0;
    }

    // ── 3D scene construction ─────────────────────────────────────────────
    function makeLabelTexture(text, color) {
        const key = `${text}|${color}`;
        if (labelTextureCache.has(key)) return labelTextureCache.get(key);
        const size = 256;
        const cv = document.createElement('canvas');
        cv.width = size; cv.height = size;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.fillRect(0, 0, size, size);
        ctx.font = 'bold 160px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Stroke for legibility against any backdrop
        ctx.lineWidth = 14;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(text, size / 2, size / 2);
        ctx.fillStyle = color;
        ctx.fillText(text, size / 2, size / 2);
        const tex = new T.CanvasTexture(cv);
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        labelTextureCache.set(key, tex);
        return tex;
    }

    function makeLabelMaterial(text, color) {
        const key = `${text}|${color}`;
        if (labelMaterialCache.has(key)) return labelMaterialCache.get(key);
        const tex = makeLabelTexture(text, color);
        const mat = new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
        labelMaterialCache.set(key, mat);
        return mat;
    }

    function makeCheckerTexture() {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 64;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#1a2a3a';
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = '#243a52';
        ctx.fillRect(0, 0, 32, 32);
        ctx.fillRect(32, 32, 32, 32);
        const tex = new T.CanvasTexture(cv);
        tex.wrapS = tex.wrapT = T.RepeatWrapping;
        tex.repeat.set(20, 100);
        tex.anisotropy = 4;
        return tex;
    }

    function buildScene() {
        scene = new T.Scene();
        scene.background = new T.Color(0x0a0e14);
        scene.fog = new T.Fog(0x0a0e14, 15, 50);

        camera = new T.PerspectiveCamera(60, 1, 0.1, 200);
        camera.position.set(0, 3, 8);
        camera.lookAt(0, 1.5, 0);

        const dir = new T.DirectionalLight(0xffffff, 1.0);
        dir.position.set(5, 10, 5);
        scene.add(dir);
        scene.add(new T.AmbientLight(0xffffff, 0.4));

        // Ground
        const groundGeo = new T.PlaneGeometry(20, 500);
        const groundTex = makeCheckerTexture();
        const groundMat = new T.MeshStandardMaterial({ map: groundTex, roughness: 0.95, metalness: 0.05 });
        ground = new T.Mesh(groundGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.z = -240;
        scene.add(ground);
        geometriesToDispose.push(groundGeo);
        materialsToDispose.push(groundMat);

        // Runner — simple capsule, no animation rig
        const runnerGeo = new T.CapsuleGeometry(0.4, 1.2, 6, 12);
        const runnerMat = new T.MeshStandardMaterial({ color: 0x44a0ff, emissive: 0x102a44, roughness: 0.5 });
        runner = new T.Mesh(runnerGeo, runnerMat);
        runner.position.set(0, 1, 0);
        scene.add(runner);
        geometriesToDispose.push(runnerGeo);
        materialsToDispose.push(runnerMat);
    }

    function makeObstacle() {
        if (obstaclePool.length) return obstaclePool.pop();
        const geo = new T.BoxGeometry(0.9, 1.2, 0.9);
        const mat = new T.MeshStandardMaterial({ color: 0xa04040, emissive: 0x401010, roughness: 0.6 });
        const mesh = new T.Mesh(geo, mat);
        const sprite = new T.Sprite();
        sprite.scale.set(1.2, 1.2, 1);
        sprite.position.set(0, 1.2, 0);
        mesh.add(sprite);
        mesh.userData.sprite = sprite;
        // Track for disposal — pooled allocations created lazily over the run.
        geometriesToDispose.push(geo);
        materialsToDispose.push(mat);
        return mesh;
    }

    function recycleObstacle(mesh) {
        if (mesh.parent) mesh.parent.remove(mesh);
        // The sprite material is cached; don't dispose it here.
        if (mesh.userData.sprite) mesh.userData.sprite.material = null;
        obstaclePool.push(mesh);
    }

    function makeCoin(at) {
        let coin;
        if (coinPool.length) {
            coin = coinPool.pop();
        } else {
            const geo = new T.CylinderGeometry(0.4, 0.4, 0.08, 24);
            const mat = new T.MeshStandardMaterial({ color: 0xe8c040, emissive: 0x6a5210, roughness: 0.3, metalness: 0.6, transparent: true, opacity: 1 });
            coin = new T.Mesh(geo, mat);
            geometriesToDispose.push(geo);
            materialsToDispose.push(mat);
        }
        coin.position.copy(at);
        coin.rotation.set(Math.PI / 2, 0, 0);
        coin.material.opacity = 1;
        coin.userData.life = 0.8;     // seconds until removal
        scene.add(coin);
        activeCoins.push(coin);
        return coin;
    }

    // ── Rendering / loop ──────────────────────────────────────────────────
    function applySize() {
        const w = srRoot.clientWidth || window.innerWidth;
        const h = srRoot.clientHeight || window.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    function spawnPending() {
        while (nextSpawnIdx < syntheticNotes.length) {
            const meta = obstacleMeta[nextSpawnIdx];
            if (gameClockSec < meta.spawnTime) break;
            const mesh = makeObstacle();
            mesh.position.set(0, 0.6, SPAWN_Z);
            const isRoot = meta.degree === '1';
            const labelColor = isRoot ? '#e8c040' : '#ffffff';
            const sprite = mesh.userData.sprite;
            sprite.material = makeLabelMaterial(meta.degree, labelColor);
            meta.mesh = mesh;
            meta.label = sprite;
            meta.spawned = true;
            scene.add(mesh);
            activeObstacles.push(meta);
            nextSpawnIdx++;
        }
    }

    function advanceObstacles(dt) {
        const remaining = [];
        for (const meta of activeObstacles) {
            const mesh = meta.mesh;
            if (!mesh) continue;
            mesh.position.z += V_FWD * dt;
            // Visual fade once judged
            if (meta.judged) {
                mesh.material.opacity = Math.max(0, (mesh.material.opacity ?? 1) - dt * 4);
                mesh.material.transparent = true;
            }
            // Despawn once well past the runner OR fully faded.
            if (mesh.position.z > PASS_Z + 4 || (meta.judged && mesh.material.opacity <= 0)) {
                mesh.material.opacity = 1;
                mesh.material.transparent = false;
                recycleObstacle(mesh);
                meta.mesh = null;
                meta.label = null;
                continue;
            }
            remaining.push(meta);
        }
        activeObstacles = remaining;
    }

    function advanceCoins(dt) {
        const remaining = [];
        for (const coin of activeCoins) {
            coin.userData.life -= dt;
            coin.position.y += dt * 2.0;
            coin.rotation.z += dt * 8;
            coin.material.opacity = Math.max(0, coin.userData.life / 0.8);
            if (coin.userData.life <= 0) {
                if (coin.parent) coin.parent.remove(coin);
                coinPool.push(coin);
                continue;
            }
            remaining.push(coin);
        }
        activeCoins = remaining;
    }

    function bobRunner(t) {
        if (!runner) return;
        runner.position.y = 1 + 0.08 * Math.sin(t * 8);
    }

    function scrollGround() {
        // The ground itself is fixed; the tiled texture animates by
        // adjusting offset so we get an infinite-scroll illusion without
        // ever moving the mesh.
        if (!ground || !ground.material.map) return;
        ground.material.map.offset.y = -gameClockSec * (V_FWD / 5);
    }

    function frame(nowMs) {
        rafId = requestAnimationFrame(frame);
        if (gameState !== 'playing') return;
        const dt = Math.min(0.05, (nowMs - lastFrameMs) / 1000 || 0);
        lastFrameMs = nowMs;
        gameClockSec += dt;
        spawnPending();
        advanceObstacles(dt);
        advanceCoins(dt);
        bobRunner(gameClockSec);
        scrollGround();
        updateTargetDegree();
        renderer.render(scene, camera);

        // Win check: every obstacle spawned + every obstacle judged + none active.
        if (gameState === 'playing'
            && nextSpawnIdx >= syntheticNotes.length
            && activeObstacles.length === 0
            && obstacleMeta.every(m => m.judged)) {
            showWin();
        }
    }

    function updateTargetDegree() {
        const next = obstacleMeta.find(m => !m.judged);
        if (!next) {
            hudEls.target.textContent = '—';
            return;
        }
        hudEls.target.textContent = next.degree;
    }

    // ── Note detection wiring ─────────────────────────────────────────────
    function findObstacleForJudgment(detail) {
        // The detail.note carries the (s, f) of the matched chart note;
        // detail.noteTime carries the chart-time `t`. We key by `t` because
        // (s, f) can repeat across octaves but `t` is unique per syntheticNote.
        const t = detail.noteTime;
        if (!Number.isFinite(t)) return null;
        // Find by exact t (we built syntheticNotes deterministically; floats
        // pass through note_detect unchanged so equality is safe).
        return obstacleMeta.find(m => !m.judged && Math.abs(m.arrivalTime - t) < 1e-3) || null;
    }

    function onHit(e) {
        if (gameState !== 'playing') return;
        const d = e.detail;
        const meta = findObstacleForJudgment(d);
        if (!meta) return;
        meta.judged = 'hit';
        stats.combo++;
        stats.hits++;
        if (stats.combo > stats.bestCombo) stats.bestCombo = stats.combo;
        stats.score += 100 * stats.combo;
        if (meta.mesh) {
            makeCoin(meta.mesh.position.clone());
            // Trigger the visual fade in advanceObstacles by marking judged.
        }
        flash('#3fbf6f');
        updateHud();
    }

    function onMiss(e) {
        if (gameState !== 'playing') return;
        const d = e.detail;
        const meta = findObstacleForJudgment(d);
        if (!meta) return;
        meta.judged = 'miss';
        stats.combo = 0;
        stats.misses++;
        stats.lives--;
        if (meta.mesh) {
            meta.mesh.material.color.setHex(0x802020);
        }
        flash('#bf3f3f');
        updateHud();
        if (stats.lives <= 0) {
            showGameOver();
        }
    }

    // ── HUD ───────────────────────────────────────────────────────────────
    function renderHearts(n) {
        return '♥'.repeat(Math.max(0, n));
    }

    function updateHud() {
        hudEls.lives.textContent = renderHearts(stats.lives);
        hudEls.score.textContent = String(stats.score);
        hudEls.combo.textContent = '×' + stats.combo;
    }

    let flashTimeout = null;
    function flash(color) {
        const el = hudEls.flash;
        if (!el) return;
        el.style.background = color;
        el.style.opacity = '0.35';
        if (flashTimeout) clearTimeout(flashTimeout);
        flashTimeout = setTimeout(() => { el.style.opacity = '0'; }, 120);
    }

    function setState(name) {
        for (const k of Object.keys(panels)) {
            if (!panels[k]) continue;
            if (k === name) panels[k].classList.remove('hidden');
            else panels[k].classList.add('hidden');
        }
        // The HUD is special: visible only during 'playing' and 'paused'.
        if (panels.hud) {
            if (name === 'playing' || name === 'paused') panels.hud.classList.remove('hidden');
            else panels.hud.classList.add('hidden');
        }
        // Back button hidden during play to avoid accidental quits.
        const back = srRoot.querySelector('#sr-back');
        if (back) {
            if (name === 'playing' || name === 'paused') back.classList.add('hidden');
            else back.classList.remove('hidden');
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────
    async function onStart() {
        const seenMic = !!localStorage.getItem(MIC_SEEN_KEY);
        if (!seenMic) {
            setState('mic');
            return;
        }
        await beginGame();
    }

    async function beginGame() {
        // Build synthetic notes from current prefs.
        buildSyntheticNotes(prefs.scale, prefs.key, prefs.difficulty);

        // Reset run stats.
        const diff = DIFFICULTIES[prefs.difficulty];
        stats = { score: 0, combo: 0, bestCombo: 0, hits: 0, misses: 0, lives: diff.lives };
        gameClockSec = 0;
        lastFrameMs = performance.now();
        hudEls.scaleKey.textContent = `${prefs.key} ${prefs.scale === 'minor_pent' ? 'minor pent' : 'major pent'} · ${diff.label}`;
        updateHud();

        // Disable default note_detect singleton so we don't double-claim the mic.
        const nd = window.noteDetect;
        priorDefaultEnabled = !!(nd && typeof nd.isEnabled === 'function' && nd.isEnabled());
        if (priorDefaultEnabled && typeof nd.disable === 'function') {
            try { nd.disable(); } catch (e) { console.warn('[scale_runner] failed to disable default note_detect:', e); }
        }

        // Three.js scene.
        try {
            await loadThree();
        } catch (e) {
            alert('Scale Runner: failed to load Three.js. ' + e.message);
            setState('start');
            return;
        }
        if (!renderer) {
            renderer = new T.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: false });
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            buildScene();
            applySize();
            if (window.ResizeObserver) {
                resizeObserver = new ResizeObserver(applySize);
                resizeObserver.observe(srRoot);
            }
        }

        // Detector — instance-scoped, mic-owning, listens on srRoot.
        if (typeof window.createNoteDetector !== 'function') {
            alert('Scale Runner needs the note_detect plugin to be installed and loaded.');
            setState('start');
            return;
        }
        if (!detector) {
            const shim = makeHighwayShim();
            detector = window.createNoteDetector({ highway: shim, container: srRoot });
            // Difficulty's `timingTol`/`pitchTol` are advisory for MVP:
            // note_detect's per-instance thresholds live in closure-scope
            // `let` vars without setters on the returned API
            // (note_detect/screen.js:1193). All tiers use the default
            // ±150 ms / ±50 cents window; difficulty differentiates via
            // cadence + lives only.
            srRoot.addEventListener('notedetect:hit',  onHit);
            srRoot.addEventListener('notedetect:miss', onMiss);
        }
        try {
            await detector.enable();
        } catch (e) {
            alert('Microphone permission is required to play. ' + (e?.message || ''));
            setState('start');
            return;
        }

        gameState = 'playing';
        setState('playing');
        if (!rafId) {
            lastFrameMs = performance.now();
            rafId = requestAnimationFrame(frame);
        }
    }

    function pause() {
        if (gameState !== 'playing') return;
        gameState = 'paused';
        setState('paused');
        if (detector && typeof detector.disable === 'function') {
            try { detector.disable(); } catch (e) {}
        }
    }

    async function resume() {
        if (gameState !== 'paused') return;
        if (detector && typeof detector.enable === 'function') {
            try { await detector.enable(); } catch (e) {}
        }
        lastFrameMs = performance.now();   // avoid huge dt on first frame
        gameState = 'playing';
        setState('playing');
    }

    function retry() {
        // Clear scene state without disposing the renderer/camera/lighting.
        clearActiveMeshes();
        // Rebuild notes/stats and restart loop.
        beginGame();
    }

    function quitToMenu() {
        clearActiveMeshes();
        if (detector && typeof detector.disable === 'function') {
            try { detector.disable(); } catch (e) {}
        }
        gameState = 'menu';
        setState('start');
        restoreDefaultNoteDetect();
    }

    function showGameOver() {
        gameState = 'gameover';
        const go = panels.gameover;
        if (go) {
            go.querySelector('#sr-go-score').textContent = String(stats.score);
            go.querySelector('#sr-go-hits').textContent = String(stats.hits);
            go.querySelector('#sr-go-misses').textContent = String(stats.misses);
            go.querySelector('#sr-go-best').textContent = String(stats.bestCombo);
        }
        if (detector && typeof detector.disable === 'function') {
            try { detector.disable(); } catch (e) {}
        }
        setState('gameover');
    }

    function showWin() {
        gameState = 'win';
        const w = panels.win;
        if (w) {
            w.querySelector('#sr-win-score').textContent = String(stats.score);
            w.querySelector('#sr-win-hits').textContent = String(stats.hits);
            w.querySelector('#sr-win-misses').textContent = String(stats.misses);
            const total = stats.hits + stats.misses;
            const acc = total > 0 ? Math.round((stats.hits / total) * 100) : 0;
            w.querySelector('#sr-win-acc').textContent = acc + '%';
        }
        if (detector && typeof detector.disable === 'function') {
            try { detector.disable(); } catch (e) {}
        }
        setState('win');
    }

    function clearActiveMeshes() {
        for (const meta of activeObstacles) {
            if (meta.mesh) {
                if (meta.mesh.material) {
                    meta.mesh.material.opacity = 1;
                    meta.mesh.material.transparent = false;
                    meta.mesh.material.color.setHex(0xa04040);
                }
                recycleObstacle(meta.mesh);
                meta.mesh = null;
            }
        }
        activeObstacles = [];
        for (const coin of activeCoins) {
            if (coin.parent) coin.parent.remove(coin);
            coinPool.push(coin);
        }
        activeCoins = [];
    }

    function restoreDefaultNoteDetect() {
        const nd = window.noteDetect;
        if (priorDefaultEnabled && nd && typeof nd.enable === 'function') {
            // enable() is async; fire-and-forget — we don't gate UI on it.
            Promise.resolve(nd.enable()).catch(() => {});
        }
        priorDefaultEnabled = false;
    }

    function teardown() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        if (resizeObserver) { try { resizeObserver.disconnect(); } catch (e) {} resizeObserver = null; }
        // Listeners on srRoot — safe to remove even if never attached.
        srRoot.removeEventListener('notedetect:hit',  onHit);
        srRoot.removeEventListener('notedetect:miss', onMiss);
        if (detector) {
            try { detector.destroy(); } catch (e) {}
            detector = null;
        }
        restoreDefaultNoteDetect();
        // Pooled meshes share geometries/materials, so dispose only once each.
        for (const g of geometriesToDispose) { try { g.dispose(); } catch (e) {} }
        for (const m of materialsToDispose) { try { m.dispose(); } catch (e) {} }
        geometriesToDispose = [];
        materialsToDispose = [];
        for (const tex of labelTextureCache.values()) { try { tex.dispose(); } catch (e) {} }
        for (const mat of labelMaterialCache.values()) { try { mat.dispose(); } catch (e) {} }
        labelTextureCache.clear();
        labelMaterialCache.clear();
        if (renderer) { try { renderer.dispose(); } catch (e) {} renderer = null; }
        scene = null;
        camera = null;
        runner = null;
        ground = null;
        obstaclePool = [];
        activeObstacles = [];
        coinPool = [];
        activeCoins = [];
        gameClockSec = 0;
        nextSpawnIdx = 0;
        syntheticNotes = [];
        obstacleMeta = [];
        gameState = 'menu';
    }

    // ── UI binding ────────────────────────────────────────────────────────
    function bindUi() {
        srRoot = document.getElementById('sr-root');
        if (!srRoot) return false;
        canvasEl = srRoot.querySelector('#sr-canvas');

        panels = {
            mic:      srRoot.querySelector('#sr-mic-explainer'),
            start:    srRoot.querySelector('#sr-start'),
            hud:      srRoot.querySelector('#sr-hud'),
            paused:   srRoot.querySelector('#sr-pause'),
            gameover: srRoot.querySelector('#sr-gameover'),
            win:      srRoot.querySelector('#sr-win'),
        };
        hudEls = {
            lives:    srRoot.querySelector('#sr-lives'),
            score:    srRoot.querySelector('#sr-score'),
            combo:    srRoot.querySelector('#sr-combo'),
            target:   srRoot.querySelector('#sr-target'),
            scaleKey: srRoot.querySelector('#sr-scale-key'),
            flash:    srRoot.querySelector('#sr-flash'),
        };

        // Key picker — build 12 buttons.
        const kp = srRoot.querySelector('#sr-key-picker');
        kp.innerHTML = '';
        for (const k of NOTE_NAMES) {
            const b = document.createElement('button');
            b.dataset.key = k;
            b.className = 'sr-key-btn px-3 py-2 rounded-lg text-sm border transition';
            b.textContent = k;
            b.addEventListener('click', () => { prefs.key = k; refreshPickers(); persistPrefs(); });
            kp.appendChild(b);
        }
        pickerEls.keyBtns = Array.from(kp.querySelectorAll('button'));

        pickerEls.scaleBtns = Array.from(srRoot.querySelectorAll('.sr-scale-btn'));
        for (const b of pickerEls.scaleBtns) {
            b.addEventListener('click', () => { prefs.scale = b.dataset.scale; refreshPickers(); persistPrefs(); });
        }
        pickerEls.diffBtns = Array.from(srRoot.querySelectorAll('.sr-diff-btn'));
        for (const b of pickerEls.diffBtns) {
            b.addEventListener('click', () => { prefs.difficulty = b.dataset.diff; refreshPickers(); persistPrefs(); });
        }

        srRoot.querySelector('#sr-start-btn').addEventListener('click', onStart);
        srRoot.querySelector('#sr-mic-continue').addEventListener('click', () => {
            try { localStorage.setItem(MIC_SEEN_KEY, '1'); } catch (e) {}
            beginGame();
        });
        srRoot.querySelector('#sr-resume-btn').addEventListener('click', resume);
        srRoot.querySelector('#sr-quit-btn').addEventListener('click', quitToMenu);
        srRoot.querySelector('#sr-retry-btn').addEventListener('click', retry);
        srRoot.querySelector('#sr-menu-btn').addEventListener('click', quitToMenu);
        srRoot.querySelector('#sr-again-btn').addEventListener('click', retry);
        srRoot.querySelector('#sr-harder-btn').addEventListener('click', () => {
            // Bump difficulty one notch if possible, otherwise replay.
            const order = ['easy', 'medium', 'hard'];
            const i = order.indexOf(prefs.difficulty);
            prefs.difficulty = order[Math.min(order.length - 1, i + 1)];
            persistPrefs();
            refreshPickers();
            retry();
        });
        backHandler = (e) => {
            // Back to home — let the host's showScreen handler take over.
            if (typeof window.showScreen === 'function') window.showScreen('home');
        };
        srRoot.querySelector('#sr-back').addEventListener('click', backHandler);

        // Escape to pause / resume.
        escListener = (e) => {
            if (e.key !== 'Escape') return;
            if (gameState === 'playing') { e.preventDefault(); pause(); }
            else if (gameState === 'paused') { e.preventDefault(); resume(); }
        };
        document.addEventListener('keydown', escListener);

        refreshPickers();
        return true;
    }

    function refreshPickers() {
        const baseBtn = 'border-gray-700 bg-dark-800 text-gray-400 hover:text-white';
        const activeBtn = 'border-accent bg-accent/20 text-white';
        for (const b of pickerEls.scaleBtns) {
            b.className = `sr-scale-btn flex-1 px-4 py-2 rounded-xl text-sm border transition ${b.dataset.scale === prefs.scale ? activeBtn : baseBtn}`;
        }
        for (const b of pickerEls.keyBtns) {
            b.className = `sr-key-btn px-3 py-2 rounded-lg text-sm border transition ${b.dataset.key === prefs.key ? activeBtn : baseBtn}`;
        }
        for (const b of pickerEls.diffBtns) {
            b.className = `sr-diff-btn flex-1 px-4 py-2 rounded-xl text-sm border transition ${b.dataset.diff === prefs.difficulty ? activeBtn : baseBtn}`;
        }
    }

    function persistPrefs() {
        savePrefs(prefs);
    }

    // ── Boot ──────────────────────────────────────────────────────────────
    function init() {
        rootEl = document.getElementById('plugin-scale_runner');
        if (!rootEl || !rootEl.querySelector('#sr-root')) {
            // Screen DOM not yet injected — slopsmith does this async per
            // [[app.js:5854-5866]]. Try again on the next frame.
            window.requestAnimationFrame(init);
            return;
        }

        prefs = loadPrefs() || { scale: 'minor_pent', key: 'A', difficulty: 'medium' };

        if (!bindUi()) return;

        // Hide all panels except start by default.
        setState('start');

        // React to navigation away — teardown to free the GPU + mic.
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            screenChangedHandler = (e) => {
                const id = e?.detail?.id;
                const nowActive = id === 'plugin-scale_runner';
                if (wasOnScreen && !nowActive) {
                    // Navigated away.
                    if (gameState === 'playing' || gameState === 'paused') {
                        teardown();
                    } else {
                        restoreDefaultNoteDetect();
                    }
                }
                wasOnScreen = nowActive;
            };
            window.slopsmith.on('screen:changed', screenChangedHandler);
            // Seed wasOnScreen against current screen if we can sniff it.
            wasOnScreen = rootEl.classList.contains('active');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
