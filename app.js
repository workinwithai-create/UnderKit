// UnderKit: sing, hum or play a melody, get the chords that go under it. Real samples only (FluidR3 GM pinned + CC0 Virtuosity kit).
// Engine follows AUDIO-ENGINE-RULES: audio-clock lookahead scheduler, live changes on the next step, user BPM/key first,
// exact-length 48 kHz / 24-bit exports with the downbeat at sample 0, MIDI with one track per part.
"use strict";
const APP = "underkit", BRAND = "UnderKit";
const SR = 48000, STEPS = 16, TAIL_S = 3, FAST_RELEASE = 0.01, MAX_SHIFT = 4;
const LOOKAHEAD_MS = 25;      // how often the scheduler wakes
const SCHEDULE_AHEAD = 0.12;  // seconds of audio scheduled in advance
const SF_SHA = "044fab8e1456bfafc5776e86dfd6bb8697149aef"; // pinned commit, never a branch
const SF = `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@${SF_SHA}/FluidR3_GM`;
const SF_MIRROR = `https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/${SF_SHA}/FluidR3_GM`; // same commit, used if jsDelivr refuses a file
const KIT_DIR = "samples/drums";
const NAMES = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
const pc = x => ((x % 12) + 12) % 12;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const loadJSON = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };

// ---------- instruments: every voice is the FluidR3 GM sample it is named after ----------
const INST = {
  piano:   { label: "Piano (FluidR3 acoustic grand)", dir: "acoustic_grand_piano", gm: 0, lo: 36, hi: 88, gain: 0.9 },
  epiano:  { label: "Electric piano (FluidR3 EP 1)", dir: "electric_piano_1", gm: 4, lo: 36, hi: 84, gain: 1.0 },
  finger:  { label: "Finger bass (FluidR3 electric bass)", dir: "electric_bass_finger", gm: 33, lo: 28, hi: 56, gain: 1.15 },
  strings: { label: "String ensemble (FluidR3)", dir: "string_ensemble_1", gm: 48, lo: 40, hi: 84, gain: 0.6, sus: true },
  nylon:   { label: "Nylon guitar (FluidR3)", dir: "acoustic_guitar_nylon", gm: 24, lo: 40, hi: 76, gain: 1.0 },
  flute:   { label: "Flute (FluidR3)", dir: "flute", gm: 73, lo: 60, hi: 92, gain: 0.7, sus: true },
  clarinet:{ label: "Clarinet (FluidR3)", dir: "clarinet", gm: 71, lo: 52, hi: 88, gain: 0.7, sus: true }
};
const MEL_INSTS = ["flute", "clarinet", "piano", "epiano", "nylon", "strings"];
const LIVE_INSTS = ["piano", "epiano", "flute", "clarinet", "nylon", "strings", "finger"];
// Acoustic kit: Virtuosity Drums (CC0), hosted in this repo (public/samples/drums). The click is the real cross-stick sample.
const KIT = {
  kick:  { gm: 36, file: "kick",  label: "Acoustic kit: kick (Virtuosity Drums)", gain: 1.0 },
  snare: { gm: 38, file: "snare", label: "Acoustic kit: snare (Virtuosity Drums)", gain: 0.8 },
  ghost: { gm: 40, file: "ghost", label: "Acoustic kit: soft snare (Virtuosity Drums)", gain: 0.45 },
  rim:   { gm: 37, file: "rim",   label: "Acoustic kit: cross-stick rim click (Virtuosity Drums)", gain: 0.6 },
  hat:   { gm: 42, file: "hat",   label: "Acoustic kit: closed hi-hat (Virtuosity Drums)", gain: 0.45 },
  ohat:  { gm: 46, file: "ohat",  label: "Acoustic kit: open hi-hat (Virtuosity Drums)", gain: 0.35 }
};
const KIT_BY_GM = Object.fromEntries(Object.entries(KIT).map(([k, v]) => [v.gm, k]));
const D = Object.fromEntries(Object.entries(KIT).map(([k, v]) => [k, v.gm]));
const noteName = n => NAMES[pc(n)] + (Math.floor(n / 12) - 1);
function sampleList(){ const out = [];
  for (const [inst, d] of Object.entries(INST)) { const ns = []; for (let n = d.lo; n < d.hi + 2; n += 4) ns.push(n); if (ns[ns.length - 1] < d.hi - 2) ns.push(d.hi);
    for (const n of ns) out.push({ inst, id: inst + ":" + n, midi: n, url: `${SF}/${d.dir}-mp3/${noteName(n)}.mp3`, alt: `${SF_MIRROR}/${d.dir}-mp3/${noteName(n)}.mp3`, label: d.label }); }
  for (const [k, v] of Object.entries(KIT)) out.push({ inst: "kit", id: "kit:" + k, piece: k, url: `${KIT_DIR}/${v.file}.flac`, label: v.label });
  return out; }
const SAMPLES = sampleList();
const BY_INST = {}; for (const s of SAMPLES) if (s.inst !== "kit") (BY_INST[s.inst] = BY_INST[s.inst] || []).push(s);
function fold(n, lo, hi){ while (n < lo) n += 12; while (n > hi) n -= 12; return n; }
function nearestSample(inst, midi){ const d = INST[inst], list = BY_INST[inst]; const n = fold(midi, d.lo - 2, d.hi + 2); let best = null;
  for (const s of list) { const sh = n - s.midi; if (!best || Math.abs(sh) < Math.abs(best.shift)) best = { id: s.id, shift: sh, n }; } return best; }

// ---------- theory ----------
const QUAL = { "": [0,4,7], M: [0,4,7], m: [0,3,7], min: [0,3,7], "7": [0,4,7,10], m7: [0,3,7,10], maj7: [0,4,7,11], m7b5: [0,3,6,10], dim: [0,3,6], dim7: [0,3,6,9],
  aug: [0,4,8], sus2: [0,2,7], sus4: [0,5,7], sus: [0,5,7], "7sus4": [0,5,7,10], "6": [0,4,7,9], m6: [0,3,7,9], add9: [0,4,7,14], "9": [0,4,7,10,14], m9: [0,3,7,10,14], maj9: [0,4,7,11,14] };
const ROOTS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJ = [0,2,4,5,7,9,11], MIN = [0,2,3,5,7,8,10];
function mk(root, q){ q = q || ""; return { root: pc(root), q, ivs: QUAL[q] || QUAL[""] }; }
function parseChord(s){
  const m = /^([A-G])(#|b)?(maj9|maj7|m7b5|7sus4|min|m9|m7|m6|dim7|dim|aug|sus2|sus4|sus|add9|9|7|6|m|M)?(?:\/([A-G])(#|b)?)?$/.exec(String(s).trim()); if (!m) return null;
  const c = mk(ROOTS[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0), m[3] || ""); if (m[4]) c.bass = pc(ROOTS[m[4]] + (m[5] === "#" ? 1 : m[5] === "b" ? -1 : 0)); return c; }
const NAMES_S = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
// chord roots are spelled for the song key: sharps in G, D, A, E, B, F# major (and their relative minors), flats elsewhere
const sharpKey = () => typeof state !== "undefined" && (state.mode === "minor" ? [4, 11, 6, 1, 8] : [7, 2, 9, 4, 11, 6]).includes(state.keyRoot);
function chName(c){ const N = sharpKey() ? NAMES_S : NAMES; return N[c.root] + (c.q === "M" ? "" : c.q === "min" ? "m" : c.q) + (c.bass != null ? "/" + N[c.bass] : ""); }
function trC(c, k){ const o = mk(c.root + k, c.q); if (c.bass != null) o.bass = pc(c.bass + k); return o; }
function chordPcs(c){ return [...new Set(c.ivs.map(i => pc(c.root + i)))]; }
function voicing(c, lo, hi, prev, n){ const pcs = chordPcs(c).slice(0, n || 4), cands = [];
  for (let k = 0; k < pcs.length; k++) { let x = lo; while (pc(x) !== pcs[k]) x++; const v = [x];
    for (let j = 1; j < pcs.length; j++) { let y = v[v.length - 1] + 1; while (pc(y) !== pcs[(k + j) % pcs.length]) y++; v.push(y); }
    for (let o = 0; o <= 12; o += 12) if (v[v.length - 1] + o <= hi) cands.push(v.map(z => z + o)); }
  if (!cands.length) return [fold(c.root + 48, lo, hi)];
  const mid = (lo + hi) / 2, mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const score = v => prev && prev.length ? v.reduce((s, x, i) => s + Math.abs(x - prev[Math.min(i, prev.length - 1)]), 0) : Math.abs(mean(v) - mid);
  return cands.sort((a, b) => score(a) - score(b))[0]; }
const bassOf = (c, lo, hi) => fold((c.bass != null ? c.bass : c.root), lo, hi);
const keyLabel = st => NAMES[st.keyRoot] + (st.mode === "minor" ? "m" : "");
const keyLong = st => NAMES[st.keyRoot] + (st.mode === "minor" ? " minor" : " major");
const NUMERAL = ["I","bII","II","bIII","III","IV","#IV","V","bVI","VI","bVII","VII"];
const NASH = ["1","b2","2","b3","3","4","#4","5","b6","6","b7","7"];
const isMinorQ = q => /^m(?!aj)/.test(q) || q === "min";
function roman(c, st){ const d = pc(c.root - st.keyRoot), q = c.q || ""; let r = NUMERAL[d];
  if (isMinorQ(q) || q === "dim" || q === "dim7") r = r.toLowerCase();
  const suf = q === "dim" ? "°" : q === "dim7" ? "°7" : q === "m7b5" ? "ø7" : q === "m" || q === "min" || q === "M" || q === "" ? "" : q.replace(/^m(?!aj)/, "");
  return r + suf; }
function nashville(c, st){ const d = pc(c.root - st.keyRoot), q = c.q || ""; return NASH[d] + (isMinorQ(q) ? "m" + q.replace(/^m/, "") : q === "M" ? "" : q); }

// ---------- state (persisted in localStorage; recorded voice audio in IndexedDB) ----------
const RECIPES = {
  ballad: { name: "Ballad", bpm: 68, note: "piano halves, held strings, root bass, soft kick + rim", keys: "piano" },
  pop:    { name: "Pop", bpm: 92, note: "piano eighths, soft strings, eighth-note bass, backbeat drums", keys: "piano" },
  folk:   { name: "Folk", bpm: 100, note: "nylon guitar picking, root-fifth bass, light kit", keys: "nylon" },
  sparse: { name: "Sparse", bpm: 80, note: "piano whole notes + bass only (quiet for singing)", keys: "piano" } };
const STYLES = {
  simple: { name: "Simple", note: "three-chord honest: I, IV, V and vi" },
  pop:    { name: "Pop", note: "the four-chord family with sus colour" },
  moody:  { name: "Moody", note: "borrowed chords: bVI, bVII, iv" },
  color:  { name: "Color", note: "sevenths and secondary dominants" } };
const CHAIRS = [
  { id: "drums", name: "Drums (acoustic kit)", ch: 9, band: true }, { id: "bass", name: "Bass (finger)", ch: 1, band: true }, { id: "keys", name: "Chords (keys)", ch: 0, band: true },
  { id: "pad", name: "Pad (strings)", ch: 2, band: true }, { id: "melody", name: "Melody", ch: 3, band: false }, { id: "voice", name: "Your recorded voice", ch: 4, band: false, audio: true },
  { id: "click", name: "Click (cross-stick sample)", ch: 9, band: false, live: true } ];
const CHAIR = Object.fromEntries(CHAIRS.map(c => [c.id, c]));
// Public-domain demo melody: Beethoven, "Ode to Joy" (8 bars, C major). Steps are 16ths.
const ODE = [[64,0,4],[64,4,4],[65,8,4],[67,12,4],[67,16,4],[65,20,4],[64,24,4],[62,28,4],[60,32,4],[60,36,4],[62,40,4],[64,44,4],[64,48,6],[62,54,2],[62,56,8],
  [64,64,4],[64,68,4],[65,72,4],[67,76,4],[67,80,4],[65,84,4],[64,88,4],[62,92,4],[60,96,4],[60,100,4],[62,104,4],[64,108,4],[62,112,6],[60,118,2],[60,120,8]];
const demoTake = () => ({ id: "demo", name: "Demo: Ode to Joy (public domain)", src: "demo", key: 0, bpm: 92, bars: 8, notes: ODE.map(([n, s, d]) => ({ n: n + 12, s, d, v: 0.8 })), audio: false });
const DEFAULT = { bpm: 92, keyRoot: 0, mode: "major", bars: 8, recipe: "pop", style: "pop", rhythm: 1, variation: 0, locks: {},
  melInst: "flute", melSrc: "inst", liveInst: "piano", kbdOct: 4, recBed: "drums", quant: 16, expMel: true,
  gains: { drums: 0.8, bass: 0.9, keys: 0.75, pad: 0.5, melody: 0.9, voice: 1, click: 0.7 }, mutes: { drums: false, bass: false, keys: false, pad: false, melody: false, voice: false, click: false },
  click: false, master: 0.9, liveGain: 0.9, audioIn: "", audioOut: "", midiIn: "", midiOut: "", monitor: false, latFixMs: 0, listen: "B",
  takes: [demoTake()], active: "demo", nextTake: 1, userSet: { key: false, bpm: false }, sv: 1 };
const state = Object.assign(JSON.parse(JSON.stringify(DEFAULT)), loadJSON(APP + "-settings") || {});
for (const k of ["gains", "mutes"]) state[k] = Object.assign({}, DEFAULT[k], state[k] || {});
let ver = 1; const save = () => { ver++; localStorage.setItem(APP + "-settings", JSON.stringify(state)); };
const loopSteps = () => state.bars * STEPS;
const stepDur = () => 60 / state.bpm / 4;
const loopDur = () => state.bars * 4 * 60 / state.bpm;
const segL = () => STEPS * state.rhythm;
const nSeg = () => Math.max(1, Math.ceil(loopSteps() / segL()));
const activeTake = () => state.takes.find(t => t.id === state.active) || null;
const keyShift = t => ((state.keyRoot - (t.key || 0)) % 12 + 18) % 12 - 6; // takes follow the song key (MIDI notes move; recorded audio never does)

// ---------- melody: the active take, moved into the song key and tiled to the loop length ----------
function takeNotes(t, bars){ if (!t) return []; const sh = keyShift(t), L = (t.bars || bars) * STEPS, out = [];
  for (let o = 0; o < bars * STEPS; o += L) for (const n of t.notes) { const s = n.s + o; if (s >= bars * STEPS) continue; out.push({ n: clamp(n.n + sh, 0, 127), s, d: Math.min(n.d, bars * STEPS - s), v: n.v }); }
  return out.sort((a, b) => a.s - b.s); }
let melCache = { key: "", v: [] };
function melody(){ const t = activeTake(), key = ver + "|" + (t ? t.id : ""); if (melCache.key !== key) melCache = { key, v: takeNotes(t, state.bars) }; return melCache.v; }

// ---------- harmonizer: weighted pitch classes per segment -> candidate chords -> Viterbi path (locks always win) ----------
// candidate = [semitones above the key root, chord quality, function]; function S:x = secondary dominant resolving to degree x
const CANDS = {
  major: { simple: [[0,"","T"],[5,"","PD"],[7,"","D"],[7,"7","D"],[9,"m","T"],[2,"m","PD"]],
    pop: [[0,"","T"],[2,"m","PD"],[4,"m","T"],[5,"","PD"],[7,"","D"],[7,"7","D"],[9,"m","T"],[7,"sus4","D"],[0,"sus2","T"],[5,"add9","PD"]],
    moody: [[0,"","T"],[9,"m","T"],[5,"","PD"],[5,"m","PD"],[7,"","D"],[2,"m","PD"],[10,"","PD"],[8,"","PD"],[3,"","T"],[4,"m","T"]],
    color: [[0,"maj7","T"],[0,"","T"],[2,"m7","PD"],[4,"m7","T"],[5,"maj7","PD"],[5,"","PD"],[7,"7","D"],[7,"","D"],[9,"m7","T"],[9,"m","T"],[2,"7","S:7"],[4,"7","S:9"],[9,"7","S:2"],[7,"sus4","D"],[5,"m6","PD"]] },
  minor: { simple: [[0,"m","T"],[5,"m","PD"],[7,"","D"],[7,"7","D"],[8,"","PD"],[10,"","D"],[3,"","T"]],
    pop: [[0,"m","T"],[3,"","T"],[5,"m","PD"],[7,"m","D"],[8,"","PD"],[10,"","D"],[7,"","D"],[7,"7","D"],[3,"sus2","T"]],
    moody: [[0,"m","T"],[3,"","T"],[5,"m","PD"],[5,"","PD"],[7,"","D"],[8,"","PD"],[10,"","D"],[2,"dim","PD"],[1,"","PD"],[7,"m","D"]],
    color: [[0,"m7","T"],[0,"m","T"],[3,"maj7","T"],[5,"m7","PD"],[7,"7","D"],[7,"m7","D"],[8,"maj7","PD"],[10,"7","D"],[2,"m7b5","PD"],[0,"m9","T"],[3,"","T"],[8,"","PD"]] } };
const PAIRS = { // favourite moves per style ("from>to" in semitones above the key root)
  major: { simple: ["5>7","7>0","0>5","9>5"], pop: ["0>7","7>9","9>5","5>0","0>9","9>7","5>7"], moody: ["8>10","10>0","5>0","0>8","3>10","9>5"], color: ["2>7","9>2","4>9","7>0","0>9"] },
  minor: { simple: ["5>7","7>0","0>5","8>10"], pop: ["0>8","8>3","3>10","10>0","0>10","8>10"], moody: ["0>8","8>10","10>0","5>7","7>0","1>7","2>7"], color: ["2>7","7>0","5>10","10>3","8>2"] } };
const FAMQ = { major: { 0: "T", 2: "PD", 4: "T", 5: "PD", 7: "D", 9: "T", 11: "D" }, minor: { 0: "T", 3: "T", 5: "PD", 7: "D", 8: "PD", 10: "D", 2: "PD" } };
const FLOW = { T: { T: 0.05, PD: 0.3, D: 0.2 }, PD: { T: 0.12, PD: 0.05, D: 0.4 }, D: { T: 0.5, PD: -0.25, D: 0 } };
const EXTRA_Q = { "7": 0.5, maj7: 1, m7: 1, m9: 1, m6: 1, m7b5: 1, sus4: 1, sus2: 1, add9: 1 };
function candObj(deg, q, fam, st){ const c = mk(st.keyRoot + deg, q); return { deg: pc(deg), q, fam, c, name: chName(c), key: pc(deg) + ":" + q }; }
function lockCand(name, st){ const c = parseChord(name); if (!c) return null; const deg = pc(c.root - st.keyRoot); const o = { deg, q: c.q, fam: FAMQ[st.mode][deg] || "PD", c, name: chName(c), key: deg + ":" + c.q + (c.bass != null ? "/" + c.bass : "") }; return o; }
function segWeights(notes, s0, L){ const w = new Array(12).fill(0); let tot = 0, head = null, headW = 0;
  for (const n of notes) { const a = Math.max(s0, n.s), b = Math.min(s0 + L, n.s + n.d); if (b <= a) continue; const onset = n.s >= s0 - 0.01, rel = n.s - s0;
    const acc = !onset ? 0.8 : Math.abs(rel) < 0.26 ? 1.7 : Math.abs(n.s / 4 - Math.round(n.s / 4)) < 0.07 ? (Math.round(n.s) % 8 === 0 ? 1.4 : 1.2) : Math.abs(n.s / 2 - Math.round(n.s / 2)) < 0.13 ? 0.9 : 0.6;
    const x = (b - a) * acc * (0.6 + 0.4 * (n.v == null ? 0.8 : n.v)); w[pc(n.n)] += x; tot += x;
    if (a < s0 + 4 && x > headW) { headW = x; head = pc(n.n); } }
  return { w, tot, head }; }
function fitOf(cd, sg){ if (sg.tot < 1e-6) return { fit: 0.5, empty: true, tones: [], avoid: [], other: [] };
  const pcs = chordPcs(cd.c); let inC = 0, avoid = 0, out = 0; const tones = [], av = [], ot = [];
  for (let p = 0; p < 12; p++) { const x = sg.w[p]; if (!x) continue; if (pcs.includes(p)) { inC += x; tones.push(p); } else if (pcs.includes(pc(p - 1))) { avoid += x; av.push(p); } else { out += x; ot.push(p); } }
  let r = (inC - 0.9 * avoid - 0.35 * out) / sg.tot; if (sg.head != null) r += pcs.includes(sg.head) ? 0.12 : -0.12;
  return { fit: clamp(r, -1, 1), empty: false, tones, avoid: av, other: ot }; }
function trans(A, B, st, style){ let t = 0; const mv = pc(B.deg - A.deg);
  if (A.key === B.key) t -= style === "simple" ? 0.15 : 0.35; else if (A.deg === B.deg) t -= 0.1;
  if (A.fam.startsWith("S:")) t += B.deg === +A.fam.slice(2) ? 0.6 : -0.5; else if (B.fam.startsWith("S:")) t += 0.05; else t += (FLOW[A.fam] || FLOW.PD)[B.fam] || 0;
  if (mv === 5) t += 0.2; else if (mv === 2 || mv === 10) t += 0.05;
  if ((PAIRS[st.mode][style] || []).includes(A.deg + ">" + B.deg)) t += 0.25; return t; }
function hash32(x){ x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); return (x ^ (x >>> 16)) >>> 0; } // seeded variations, no random numbers
const lse = a => { let m = -Infinity; for (const x of a) if (x > m) m = x; if (m === -Infinity) return m; let s = 0; for (const x of a) s += Math.exp(x - m); return m + Math.log(s); };
let harmCache = {};
function harmonize(style, o){ o = o || {}; const st = state, variation = o.variation != null ? o.variation : (style === st.style ? st.variation : 0), locks = o.noLocks ? {} : st.locks;
  const key = [ver, style, variation, o.noLocks ? 1 : 0].join("|"); if (harmCache[key]) return harmCache[key];
  const notes = melody(), L = segL(), N = nSeg(), base = CANDS[st.mode][style].map(([d, q, f]) => candObj(d, q, f, st)), FW = 2.2, TAU = 0.3;
  const segs = [], opts = [], node = [];
  for (let k = 0; k < N; k++) { const sg = segWeights(notes, k * L, L); segs.push(sg); let list = base;
    if (locks[k]) { const lc = lockCand(locks[k], st); if (lc) list = [lc]; }
    opts.push(list); node.push(list.map((cd, i) => { const f = fitOf(cd, sg); let v = FW * f.fit;
      if (EXTRA_Q[cd.q]) v -= style === "color" ? 0 : 0.06 * EXTRA_Q[cd.q]; if (cd.fam.startsWith("S:")) v -= 0.05;
      if (k === 0) v += cd.deg === 0 && cd.fam === "T" ? 0.45 : cd.fam === "T" ? 0.1 : 0;
      if (k === N - 1 && N > 1) v += cd.deg === 0 && cd.fam === "T" ? 1.1 : cd.deg === 7 && cd.fam === "D" ? 0.35 : cd.deg === 5 ? 0.1 : 0; // songs land home (or on V, to loop)
      if (variation > 0) v += (hash32(variation * 2654435 + k * 40503 + i * 9973 + 17) / 4294967295 - 0.5) * 0.7;
      return { v, f }; })); }
  // Viterbi
  const dp = [node[0].map(x => x.v)], bp = [node[0].map(() => -1)];
  for (let k = 1; k < N; k++) { const row = [], br = []; for (let j = 0; j < opts[k].length; j++) { let best = -Infinity, bi = 0;
      for (let i = 0; i < opts[k - 1].length; i++) { const s = dp[k - 1][i] + trans(opts[k - 1][i], opts[k][j], st, style); if (s > best) { best = s; bi = i; } }
      row.push(best + node[k][j].v); br.push(bi); } dp.push(row); bp.push(br); }
  const path = new Array(N); let bi = 0; dp[N - 1].forEach((x, i) => { if (x > dp[N - 1][bi]) bi = i; }); path[N - 1] = bi; for (let k = N - 1; k > 0; k--) path[k - 1] = bp[k][path[k]];
  // forward-backward posteriors = how sure each pick is, given the melody and the chords around it
  const fw = [node[0].map(x => x.v / TAU)], bw = new Array(N);
  for (let k = 1; k < N; k++) fw.push(opts[k].map((_, j) => node[k][j].v / TAU + lse(opts[k - 1].map((_, i) => fw[k - 1][i] + trans(opts[k - 1][i], opts[k][j], st, style) / TAU))));
  bw[N - 1] = opts[N - 1].map(() => 0);
  for (let k = N - 2; k >= 0; k--) bw[k] = opts[k].map((_, i) => lse(opts[k + 1].map((_, j) => trans(opts[k][i], opts[k + 1][j], st, style) / TAU + node[k + 1][j].v / TAU + bw[k + 1][j])));
  const out = [];
  for (let k = 0; k < N; k++) { const lp = opts[k].map((_, i) => fw[k][i] + bw[k][i]), Z = lse(lp), post = lp.map(x => Math.exp(x - Z)), ci = path[k], cd = opts[k][ci], f = node[k][ci].f;
    let alts = base.map((c2, i) => { const f2 = fitOf(c2, segs[k]); return { cand: c2, fit: f2.fit, p: locks[k] ? 0 : post[i] }; });
    if (!locks[k]) alts.sort((a, b) => b.p - a.p || b.fit - a.fit); else alts.sort((a, b) => b.fit - a.fit);
    out.push({ k, cand: cd, chord: cd.c, name: cd.name, fit: f.fit, empty: f.empty, conf: locks[k] ? 1 : post[ci], locked: !!locks[k], alts: alts.slice(0, 8), tones: f.tones, avoid: f.avoid, other: f.other }); }
  const filled = out.filter(s => !s.empty), avgFit = filled.length ? filled.reduce((a, s) => a + Math.max(0, s.fit), 0) / filled.length : 0;
  const r = { style, segs: out, avgFit, avgConf: out.reduce((a, s) => a + s.conf, 0) / N }; harmCache[key] = r; return r; }
const harm = () => harmonize(state.style);
const chordsNow = () => harm().segs.map(s => s.chord);
const chordAtStep = s => { const c = chordsNow(); return c[clamp(Math.floor(s / segL()), 0, c.length - 1)]; };
// key suggestion only (Krumhansl-Schmuckler); the song key is always yours
const KMAJ = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88], KMIN = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
function detectKey(notes){ const h = new Array(12).fill(0); for (const n of notes) h[pc(n.n)] += n.d * (n.v || 0.8); if (h.every(x => !x)) return null; let best = null;
  const corr = (a, b) => { const ma = a.reduce((s, x) => s + x, 0) / 12, mb = b.reduce((s, x) => s + x, 0) / 12; let n = 0, da = 0, db = 0; for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db || 1); };
  for (let r = 0; r < 12; r++) for (const [mode, P] of [["major", KMAJ], ["minor", KMIN]]) { const rot = P.map((_, i) => P[pc(i - r)]), c = corr(h, rot); if (!best || c > best.r) best = { keyRoot: r, mode, r: c }; }
  return best; }

// ---------- band: one recipe per style, read fresh every step (live changes apply on the next step) ----------
const E = (ch, i, n, s, d, v) => ({ ch, i, n, s, d, v });
function bandEvents(st, chords){ const out = [], R = st.recipe, L = STEPS * st.rhythm, keysI = RECIPES[R].keys; let pk = null, pp = null, pa = null;
  for (let b = 0; b < st.bars; b++) { const B = b * STEPS, spans = [];
    for (let s = B; s < B + STEPS;) { const k = Math.floor(s / L), end = Math.min(B + STEPS, (k + 1) * L); spans.push({ s, d: end - s, c: chords[clamp(k, 0, chords.length - 1)] }); s = end; }
    for (const sp of spans) { const c = sp.c, vk = voicing(c, 52, 72, pk, 4), bn = bassOf(c, 33, 52); pk = vk;
      if (R !== "folk" && R !== "sparse") { const vp = voicing(c, 55, 79, pp, 3); pp = vp; for (const n of vp) out.push(E("pad", "strings", n, sp.s, sp.d - 0.15, R === "ballad" ? 0.5 : 0.32)); }
      if (R === "ballad") { for (let o = 0; o < sp.d; o += 8) for (const n of vk) out.push(E("keys", keysI, n, sp.s + o, Math.min(8, sp.d - o) - 0.3, 0.5)); out.push(E("bass", "finger", bn, sp.s, sp.d - 0.3, 0.62)); }
      else if (R === "pop") { for (let o = 0; o < sp.d; o += 2) { for (const n of vk) out.push(E("keys", keysI, n, sp.s + o, 1.6, (sp.s + o) % 4 === 0 ? 0.52 : 0.38)); out.push(E("bass", "finger", bn, sp.s + o, 1.7, (sp.s + o) % 4 === 0 ? 0.78 : 0.56)); } }
      else if (R === "folk") { const va = voicing(c, 50, 70, pa, 3); pa = va; const arp = [bassOf(c, 40, 51), va[2] || va[0], va[1] || va[0], va[2] || va[0]];
        for (let o = 0; o < sp.d; o += 2) out.push(E("keys", keysI, arp[(o / 2) % 4], sp.s + o, 3.6, (sp.s + o) % 8 === 0 ? 0.62 : 0.48));
        for (let o = 0; o < sp.d; o += 8) out.push(E("bass", "finger", o % 16 === 0 ? bn : fold(bn + 7, 33, 52), sp.s + o, Math.min(8, sp.d - o) - 0.4, 0.62)); }
      else { for (const n of vk) out.push(E("keys", keysI, n, sp.s, sp.d - 0.3, 0.46)); out.push(E("bass", "finger", bn, sp.s, sp.d - 0.3, 0.5)); } }
    if (R === "ballad") { out.push(E("drums", "kit", D.kick, B, 1, 0.7), E("drums", "kit", D.rim, B + 8, 1, 0.6)); for (let s = 0; s < 16; s += 4) out.push(E("drums", "kit", D.hat, B + s, 1, 0.32)); }
    else if (R === "pop") { out.push(E("drums", "kit", D.kick, B, 1, 0.9), E("drums", "kit", D.kick, B + 6, 1, 0.6), E("drums", "kit", D.kick, B + 8, 1, 0.85), E("drums", "kit", D.snare, B + 4, 1, 0.8), E("drums", "kit", D.snare, B + 12, 1, 0.8));
      for (let s = 0; s < 16; s += 2) out.push(E("drums", "kit", s === 14 && b % 4 === 3 ? D.ohat : D.hat, B + s, 1, s % 4 === 0 ? 0.5 : 0.36)); }
    else if (R === "folk") { out.push(E("drums", "kit", D.kick, B, 1, 0.75), E("drums", "kit", D.kick, B + 8, 1, 0.7), E("drums", "kit", D.rim, B + 4, 1, 0.6), E("drums", "kit", D.rim, B + 12, 1, 0.6)); for (let s = 0; s < 16; s += 2) out.push(E("drums", "kit", D.hat, B + s, 1, 0.28)); } }
  return out; }
const melodyEvents = () => melody().map(n => E("melody", state.melInst, n.n, n.s, n.d, n.v == null ? 0.8 : n.v));
const clickEvents = () => { const o = []; for (let s = 0; s < loopSteps(); s += 4) o.push(E("click", "kit", D.rim, s, 1, s % 16 === 0 ? 0.95 : 0.55)); return o; };
let songCache = null;
function song(){ const key = ver + "|" + state.recipe; if (songCache && songCache.key === key) return songCache.v;
  const events = bandEvents(state, chordsNow()).concat(melodyEvents(), clickEvents()).map(e => Object.assign({ abs: e.s }, e)), byStep = new Map();
  for (const e of events) { const k = Math.floor(e.abs + 1e-6); if (!byStep.has(k)) byStep.set(k, []); byStep.get(k).push(e); }
  songCache = { key, v: { events, byStep } }; return songCache.v; }
const instsOf = evs => [...new Set(evs.filter(e => e.i !== "kit").map(e => e.i))];

// ---------- sample loading (pinned CDN + bundled kit), progress + names of anything missing ----------
const bufs = {}, loading = new Map(), missing = new Map(); let decoder = null; window.__loadLog = [];
const decodeCtx = () => decoder || (decoder = new OfflineAudioContext(1, 1, SR));
function toMono(b){ if (b.numberOfChannels === 1) return b; const m = new AudioBuffer({ length: b.length, numberOfChannels: 1, sampleRate: b.sampleRate }), d = m.getChannelData(0), l = b.getChannelData(0), r = b.getChannelData(1); for (let i = 0; i < d.length; i++) d[i] = 0.5 * (l[i] + r[i]); return m; }
function loadSample(s){ if (bufs[s.id]) return Promise.resolve(true); if (loading.has(s.id)) return loading.get(s.id);
  const p = (async () => { try { let r = null, err = null;
      for (const [u, wait] of [[s.url, 0], [s.url, 400], [s.alt, 0], [s.alt, 800]]) { if (!u) continue; if (wait) await new Promise(z => setTimeout(z, wait));
        try { r = await fetch(u); if (r.ok) break; err = new Error("HTTP " + r.status); r = null; } catch (e) { err = e; r = null; } }
      if (!r) throw err || new Error("unavailable"); const ab = await r.arrayBuffer(); const b = await decodeCtx().decodeAudioData(ab);
      bufs[s.id] = s.inst === "kit" ? b : toMono(b); missing.delete(s.id); return true; } catch (e) { missing.set(s.id, s); window.__loadLog.push({ id: s.id, err: String(e) }); return false; } finally { loading.delete(s.id); } })();
  loading.set(s.id, p); return p; }
const filesFor = insts => SAMPLES.filter(s => s.inst === "kit" ? insts.includes("kit") : insts.includes(s.inst));
const neededInsts = () => [...new Set(["kit", "strings", "finger", RECIPES[state.recipe].keys, state.melInst, state.liveInst])];
async function ensureInstruments(insts){ const list = filesFor([...new Set(insts.concat(["kit"]))]), todo = list.filter(s => !bufs[s.id]);
  if (!todo.length) { paintLoad(); return missingLabels(list).length === 0; }
  let done = 0; paintLoad(`Loading samples 0/${todo.length}…`);
  const q = todo.slice(); await Promise.all(Array.from({ length: 6 }, async () => { while (q.length) { const s = q.shift(); await loadSample(s); done++; paintLoad(`Loading samples ${done}/${todo.length}…`); } }));
  paintLoad(); return missingLabels(list).length === 0; }
function missingLabels(list){ return [...new Set((list || [...missing.values()]).filter(s => !bufs[s.id] && missing.has(s.id)).map(s => s.inst === "kit" ? s.label : INST[s.inst].label))]; }
const onsetCache = new WeakMap();
function onsetOf(buf){ if (onsetCache.has(buf)) return onsetCache.get(buf); const d = buf.getChannelData(0); let pk = 0;
  for (let i = 0; i < Math.min(d.length, buf.sampleRate); i++) pk = Math.max(pk, Math.abs(d[i]));
  let i = 0; while (i < d.length && Math.abs(d[i]) < pk * 0.02) i++; const t = Math.max(0, i - 8) / buf.sampleRate; onsetCache.set(buf, t); return t; }
const loopCache = new WeakMap();
function loopPoints(buf){ if (loopCache.has(buf)) return loopCache.get(buf); const d = buf.getChannelData(0), sr = buf.sampleRate, on = onsetOf(buf);
  const zc = t => { let i = Math.floor(t * sr); while (i < d.length - 1 && !(d[i] <= 0 && d[i + 1] > 0)) i++; return i / sr; };
  const r = [zc(on + Math.min(1.0, buf.duration * 0.35)), zc(Math.min(2.4, buf.duration * 0.8))]; loopCache.set(buf, r); return r; }

// ---------- voices (looped sustain for held instruments, release >= 10 ms) ----------
let active = new Set();
function playEvent(c, dest, e, when, sd, live){ let buf, rate = 1, sus = false, gain = e.v, src;
  if (e.i === "kit") { const piece = KIT_BY_GM[e.n]; buf = bufs["kit:" + piece]; if (!buf) return null; gain *= KIT[piece].gain; }
  else { const d = INST[e.i], ns = nearestSample(e.i, e.n); if (!ns || Math.abs(ns.shift) > MAX_SHIFT) return null; buf = bufs[ns.id]; if (!buf) return null; rate = Math.pow(2, ns.shift / 12); sus = !!d.sus; gain *= d.gain; }
  const t = live ? when : Math.round(when * c.sampleRate) / c.sampleRate, dur = Math.max(0.03, e.d * sd);
  src = c.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate; src.playbackRate.setValueAtTime(rate, t);
  const on = onsetOf(buf), g = c.createGain();
  if (e.i === "kit") { g.gain.setValueAtTime(gain, t); src.connect(g); g.connect(dest); src.start(t, on); src.stop(t + (buf.duration - on) + 0.01); }
  else { if (sus) { const [a, b] = loopPoints(buf); if (b - a > 0.2) { src.loop = true; src.loopStart = a; src.loopEnd = b; } }
    const atk = sus ? 0.015 : 0.003, rel = sus ? Math.min(0.18, Math.max(0.03, dur * 0.2)) : Math.min(0.12, Math.max(0.02, dur * 0.15));
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + atk); g.gain.setValueAtTime(gain, t + Math.max(atk, dur));
    g.gain.linearRampToValueAtTime(0, t + Math.max(atk, dur) + rel); src.connect(g); g.connect(dest); src.start(t, on); src.stop(t + Math.max(atk, dur) + rel + 0.01); }
  if (live) { const r = { src, g }; active.add(r); src.onended = () => active.delete(r); }
  return src; }
function fastRelease(r, now){ try { r.g.gain.cancelScheduledValues(now); r.g.gain.setValueAtTime(r.g.gain.value, now); r.g.gain.linearRampToValueAtTime(0, now + FAST_RELEASE); r.src.stop(now + FAST_RELEASE + 0.004); } catch (e) {} }

// ---------- live bus: band chairs -> band group, melody/voice -> melody group (A/B), click + live keys -> master -> limiter ----------
let ctx = null, bus = null;
function buildBus(c){ const comp = c.createDynamicsCompressor(); comp.threshold.value = -6; comp.knee.value = 3; comp.ratio.value = 20; comp.attack.value = 0.002; comp.release.value = 0.1;
  const master = c.createGain(), band = c.createGain(), mel = c.createGain(), live = c.createGain(), mon = c.createGain(), an = c.createAnalyser(), anT = c.createAnalyser(), chairs = {}; an.fftSize = 256; anT.fftSize = 256;
  master.gain.value = state.master; live.gain.value = state.liveGain; mon.gain.value = 1;
  for (const ch of CHAIRS) { const g = c.createGain(); g.gain.value = state.mutes[ch.id] ? 0 : state.gains[ch.id]; g.connect(ch.band ? band : ch.live ? master : mel); chairs[ch.id] = g; }
  band.connect(master); mel.connect(master); band.connect(anT); mel.connect(anT); chairs.click.connect(anT); live.connect(master); mon.connect(master); master.connect(comp); comp.connect(c.destination); comp.connect(an);
  return { comp, master, band, mel, live, mon, chairs, an, anT }; }
async function ensureCtx(){ if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); bus = buildBus(ctx); applySink(); applyAB(); }
  if (ctx.state !== "running") await ctx.resume(); }
function applyMix(){ if (!bus) return; const now = ctx.currentTime; for (const ch of CHAIRS) bus.chairs[ch.id].gain.setTargetAtTime(state.mutes[ch.id] ? 0 : state.gains[ch.id], now, 0.01);
  bus.master.gain.setTargetAtTime(state.master, now, 0.01); bus.live.gain.setTargetAtTime(state.liveGain, now, 0.01); }
// A = Thin (the melody alone), B = Need (melody + the chords under it). A gets makeup gain so both play at the same loudness.
let abCache = { key: "", makeup: 1, pending: null };
async function makeupAB(){ const key = ver + "|" + state.recipe; if (abCache.key === key) return abCache.makeup; if (abCache.pending && abCache.pkey === key) return abCache.pending;
  const p = (async () => { try { const B = await renderMix({ noNorm: true, live: true }), A = await renderMix({ noNorm: true, live: true, only: ["melody", "voice"] }), rb = rmsOf(B.ch[0]), ra = rmsOf(A.ch[0]);
      const m = ra > 1e-6 && rb > 1e-6 ? clamp(rb / ra, 0.25, 4) : 1; abCache = { key, makeup: m, pending: null }; return m; } catch (e) { abCache.pending = null; return 1; } })();
  abCache.pending = p; abCache.pkey = key; return p; }
const rmsOf = x => { let s = 0, n = 0; for (let i = 0; i < x.length; i += 4) { s += x[i] * x[i]; n++; } return Math.sqrt(s / Math.max(1, n)); };
async function applyAB(){ if (!bus) return; const A = state.listen === "A", m = A ? await makeupAB() : 1, now = ctx.currentTime;
  if (state.listen !== (A ? "A" : "B")) return; bus.band.gain.setTargetAtTime(A ? 0 : 1, now, 0.01); bus.mel.gain.setTargetAtTime(m, now, 0.01); window.__ab = { listen: state.listen, makeup: m }; paintListen(); }

// ---------- recorded voice (dry audio of a sung take, kept in IndexedDB) ----------
const voiceData = {}; // id -> { sr, data }
const idb = { db: null,
  open(){ return this.db ? Promise.resolve(this.db) : new Promise((res, rej) => { const r = indexedDB.open(APP, 1); r.onupgradeneeded = () => r.result.createObjectStore("audio", { keyPath: "id" }); r.onsuccess = () => { this.db = r.result; res(this.db); }; r.onerror = () => rej(r.error); }); },
  async put(o){ try { const db = await this.open(); db.transaction("audio", "readwrite").objectStore("audio").put(o); } catch (e) {} },
  async del(id){ try { const db = await this.open(); db.transaction("audio", "readwrite").objectStore("audio").delete(id); } catch (e) {} },
  async all(){ try { const db = await this.open(); return await new Promise(res => { const q = db.transaction("audio").objectStore("audio").getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); } catch (e) { return []; } } };
const voiceUsable = t => !!(t && t.audio && voiceData[t.id] && t.bpm === state.bpm && keyShift(t) === 0);
const voiceOn = () => state.melSrc === "voice" && voiceUsable(activeTake());
let voiceBufCache = { key: "", buf: null };
function voiceBuf(){ const t = activeTake(), key = (t ? t.id : "") + "|" + (ctx ? ctx.sampleRate : 0); if (voiceBufCache.key === key) return voiceBufCache.buf;
  const v = t && voiceData[t.id]; let b = null; if (v && ctx) { const d = resample(v.data, v.sr, ctx.sampleRate); b = ctx.createBuffer(1, d.length, ctx.sampleRate); b.copyToChannel(d, 0); } voiceBufCache = { key, buf: b }; return b; }
function resample(x, from, to){ if (from === to) return x; const n = Math.round(x.length * to / from), y = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) { const p = i * r, j = Math.floor(p), f = p - j; y[i] = (x[j] || 0) * (1 - f) + (x[j + 1] || 0) * f; } return y; }
// the voice plays bar by bar (short linear crossfades at bar lines), so switching takes or A/B lands on the next bar line
function scheduleVoiceBar(bar, t, first){ const tk = activeTake(), buf = voiceBuf(); if (!buf || !tk) return;
  const bd = 4 * 60 / state.bpm, off = (bar % (tk.bars || state.bars)) * bd, pre = 0.0025, src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = buf;
  const head = !(first || off === 0), st = head ? t - pre : t, so = head ? off - pre : off, len = bd + (head ? pre : 0) + pre;
  g.gain.setValueAtTime(head ? 0 : 1, st); if (head) g.gain.linearRampToValueAtTime(1, st + 2 * pre); g.gain.setValueAtTime(1, st + len - 2 * pre); g.gain.linearRampToValueAtTime(0, st + len);
  src.connect(g); g.connect(bus.chairs.voice); src.start(st, Math.max(0, so), len); src.stop(st + len + 0.005); const r = { src, g }; active.add(r); src.onended = () => active.delete(r); }

// ---------- transport: audio-clock lookahead scheduler; the loop repeats; every pass can be a take ----------
let play = null, timerId = null; const stepLog = []; window.__schedLog = [];
function start(){ if (!ctx || ctx.state !== "running") return false; const miss = missingLabels(filesFor(neededInsts())); if (miss.length) { setStatus("Can't play: " + miss.join(", ") + " didn't load."); return false; }
  stop(true); if (armNext) { rec = { passes: [], made: 0 }; armNext = false; } play = { step: 0, nextT: ctx.currentTime + 0.1, first: true }; stepLog.length = 0; timerId = setInterval(scheduler, LOOKAHEAD_MS); scheduler(); requestAnimationFrame(draw); paintTransport(); return true; }
function scheduler(){ if (!play) return; const sd = stepDur();
  while (play.nextT < ctx.currentTime + SCHEDULE_AHEAD) { if (play.step >= loopSteps()) play.step = 0; scheduleStep(play.step, play.nextT, sd); play.nextT += sd; play.step++; }
  if (rec) recTick(); }
function scheduleStep(k, time, sd){ const sg = song(), evs = sg.byStep.get(k) || [], heard = [], useVoice = voiceOn();
  if (rec && k === 0) rec.passes.push({ t0: time, bpm: state.bpm, bars: state.bars, key: state.keyRoot });
  for (const e of evs) { if (state.mutes[e.ch]) continue;
    if (e.ch === "click" && !(state.click || rec)) continue;
    if (rec && (e.ch === "melody" || (CHAIR[e.ch].band && (state.recBed === "click" || (state.recBed === "drums" && e.ch !== "drums"))))) continue;
    if (e.ch === "melody" && useVoice) continue;
    const t = time + (e.abs - k) * sd; playEvent(ctx, bus.chairs[e.ch], e, t, sd, true); if (e.ch !== "click") midiSend(e, t, sd); heard.push(e.ch + ":" + e.n); }
  if (k % STEPS === 0) { if (useVoice && !rec) { scheduleVoiceBar(k / STEPS, time, play.first); heard.push("voice:bar"); } play.first = false; }
  stepLog.push({ s: k, time }); if (stepLog.length > 512) stepLog.shift();
  window.__schedLog.push({ step: k, time, ver, bpm: state.bpm, recipe: state.recipe, style: state.style, keyRoot: state.keyRoot, listen: state.listen, chord: chName(chordAtStep(k)), notes: heard }); if (window.__schedLog.length > 4000) window.__schedLog.shift(); }
function stop(quiet){ clearInterval(timerId); timerId = null; const was = !!play; play = null;
  if (rec) endRec(true);
  if (ctx) { const now = ctx.currentTime; for (const r of active) fastRelease(r, now); active.clear(); liveAllOff(true); }
  if (midiOut) for (let c = 0; c < 16; c++) { midiOut.send([0xB0 | c, 123, 0]); midiOut.send([0xB0 | c, 120, 0]); }
  paintTransport(); if (was && !quiet) setStatus("Stopped."); }
function draw(){ if (!play) return; const now = ctx.currentTime; let cur = null; for (const e of stepLog) { if (e.time <= now) cur = e; else break; }
  if (cur) paintPlayhead(cur.s); requestAnimationFrame(draw); }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { if (play) { stop(true); setStatus("Stopped because the tab was hidden. Any unfinished pass was dropped. Press Play to start again."); } liveAllOff(); } });
async function measureStopSilence(){ const a = new Float32Array(bus.anT.fftSize), t0 = performance.now(); stop(); for (let i = 0; i < 200; i++) { await new Promise(r => setTimeout(r, 2)); bus.anT.getFloatTimeDomainData(a); let p = 0; for (const x of a) p = Math.max(p, Math.abs(x)); if (p < 0.001) return { ms: performance.now() - t0, peak: p }; } return { ms: null }; }

// ---------- recording: every full loop pass becomes a take (MIDI keys = notes; mic = dry audio + transcribed notes) ----------
let rec = null, armNext = false; const recNotes = [];
async function startRec(){ await ensureCtx(); if (!mic && !midiInPort && !state.recordKeys) { setStatus("Turn the mic on or pick a MIDI keyboard first (or tick ‘Record on-screen keys too’)."); return false; }
  const wasPlaying = !!play; capChunks.length = 0; recNotes.length = 0;
  if (wasPlaying) rec = { passes: [], made: 0 }; else { armNext = true; if (!start()) { armNext = false; return false; } }
  if (mic) mic.node.port.postMessage({ rec: true });
  paintTransport(); setStatus(wasPlaying ? "Armed: takes start at the top of the next pass." : `Recording: sing, hum or play your melody. Every full ${state.bars}-bar pass becomes a take. Press Stop when you're done.`); return true; }
function latencyS(){ return (ctx ? (ctx.outputLatency || ctx.baseLatency || 0) : 0) + (mic ? mic.inLat : 0) + state.latFixMs / 1000; }
function recTick(){ while (rec && rec.passes.length) { const p = rec.passes[0], ld = p.bars * 4 * 60 / p.bpm; if (ctx.currentTime > p.t0 + ld + latencyS() + 0.06) finishPass(rec.passes.shift()); else break; } }
const newId = p => p + Date.now().toString(36) + state.nextTake;
function finishPass(p){ const ld = p.bars * 4 * 60 / p.bpm, made = []; let num = 0; const passNo = () => num || (num = state.nextTake++);
  if (p.bpm !== state.bpm || p.bars !== state.bars || p.key !== state.keyRoot) { setStatus("Tempo, key or length changed during the pass, so it wasn't kept as a take."); return; }
  const sd = 60 / p.bpm / 4, ns = recNotes.filter(n => n.on >= p.t0 - 0.03 && n.on < p.t0 + ld - 0.03).map(n => ({ n: n.note, v: Math.round(n.vel * 1000) / 1000, s: Math.max(0, Math.round((n.on - p.t0) / sd * 1000) / 1000), d: Math.max(0.25, Math.round((Math.min(n.off != null ? n.off : p.t0 + ld, p.t0 + ld) - n.on) / sd * 1000) / 1000) }));
  if (ns.length) { const t = { id: newId("k"), name: "Keys " + passNo(), src: "keys", key: p.key, bpm: p.bpm, bars: p.bars, notes: ns, audio: false }; state.takes.push(t); made.push(t); }
  if (mic) { const data = sliceCapture(p.t0, ld); let pk = 0; for (let i = 0; i < data.length; i++) pk = Math.max(pk, Math.abs(data[i]));
    if (pk > 0.003) { const notes = transcribe(data, ctx.sampleRate, p.bpm, p.bars);
      if (notes.length) { const t = { id: newId("v"), name: "Voice " + passNo(), src: "voice", key: p.key, bpm: p.bpm, bars: p.bars, notes, audio: true }; voiceData[t.id] = { sr: ctx.sampleRate, data }; idb.put({ id: t.id, sr: ctx.sampleRate, data }); state.takes.push(t); made.push(t); } } }
  const keep = p.t0 + ld - 1; for (let i = capChunks.length - 1; i >= 0; i--) if ((capChunks[i].f + capChunks[i].d.length) / ctx.sampleRate < keep + latencyS()) capChunks.splice(i, 1);
  if (made.length) state.active = made[made.length - 1].id;
  save(); if (rec) rec.made += made.length; paintAll(); setStatus(made.length ? `Kept ${made.map(t => t.name + " (" + t.notes.length + " notes)").join(" + ")} and harmonized it. Keep going: the next pass is the next take.` : "That pass was silent, so no take was kept."); }
function endRec(discard){ if (!rec) return; const p = rec.passes.length; rec = null; if (mic) mic.node.port.postMessage({ rec: false }); paintTransport(); if (p && discard) setStatus("Stopped. The unfinished pass was dropped; full passes are kept as takes."); }

// ---------- pitch: YIN on a 16 kHz copy -> notes (median-smoothed, split on pitch jumps and re-attacks) ----------
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
function pitchFrames(x, sr){ const Dn = Math.max(1, Math.round(sr / 16000)), fs = sr / Dn, n = Math.floor(x.length / Dn), y = new Float32Array(Math.max(0, n));
  for (let i = 0; i < n; i++) { let a = 0; for (let k = 0; k < Dn; k++) a += x[i * Dn + k] || 0; y[i] = a / Dn; }
  const W = Math.round(fs * 0.04), H = Math.round(fs * 0.01), tmin = Math.floor(fs / 1000), tmax = Math.ceil(fs / 70), frames = [], dd = new Float32Array(tmax + 1);
  for (let o = 0; o + W + tmax < y.length; o += H) { let e = 0; for (let i = 0; i < W; i++) e += y[o + i] * y[o + i]; const rms = Math.sqrt(e / W);
    if (rms < 0.002) { frames.push({ t: o / fs, rms, m: null, ap: 1 }); continue; }
    dd[0] = 0; for (let t = 1; t <= tmax; t++) { let s = 0; for (let i = 0; i < W; i++) { const d = y[o + i] - y[o + i + t]; s += d * d; } dd[t] = s; }
    let run = 0, tau = -1, ap = 1; for (let t = 1; t <= tmax; t++) { run += dd[t]; dd[t] = run > 0 ? dd[t] * t / run : 1; }
    for (let t = tmin; t < tmax; t++) { if (dd[t] < 0.2) { while (t + 1 < tmax && dd[t + 1] < dd[t]) t++; tau = t; ap = dd[t]; break; } }
    let f0 = null; if (tau > 0) { const a = dd[tau - 1], b = dd[tau], c = dd[tau + 1]; const sh = (a - c) / (2 * (a - 2 * b + c) || 1); f0 = fs / (tau + (isFinite(sh) ? sh : 0)); }
    frames.push({ t: o / fs, rms, m: f0 ? 69 + 12 * Math.log2(f0 / 440) : null, ap }); }
  return frames; }
// re-attack on the same pitch: level dipped well below the note's peak in the last ~60 ms and is now climbing again
function reattack(fr, i, peak){ if (i < 6) return false; let lo = Infinity; for (let j = i - 6; j < i; j++) lo = Math.min(lo, fr[j].rms); return lo < 0.7 * peak && fr[i].rms > 1.5 * lo && fr[i].rms > fr[i - 1].rms; }
function transcribe(x, sr, bpm, bars){ const fr = pitchFrames(x, sr), sd = 60 / bpm / 4, total = bars * STEPS; if (!fr.length) return [];
  const rs = fr.map(f => f.rms).sort((a, b) => a - b), p95 = rs[Math.floor(rs.length * 0.95)] || 0, thr = Math.max(0.004, p95 * 0.12);
  const m = fr.map(f => f.m != null && f.rms > thr && f.ap < 0.3 && f.m > 40 && f.m < 92 ? f.m : null);
  const sm = m.map((v, i) => { if (v == null) return null; const w = m.slice(Math.max(0, i - 2), i + 3).filter(z => z != null); return median(w); });
  const raw = []; let cur = null;
  const close = t => { if (cur && t - cur.a >= 0.07) raw.push({ a: cur.a, b: t, n: Math.round(median(cur.ps)), lv: cur.lv, re: cur.re }); cur = null; };
  let dev = []; // frames drifting away from the note's own pitch; 3 in a row (or one big jump) start a new note there, even on a slow glide
  for (let i = 0; i < fr.length; i++) { const v = sm[i], t = fr[i].t;
    if (v == null) { close(t); dev = []; continue; }
    if (cur) { const ref = median(cur.ps), d = Math.abs(v - ref);
      if (d > 1.5 || (d > 0.55 && dev.length >= 2)) { const back = dev.length && d <= 1.5 ? dev : []; const t1 = back.length ? back[0].t : t; const keep = cur.ps.length - back.length;
        cur.ps.length = Math.max(1, keep); close(t1); cur = { a: t1, ps: back.map(x => x.v), lv: 0, re: false }; dev = []; }
      else if (d > 0.55) dev.push({ t, v }); else dev = []; }
    let re = false; if (cur && t - cur.a > 0.12 && reattack(fr, i, cur.lv)) { re = true; close(t); dev = []; }
    if (!cur) cur = { a: t, ps: [], lv: 0, re }; cur.ps.push(v); cur.lv = Math.max(cur.lv, fr[i].rms); }
  close(fr[fr.length - 1].t + 0.01);
  const q = state.quant === 16 ? 1 : state.quant === 8 ? 2 : 0, out = [];
  for (const r of raw) { let s = r.a / sd, e = r.b / sd; if (q) { s = Math.round(s / q) * q; e = Math.round(e / q) * q; if (e - s < q) e = s + q; } else { s = Math.round(s * 1000) / 1000; e = Math.round(e * 1000) / 1000; }
    if (s >= total) continue; const prev = out[out.length - 1];
    if (prev && prev.n === r.n && !r.re && s - (prev.s + prev.d) <= (q || 0.5) && r.lv < 2 * prev.lvRaw) { prev.d = Math.min(total, e) - prev.s; continue; }
    if (prev && prev.s + prev.d > s) { prev.d = Math.max(q || 0.25, s - prev.s); if (prev.s >= s) out.pop(); }
    out.push({ n: r.n, s, d: Math.min(total, e) - s, v: Math.round(clamp(r.lv / (p95 || 1), 0.3, 1) * 1000) / 1000, lvRaw: r.lv }); }
  return out.filter(n => n.d > 0).map(({ n, s, d, v }) => ({ n, s, d, v })); }

// ---------- audio input: device choice + dry capture worklet + optional monitoring ----------
const CAPTURE_SRC = `class UKCap extends AudioWorkletProcessor{ constructor(){ super(); this.rec=false; this.pk=0; this.n=0; this.port.onmessage=e=>Object.assign(this,e.data); }
  process(ins,outs){ const i=ins[0]&&ins[0][0], o=outs[0]; if(!i) return true; for(let c=0;c<o.length;c++) o[c].set(i); for(let k=0;k<i.length;k++){ const a=Math.abs(i[k]); if(a>this.pk) this.pk=a; }
    if(this.rec){ const c=i.slice(0); this.port.postMessage({f:currentFrame, d:c}, [c.buffer]); }
    if(++this.n>=16){ this.port.postMessage({pk:this.pk}); this.pk=0; this.n=0; } return true; } }
registerProcessor("ukcap", UKCap);`;
let mic = null; const capChunks = []; let peakHold = 0;
async function enableMic(){ await ensureCtx(); if (mic) return true;
  try { const c = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }; if (state.audioIn) c.deviceId = { exact: state.audioIn };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: c });
    if (!ctx.__ukcap) { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([CAPTURE_SRC], { type: "application/javascript" }))); ctx.__ukcap = true; }
    const src = ctx.createMediaStreamSource(stream), node = new AudioWorkletNode(ctx, "ukcap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }), mon = ctx.createGain();
    mon.gain.value = state.monitor ? 1 : 0; src.connect(node); node.connect(mon); mon.connect(bus.mon);
    node.port.onmessage = e => { const m = e.data; if (m.pk !== undefined) { peakHold = Math.max(m.pk, peakHold * 0.85); paintMeter(); return; } capChunks.push(m); };
    const tr = stream.getAudioTracks()[0], s = tr.getSettings ? tr.getSettings() : {};
    mic = { stream, src, node, mon, inLat: typeof s.latency === "number" ? s.latency : 0.01, label: tr.label }; if (rec) node.port.postMessage({ rec: true });
    paintMicState(); listDevices(); return true; }
  catch (e) { mic = null; paintMicState(`Mic not available (${e.name}). You can still play your melody on a MIDI keyboard, or import a voice memo / MIDI file.`); return false; } }
function disableMic(){ if (!mic) return; mic.stream.getTracks().forEach(t => t.stop()); try { mic.src.disconnect(); mic.node.disconnect(); mic.mon.disconnect(); } catch (e) {} mic = null; peakHold = 0; paintMeter(); paintMicState(); }
function sliceCapture(t0, dur){ const sr = ctx.sampleRate, n = Math.round(dur * sr), out = new Float32Array(n), f0 = Math.round((t0 + latencyS()) * sr);
  for (const c of capChunks) { const a = c.f - f0; if (a + c.d.length <= 0 || a >= n) continue; for (let i = Math.max(0, -a); i < c.d.length && a + i < n; i++) out[a + i] = c.d[i]; }
  return out; }

// ---------- import: a voice memo (sung/hummed) or a MIDI file of the melody ----------
function parseMidi(u8){ let p = 0; const rd = n => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u8[p++]; return v; }, vlq = () => { let v = 0, b; do { b = u8[p++]; v = v * 128 + (b & 127); } while (b & 128); return v; };
  if (rd(4) !== 0x4D546864) throw new Error("not a MIDI file"); const hl = rd(4); rd(2); const nt = rd(2), div = rd(2); p = 8 + hl; const groups = {};
  for (let k = 0; k < nt && p < u8.length; k++) { if (rd(4) !== 0x4D54726B) break; const len = rd(4), end = p + len; let t = 0, rs = 0; const open = {};
    while (p < end) { t += vlq(); let st = u8[p]; if (st < 0x80) st = rs; else { p++; if (st < 0xF0) rs = st; }
      if (st === 0xFF) { p++; const l = vlq(); p += l; continue; } if (st === 0xF0 || st === 0xF7) { const l = vlq(); p += l; continue; }
      const c = st & 0xF0, ch = st & 15, a = u8[p++], b = (c === 0xC0 || c === 0xD0) ? 0 : u8[p++], g = k + ":" + ch;
      if (c === 0x90 && b > 0) open[ch * 128 + a] = { t, v: b }; else if (c === 0x80 || (c === 0x90 && b === 0)) { const o = open[ch * 128 + a]; if (o) { (groups[g] = groups[g] || { ch, notes: [] }).notes.push({ n: a, t0: o.t, t1: t, v: o.v / 127 }); delete open[ch * 128 + a]; } } }
    p = end; }
  return { div, groups: Object.values(groups) }; }
function melodyFromMidi(u8){ const { div, groups } = parseMidi(u8), cand = groups.filter(g => g.ch !== 9 && g.notes.length);
  if (!cand.length) throw new Error("no notes found");
  const score = g => g.notes.length * (g.notes.reduce((a, n) => a + n.n, 0) / g.notes.length >= 55 ? 2 : 1), g = cand.sort((a, b) => score(b) - score(a))[0];
  const byOn = new Map(); for (const n of g.notes) { const s = Math.round(n.t0 * 4 / div * 1000) / 1000, o = byOn.get(s); if (!o || n.n > o.n) byOn.set(s, Object.assign({}, n, { s })); } // top note = melody
  const total = loopSteps(); return [...byOn.values()].sort((a, b) => a.s - b.s).filter(n => n.s < total).map(n => ({ n: n.n, s: n.s, d: Math.max(0.25, Math.min(total - n.s, Math.round((n.t1 - n.t0) * 4 / div * 1000) / 1000)), v: Math.round(n.v * 1000) / 1000 })); }
async function importFiles(files){ await ensureCtx(); let made = 0, last = null;
  for (const f of files) { const buf = new Uint8Array(await f.arrayBuffer()), nm = f.name.replace(/\.[^.]+$/, "").slice(0, 22);
    if (/\.midi?$/i.test(f.name) || (buf[0] === 0x4D && buf[1] === 0x54 && buf[2] === 0x68 && buf[3] === 0x64)) {
      try { const notes = melodyFromMidi(buf); const t = { id: newId("f"), name: nm, src: "midifile", key: state.keyRoot, bpm: state.bpm, bars: state.bars, notes, audio: false }; state.nextTake++; state.takes.push(t); last = t; made++; }
      catch (e) { setStatus(`Couldn't read ${f.name} (${e.message}).`); } continue; }
    let b; try { b = await ctx.decodeAudioData(buf.buffer.slice(0)); } catch (e) { setStatus(`Couldn't read ${f.name} (${e.name}). Use WAV, MP3, M4A or a .mid file.`); continue; }
    const m = new Float32Array(b.length); for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < b.length; i++) m[i] += d[i] / b.numberOfChannels; }
    const L = Math.round(loopDur() * b.sampleRate), passes = clamp(Math.round(m.length / L), 1, 8);
    for (let p = 0; p < passes; p++) { const data = new Float32Array(L); data.set(m.subarray(p * L, Math.min(m.length, (p + 1) * L))); const notes = transcribe(data, b.sampleRate, state.bpm, state.bars); if (!notes.length) continue;
      const t = { id: newId("a"), name: passes > 1 ? nm.slice(0, 18) + " p" + (p + 1) : nm, src: "audiofile", key: state.keyRoot, bpm: state.bpm, bars: state.bars, notes, audio: true }; state.nextTake++;
      voiceData[t.id] = { sr: b.sampleRate, data }; idb.put({ id: t.id, sr: b.sampleRate, data }); state.takes.push(t); last = t; made++; } }
  if (last) state.active = last.id; save(); paintAll();
  if (made) setStatus(`Imported ${made} take${made > 1 ? "s" : ""} at ${state.bpm} BPM, ${keyLong(state)}: ${last.notes.length} melody notes, harmonized. Press Play.`); else setStatus("No melody notes found in that file.");
  return made; }

// ---------- export: OfflineAudioContext, 48 kHz, exact bar length, downbeat at sample 0, tail folded, peak -1 dBFS ----------
// Exports are always B (melody + chords) unless a single part is asked for; what you audition never changes the file. No click.
function exportEvents(o){ o = o || {}; const band = bandEvents(state, chordsNow()); let mel = [];
  if (o.take) mel = takeNotes(o.take, state.bars).map(n => E("melody", state.melInst, n.n, n.s, n.d, n.v == null ? 0.8 : n.v));
  else if (state.expMel && !voiceOn()) mel = melodyEvents();
  return band.concat(mel).map(e => Object.assign({ abs: e.s }, e)); }
const EXPORT_CHAIRS = ["drums", "bass", "keys", "pad", "melody", "voice"];
async function renderMix(o){ o = o || {}; const sd = stepDur(), N = Math.round(state.bars * 4 * 60 / state.bpm * SR), T = Math.round(TAIL_S * SR), evs = exportEvents(o), only = o.only || EXPORT_CHAIRS;
  const need = instsOf(evs.filter(e => only.includes(e.ch))); if (!(await ensureInstruments(need))) throw new Error("Missing instruments: " + missingLabels(filesFor(need.concat(["kit"]))).join(", ") + ". Tap Retry next to the sample list, then export again.");
  const oc = new OfflineAudioContext(2, N + T, SR), sum = oc.createGain(), chairs = {}, barSmp = 4 * 60 / state.bpm * SR; sum.connect(oc.destination);
  for (const c of EXPORT_CHAIRS) { const g = oc.createGain(); g.gain.value = state.mutes[c] && !o.ignoreMutes ? 0 : state.gains[c]; g.connect(sum); chairs[c] = g; }
  for (const e of evs) { if (!only.includes(e.ch) || !chairs[e.ch]) continue; const bi = Math.floor(e.abs / STEPS); playEvent(oc, chairs[e.ch], e, (Math.round(bi * barSmp) + Math.round((e.abs - bi * STEPS) * sd * SR)) / SR, sd, false); }
  const vt = o.voiceTake || (!o.take && state.expMel && voiceOn() ? activeTake() : null);
  if (vt && only.includes("voice") && voiceData[vt.id]) { const v = voiceData[vt.id], d = resample(v.data, v.sr, SR), Lt = Math.round((vt.bars || state.bars) * barSmp), x = new Float32Array(N);
    for (let off = 0; off < N; off += Lt) x.set(d.subarray(0, Math.min(Lt, d.length, N - off)), off);
    const ab = oc.createBuffer(1, N, SR); ab.copyToChannel(x, 0); const s = oc.createBufferSource(); s.buffer = ab; s.connect(chairs.voice); s.start(0); }
  const buf = await oc.startRendering(), ch = [0, 1].map(c => buf.getChannelData(c).slice(0, N));
  for (let c = 0; c < 2; c++) { const src = buf.getChannelData(c); for (let j = 0; j < T && j < N; j++) ch[c][j] += src[N + j]; } // ring-out folded to the top: seamless loop
  let pk = 0; for (const x of ch) for (let i = 0; i < N; i++) { const a = Math.abs(x[i]); if (a > pk) pk = a; }
  const target = Math.pow(10, -1.1 / 20), g = o.gain != null ? o.gain : (pk > 0 ? target / pk : 1); if (!o.noNorm) for (const x of ch) for (let i = 0; i < N; i++) x[i] *= g;
  return { ch, N, gain: g, peak: pk }; }
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function wav24(ch, N){ const nc = 2, len = N * nc * 3, b = new ArrayBuffer(44 + len), v = new DataView(b); let p = 0;
  const str = s => { for (const c of s) v.setUint8(p++, c.charCodeAt(0)); }, u32 = x => { v.setUint32(p, x, true); p += 4; }, u16 = x => { v.setUint16(p, x, true); p += 2; };
  str("RIFF"); u32(36 + len); str("WAVE"); str("fmt "); u32(16); u16(1); u16(nc); u32(SR); u32(SR * nc * 3); u16(nc * 3); u16(24); str("data"); u32(len);
  for (let i = 0; i < N; i++) for (let c = 0; c < nc; c++) { let x = Math.round(Math.max(-1, Math.min(1, ch[c][i])) * 8388607); if (x < 0) x += 16777216; v.setUint8(p++, x & 255); v.setUint8(p++, (x >> 8) & 255); v.setUint8(p++, (x >> 16) & 255); }
  return new Uint8Array(b); }
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "take";
const fileBase = o => `${APP}-${state.style}${o && o.part ? "-" + slug(o.part) : ""}-${state.bpm}bpm-${keyLabel(state)}`;
const segLabel = k => { const r = state.rhythm; if (r === 1) return "Bar " + (k + 1); if (r === 2) return "Bars " + (2 * k + 1) + "–" + Math.min(state.bars, 2 * k + 2); return "Bar " + (Math.floor(k / 2) + 1) + (k % 2 ? "b" : "a"); };
function midiFile(){ const PPQ = 480, T = PPQ / 4, total = loopSteps() * T, vlq = n => { const a = [n & 127]; while (n >>= 7) a.unshift((n & 127) | 128); return a; };
  const trk = evs => { evs.sort((a, b) => a.t - b.t || a.o - b.o); let last = 0; const d = []; for (const e of evs) { d.push(...vlq(e.t - last), ...e.b); last = e.t; }
    d.push(...vlq(Math.max(0, total - last)), 0xFF, 0x2F, 0); return [0x4D, 0x54, 0x72, 0x6B, (d.length >>> 24) & 255, (d.length >> 16) & 255, (d.length >> 8) & 255, d.length & 255, ...d]; };
  const meta = (type, s) => { const c = [...String(s).replace(/·/g, "-").replace(/♭/g, "b").replace(/♯/g, "#").replace(/[^\x20-\x7e]/g, "?")].map(ch => ch.charCodeAt(0)); /* MIDI text stays plain ASCII */ return [0xFF, type, ...vlq(c.length), ...c]; }, us = Math.round(60000000 / state.bpm), H = harm();
  const cond = [{ t: 0, o: 0, b: meta(0x03, `${BRAND} ${state.bpm} BPM ${keyLabel(state)} · ${STYLES[state.style].name}`) }, { t: 0, o: 1, b: [0xFF, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] }, { t: 0, o: 2, b: [0xFF, 0x58, 4, 4, 2, 24, 8] }];
  H.segs.forEach((s, k) => cond.push({ t: Math.round(k * segL() * T), o: 3, b: meta(0x06, `${s.name} (${roman(s.chord, state)})`) }));
  const tracks = [trk(cond)], evs = exportEvents({}).filter(e => e.ch !== "melody");
  const noteTrack = (name, ch, list, gm) => { const out = [{ t: 0, o: 0, b: meta(0x03, name) }]; if (gm != null) out.push({ t: 0, o: 1, b: [0xC0 | ch, gm] });
    for (const e of list) { const t0 = Math.round(e.abs * T), t1 = Math.min(total, Math.round((e.abs + e.d) * T)), v = clamp(Math.round(e.v * 127), 1, 127); out.push({ t: t0, o: 3, b: [0x90 | ch, e.n, v] }); out.push({ t: Math.max(t0 + 1, e.i === "kit" ? t0 + T / 2 : t1), o: 2, b: [0x80 | ch, e.n, 0] }); }
    return trk(out); };
  for (const c of CHAIRS) { if (!c.band || state.mutes[c.id]) continue; const list = evs.filter(e => e.ch === c.id); if (!list.length) continue; tracks.push(noteTrack(c.name, c.ch, list, list[0].i === "kit" ? null : INST[list[0].i].gm)); }
  // chord symbols as one held block per segment (easy to drag into any DAW)
  const blocks = []; H.segs.forEach((s, k) => { for (const n of voicing(s.chord, 48, 67, null, 4)) blocks.push({ abs: k * segL(), d: Math.min(segL(), loopSteps() - k * segL()), n, v: 0.7, i: "piano" }); });
  tracks.push(noteTrack("Chord blocks (one per " + (state.rhythm === 1 ? "bar" : state.rhythm === 2 ? "2 bars" : "half bar") + ")", 5, blocks, 0));
  const at = activeTake(); if (at) tracks.push(noteTrack("Melody · " + at.name, 3, takeNotes(at, state.bars).map(n => ({ abs: n.s, d: n.d, n: n.n, v: n.v == null ? 0.8 : n.v, i: state.melInst })), INST[state.melInst].gm));
  state.takes.filter(t => t !== at).forEach((t, i) => tracks.push(noteTrack(t.name + " (take)", 6 + (i % 3), takeNotes(t, state.bars).map(n => ({ abs: n.s, d: n.d, n: n.n, v: n.v == null ? 0.8 : n.v, i: state.melInst })), INST[state.melInst].gm)));
  return new Uint8Array([].concat([0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, PPQ >> 8, PPQ & 255], ...tracks)); }
function chordChart(){ const H = harm(), st = state, segs = H.segs, per = st.rhythm === 0.5 ? 8 : st.rhythm === 2 ? 2 : 4, lines = [];
  lines.push(`${BRAND} chord chart`, `Key ${keyLong(st)} · ${st.bpm} BPM · 4/4 · ${st.bars} bars · ${STYLES[st.style].name} style · ${st.rhythm === 1 ? "one chord per bar" : st.rhythm === 2 ? "one chord per 2 bars" : "two chords per bar"}`, `Melody: ${activeTake() ? activeTake().name : "none"}`, "");
  for (let i = 0; i < segs.length; i += per) { const row = segs.slice(i, i + per), cell = f => "| " + row.map(s => f(s).padEnd(7)).join(" | ") + " |";
    lines.push(cell(s => s.name), cell(s => roman(s.chord, st)), cell(s => nashville(s.chord, st)), ""); }
  lines.push("Bar by bar (fit = how well the chord holds the melody notes; sure = how clearly this chord wins here):");
  for (const s of segs) lines.push(`${segLabel(s.k).padEnd(9)} ${s.name.padEnd(7)} ${roman(s.chord, st).padEnd(6)} ${s.empty ? "no melody here   " : `fit ${String(Math.round(Math.max(0, s.fit) * 100)).padStart(3)}%`}  sure ${String(Math.round(s.conf * 100)).padStart(3)}%${s.locked ? "  locked" : ""}`);
  return new TextEncoder().encode(lines.join("\n") + "\n"); }
async function exportWavBytes(o){ o = o || {}; const r = await renderMix(o); return { bytes: wav24(r.ch, r.N), name: fileBase(o) + ".wav", frames: r.N, gain: r.gain, peak: r.peak }; }
function exportMidBytes(){ return { bytes: midiFile(), name: fileBase() + ".mid" }; }
function exportChartBytes(){ return { bytes: chordChart(), name: fileBase({ part: "chords" }) + ".txt" }; }
function crc32(b){ let c, crc = -1; for (let i = 0; i < b.length; i++) { c = (crc ^ b[i]) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ -1) >>> 0; }
function zipStore(fl, asParts){ const parts = [], cen = []; let off = 0; const enc = new TextEncoder(); const le = (n, w) => { const a = []; for (let i = 0; i < w; i++) a.push((n >>> (8 * i)) & 255); return a; };
  for (const f of fl) { const nm = enc.encode(f.name), c = crc32(f.bytes), sz = f.bytes.length;
    const h = new Uint8Array([0x50, 0x4B, 3, 4, 20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0, ...le(c, 4), ...le(sz, 4), ...le(sz, 4), ...le(nm.length, 2), 0, 0, ...nm]);
    parts.push(h, f.bytes); cen.push(new Uint8Array([0x50, 0x4B, 1, 2, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0, ...le(c, 4), ...le(sz, 4), ...le(sz, 4), ...le(nm.length, 2), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(off, 4), ...nm])); off += h.length + sz; }
  const cl = cen.reduce((a, x) => a + x.length, 0), end = new Uint8Array([0x50, 0x4B, 5, 6, 0, 0, 0, 0, ...le(fl.length, 2), ...le(fl.length, 2), ...le(cl, 4), ...le(off, 4), 0, 0]);
  const all = [...parts, ...cen, end]; if (asParts) return all; const out = new Uint8Array(off + cl + end.length); let p = 0; for (const x of all) { out.set(x, p); p += x.length; } return out; }
// stems: mix, every band part, the melody, every take on its own, raw sung audio; same exact length and one shared gain, so they line up and sum in a DAW
async function exportStemsBytes(o){ o = o || {}; const jobs = [["mix", {}]], evs = exportEvents({}), fl = [];
  for (const c of ["drums", "bass", "keys", "pad"]) if (!state.mutes[c] && evs.some(e => e.ch === c)) jobs.push([CHAIR[c].name, { only: [c], part: c }]);
  if (state.expMel && !voiceOn() && evs.some(e => e.ch === "melody")) jobs.push(["melody", { only: ["melody"], part: "melody" }]);
  for (const t of state.takes) { jobs.push(["take " + t.name, { only: ["melody"], part: "take-" + t.name, take: t, ignoreMutes: true }]);
    if (voiceUsable(t)) jobs.push(["raw voice " + t.name, { only: ["voice"], part: "raw-voice-" + t.name, voiceTake: t, take: t, ignoreMutes: true }]); }
  let gain = null;
  for (let i = 0; i < jobs.length; i++) { const [lab, jo] = jobs[i]; if (o.onProgress) o.onProgress(i / jobs.length, `stem ${i + 1}/${jobs.length}: ${lab}`);
    const w = await exportWavBytes(Object.assign({}, jo, gain != null ? { gain } : {})); if (gain == null) gain = w.gain; fl.push({ name: w.name, bytes: w.bytes }); await new Promise(r => setTimeout(r, 0)); }
  fl.push(exportMidBytes(), exportChartBytes());
  const name = fileBase() + "-stems.zip"; if (o.blob) { const parts = zipStore(fl, true); return { blob: new Blob(parts, { type: "application/zip" }), name, files: fl.map(f => ({ name: f.name, size: f.bytes.length })) }; }
  return { zip: zipStore(fl), name, files: fl }; }
// Save a file. iPhone/iPad: the share sheet (Save to Files, AirDrop…) via navigator.share({files}); elsewhere a blob link with
// a[download]; last resort opens the file in a new tab. A tap-to-save button stays up as a backup (iOS drops the gesture during a render).
let lastSave = null;
async function saveFile(data, name, type, auto){ const blob = data instanceof Blob ? data : new Blob([data], { type }); let file = null;
  try { file = new File([blob], name, { type }); } catch (e) {}
  if (lastSave && lastSave.url) URL.revokeObjectURL(lastSave.url); lastSave = { blob, file, name, type, url: URL.createObjectURL(blob) }; paintSave();
  if (auto === false) return "ready";
  return trySave(); }
async function trySave(){ const f = lastSave; if (!f) return "none"; const mb = fmtSize(f.blob.size);
  if (isIOS() && f.file && navigator.canShare && navigator.share) { let ok = false; try { ok = navigator.canShare({ files: [f.file] }); } catch (e) {}
    if (ok) { try { await navigator.share({ files: [f.file], title: f.name }); expMsg(`Shared ${f.name} (${mb}). In the share sheet pick "Save to Files" to keep it.`, "ok"); return "shared"; }
      catch (e) { if (e.name === "AbortError") { expMsg(`Share cancelled. ${f.name} is ready: tap "Save ${f.name}" below to try again.`, "warn"); return "cancelled"; }
        if (e.name !== "NotAllowedError") expMsg(`Share sheet failed (${e.name}: ${e.message}). Use the "Save" link below instead.`, "bad"); else expMsg(`${f.name} is ready (${mb}). Tap "Save ${f.name}" below to open the share sheet.`, "warn"); return "needs-tap"; } } }
  try { if ("download" in HTMLAnchorElement.prototype) { const a = document.createElement("a"); a.href = f.url; a.download = f.name; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); return "downloaded"; } } catch (e) {}
  const w = window.open(f.url, "_blank"); if (!w) { expMsg(`Your browser blocked the download. Tap "Save ${f.name}" below.`, "warn"); return "blocked"; } return "opened"; }
function paintSave(){ const el = document.getElementById("saveRow"); if (!el) return; const f = lastSave; el.hidden = !f; if (!f) return;
  el.innerHTML = `<button id="saveBtn" class="mini">Save ${esc(f.name)}</button> <a id="saveLink" href="${f.url}" download="${esc(f.name)}" target="_blank" rel="noopener">or open it</a> <span class="hint">${fmtSize(f.blob.size)}</span>`;
  document.getElementById("saveBtn").onclick = () => trySave(); }
const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
function expMsg(m, cls){ setStatus(m); const el = document.getElementById("expMsg"); if (el) { el.textContent = m; el.className = "expmsg " + (cls || ""); } }
function expProgress(p){ const el = document.getElementById("expProg"); if (!el) return; el.hidden = p == null; if (p != null) el.value = p; }

// ---------- Lemon Squeezy license gate (restricted to our store + product; empty config = checkout not live yet) ----------
const LEMON = { checkoutUrl: "", storeId: null, productId: null, price: "$19 once" };
const LS_API = "https://api.lemonsqueezy.com/v1/licenses/";
const lic = loadJSON(APP + "-license") || { valid: false };
const configured = () => !!(LEMON.storeId && LEMON.productId);
// No Lemon Squeezy product configured = nobody can buy, so nothing is gated. Gating resumes on its own once a product is set.
const gated = () => configured() && !lic.valid;
const FREE_BARS = 8;
const LAUNCH_NOTE = "Launch: full exports free until checkout opens.";
if (!configured()) lic.valid = false;
async function lsCall(action, params){ const r = await fetch(LS_API + action, { method: "POST", headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() }); return r.json(); }
const ours = j => !!j && j.meta && +j.meta.store_id === +LEMON.storeId && +j.meta.product_id === +LEMON.productId;
async function activateKey(key){ if (!configured()) return { ok: false, reason: "Checkout opening soon. License keys can't be checked until the store is live." };
  const j = await lsCall("activate", { license_key: key, instance_name: BRAND + " web" }); if (!j.activated) return { ok: false, reason: j.error || "That key could not be activated." };
  if (!ours(j)) { if (j.instance) lsCall("deactivate", { license_key: key, instance_id: j.instance.id }).catch(() => {}); return { ok: false, reason: "That key is for a different product." }; }
  return { ok: true, instance: j.instance.id }; }
async function validateKey(key, instance){ if (!configured()) return false; const j = await lsCall("validate", { license_key: key, instance_id: instance }); return !!j.valid && ours(j); }
const saveLic = () => localStorage.setItem(APP + "-license", JSON.stringify(lic));

// ---------- Web MIDI in/out ----------
let midiAccess = null, midiOut = null, midiInPort = null;
function midiSend(e, time, sd){ if (!midiOut || !ctx) return; const ch = CHAIR[e.ch].ch, at = performance.now() + (time - ctx.currentTime) * 1000, v = clamp(Math.round(e.v * 127), 1, 127);
  midiOut.send([0x90 | ch, e.n, v], at); midiOut.send([0x80 | ch, e.n, 0], at + Math.max(15, (e.i === "kit" ? 0.5 : e.d) * sd * 1000 - 3)); }
function onMidi(ev){ const d = ev.data, s = d[0], cmd = s & 0xF0, n = d[1], v = d[2]; if (s >= 0xF0) return; // clock/start/stop ignored: MIDI never starts the transport
  if (cmd === 0xB0 && n === 64) { setSustain(v >= 64); return; } if (cmd === 0xB0 && (n === 123 || n === 120)) { liveAllOff(); return; }
  if (cmd === 0x90 && v > 0) liveOn(n, v / 127, "midi"); else if (cmd === 0x80 || (cmd === 0x90 && v === 0)) liveOff(n, "midi"); }
function refreshMidi(){ if (!midiAccess) return;
  const fill = (sel, ports, cur) => { sel.innerHTML = '<option value="">(none)</option>' + [...ports.values()].map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(""); sel.value = [...ports.keys()].includes(cur) ? cur : ""; };
  if (!state.midiIn && midiAccess.inputs.size) state.midiIn = [...midiAccess.inputs.keys()][0];
  fill(ui.midiIn, midiAccess.inputs, state.midiIn); fill(ui.midiOut, midiAccess.outputs, state.midiOut);
  if (midiInPort) midiInPort.onmidimessage = null; midiInPort = midiAccess.inputs.get(ui.midiIn.value) || null; if (midiInPort) midiInPort.onmidimessage = onMidi;
  midiOut = midiAccess.outputs.get(ui.midiOut.value) || null;
  ui.midiNote.textContent = (midiAccess.inputs.size ? (midiInPort ? `Playing ${INST[state.liveInst].label} from ${midiInPort.name}. Velocity and sustain pedal (CC64) work; notes never start the transport. While recording, every pass you play becomes a melody take.` : "Pick your MIDI keyboard above.") : "No MIDI keyboard found. Plug one in and it shows up here; the on-screen keys below are a fallback.")
    + (midiOut ? ` Sending the band and melody (drums on ch 10) to ${midiOut.name} while playing.` : ""); }

// ---------- live play (MIDI keyboard first; on-screen and computer keys as fallback) ----------
const liveVoices = new Map(); let sustain = false; window.__liveLog = [];
function liveVoice(note, vel, t){ const i = state.liveInst, ns = nearestSample(i, note); if (!ns || Math.abs(ns.shift) > MAX_SHIFT) return null; const buf = bufs[ns.id]; if (!buf) return null;
  const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = buf; src.playbackRate.value = Math.pow(2, ns.shift / 12);
  if (INST[i].sus) { const [a, b] = loopPoints(buf); if (b - a > 0.2) { src.loop = true; src.loopStart = a; src.loopEnd = b; } }
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * INST[i].gain, t + 0.005); src.connect(g); g.connect(bus.live); src.start(t, onsetOf(buf)); src.stop(t + 30); return { src, g }; }
function liveOn(note, vel, src){ if (!ctx || ctx.state !== "running") { setStatus("Tap to start audio first."); return; } const t = ctx.currentTime + 0.005, key = src + ":" + note;
  window.__liveLog.push({ note, vel, src, t, playing: !!play }); keyVis(note, true); const old = liveVoices.get(key); if (old) releaseVoice(old, t);
  if (!bufs[nearestSample(state.liveInst, note).id]) ensureInstruments([state.liveInst]);
  const v = liveVoice(note, vel, t), r = { vs: v ? [v] : [], note };
  if (rec && (src === "midi" || state.recordKeys)) { r.recN = { note, vel, on: ctx.currentTime, off: null }; recNotes.push(r.recN); }
  liveVoices.set(key, r); }
function releaseVoice(r, t, fast){ if (r.done) return; r.done = true; if (r.recN && r.recN.off == null) r.recN.off = ctx.currentTime; const rel = fast ? FAST_RELEASE : 0.15;
  for (const v of r.vs) { try { v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(v.g.gain.value, t); v.g.gain.linearRampToValueAtTime(0, t + rel); v.src.stop(t + rel + 0.01); } catch (e) {} } }
function liveOff(note, src){ const key = src + ":" + note, vo = liveVoices.get(key); keyVis(note, false); if (!vo) return; if (sustain) { vo.sustained = true; return; } liveVoices.delete(key); releaseVoice(vo, ctx.currentTime); }
function setSustain(down){ sustain = down; if (!down && ctx) for (const [k, vo] of [...liveVoices]) if (vo.sustained) { liveVoices.delete(k); releaseVoice(vo, ctx.currentTime); } }
function liveAllOff(fast){ if (!ctx) return; for (const [, vo] of liveVoices) releaseVoice(vo, ctx.currentTime, fast); liveVoices.clear(); sustain = false; document.querySelectorAll(".down").forEach(k => k.classList.remove("down")); }
const KEYMAP = "AWSEDFTGYHUJK";
function keyVis(n, on){ document.querySelectorAll(`[data-n="${n}"]`).forEach(k => k.classList.toggle("down", on)); }

// ---------- audio devices: output (setSinkId) + input ----------
const sinkOK = () => typeof (window.AudioContext || function(){}).prototype.setSinkId === "function";
async function listDevices(){ let devs = []; try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
  const ins = devs.filter(d => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default"), outs = devs.filter(d => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default");
  ui.audioIn.innerHTML = '<option value="">System default input</option>' + ins.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || "Audio input " + (i + 1))}</option>`).join(""); ui.audioIn.value = ins.some(d => d.deviceId === state.audioIn) ? state.audioIn : "";
  if (!sinkOK()) { ui.audioOut.innerHTML = '<option value="">System default</option>'; ui.audioOut.disabled = true; ui.audioOutNote.textContent = "This browser can't send Web Audio to a chosen device (no setSinkId), so sound uses your system output."; return; }
  ui.audioOut.innerHTML = '<option value="">System default</option>' + outs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || "Audio output " + (i + 1))}</option>`).join(""); ui.audioOut.value = outs.some(d => d.deviceId === state.audioOut) ? state.audioOut : "";
  if (outs.length && !outs[0].label) ui.audioOutNote.textContent = "Device names appear after you allow the mic once."; }
async function applySink(){ if (!ctx || !sinkOK()) return; try { const want = state.audioOut || ""; if ((typeof ctx.sinkId === "string" ? ctx.sinkId : "") !== want) await ctx.setSinkId(want); ui.audioOutNote.textContent = state.audioOut ? "Playing through the selected output." : "Playing through the system default output."; }
  catch (e) { ui.audioOutNote.textContent = "Couldn't switch output (" + e.name + "), so the system default is in use."; state.audioOut = ""; save(); ui.audioOut.value = ""; } }
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", listDevices);

// ---------- UI ----------
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ui = {}; let selSeg = null;
const SRC_LABEL = { demo: "demo", keys: "played on keys", voice: "sung (mic)", midifile: "MIDI file", audiofile: "voice memo" };
function setStatus(m){ if (ui.status) ui.status.textContent = m; }
function paintLoad(msg){ if (!ui.load) return; const miss = missingLabels(); if (msg) { ui.load.textContent = msg; ui.load.className = "load busy"; return; }
  if (miss.length) { ui.load.innerHTML = "<b>Missing instruments:</b> " + miss.map(esc).join(", ") + ". These samples didn't load (sample host blocked or offline). Playback and export stay off until they load. <button id='retry'>Retry</button>"; ui.load.className = "load bad"; $("retry").onclick = async () => { for (const s of [...missing.values()]) missing.delete(s.id); await ensureInstruments(neededInsts()); };
  } else { const n = Object.keys(bufs).length; ui.load.textContent = n ? `Real samples ready: ${n} files (FluidR3 GM pinned @${SF_SHA.slice(0, 7)} + CC0 Virtuosity kit). No synthesized sound anywhere.` : "Samples load when the page opens."; ui.load.className = "load ok"; } }
function paintTransport(){ if (!ui.play) return; ui.play.textContent = play ? "■ Stop" : "▶ Play loop"; ui.play.classList.toggle("on", !!play);
  ui.rec.textContent = rec ? "● Recording takes… (Stop to finish)" : "● Record melody takes"; ui.rec.classList.toggle("rec", !!rec); document.body.classList.toggle("recording", !!rec); }
const fmtMS = t => Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");
let lastSegPainted = -1;
function paintPlayhead(step){ const bar = Math.floor(step / STEPS), k = Math.floor(step / segL());
  if (ui.ph) ui.ph.style.left = (step / loopSteps() * 100) + "%";
  if (k === lastSegPainted) return; lastSegPainted = k; const s = harm().segs[k];
  ui.pos.textContent = `Bar ${bar + 1} / ${state.bars} · ${s ? s.name + " (" + roman(s.chord, state) + ")" : ""} · ${fmtMS(bar * 4 * 60 / state.bpm)} / ${fmtMS(loopDur())}`;
  document.querySelectorAll(".cells .now").forEach(e => e.classList.remove("now")); const c = document.querySelector(`.cells [data-seg="${k}"]`); if (c) c.classList.add("now"); }
function setOpts(sel, list, v){ sel.innerHTML = list.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join(""); sel.value = String(v); }
function paintSong(){ ui.bpm.value = state.bpm; ui.key.value = state.keyRoot; ui.mode.value = state.mode; ui.bars.value = state.bars; ui.recipe.value = state.recipe;
  ui.recipeNote.textContent = RECIPES[state.recipe].note + ` · preset tempo ${RECIPES[state.recipe].bpm} BPM`;
  const k = detectKey(melody()), sug = $("keySug");
  if (k && (k.keyRoot !== state.keyRoot || k.mode !== state.mode) && k.r > 0.5) { sug.innerHTML = `Your melody leans toward <b>${esc(keyLong(k))}</b> (match ${Math.round(k.r * 100)}%). Your key stays unless you switch: <button class="mini" id="useKey">Use ${esc(keyLong(k))}</button>`;
    $("useKey").onclick = () => { if (k.keyRoot !== state.keyRoot) setSetting("keyRoot", k.keyRoot); setSetting("mode", k.mode); }; }
  else sug.textContent = k ? `Your melody sits well in ${keyLong(state)}.` : ""; }
function paintTakes(){ const el = ui.takes; if (!el) return; const ts = state.takes;
  if (!ts.length) { el.innerHTML = `<p class="empty">No melody yet. Press <b>● Record melody takes</b> and sing, hum or play it; or import a voice memo or MIDI file; or <button class="mini" id="demo2">load the demo</button>.</p>`; $("demo2").onclick = loadDemo; return; }
  el.innerHTML = ts.map(t => { const sh = keyShift(t), au = t.audio ? (voiceData[t.id] ? (t.bpm === state.bpm ? (sh ? "voice audio (key moved: plays as notes)" : "voice audio") : `voice audio @ ${t.bpm} BPM`) : "voice audio missing") : "";
    return `<div class="take ${t.id === state.active ? "on" : ""}" data-id="${esc(t.id)}"><label><input type="radio" name="act" ${t.id === state.active ? "checked" : ""} data-use="${esc(t.id)}"> <b>${esc(t.name)}</b></label>
      <span class="hint">${esc(SRC_LABEL[t.src] || t.src)} · ${t.notes.length} notes · ${t.bars} bars${sh ? ` · moved ${sh > 0 ? "+" : ""}${sh}` : ""}${au ? " · " + esc(au) : ""}</span>
      <span class="acts"><button class="mini" data-oct="-12" data-id="${esc(t.id)}" title="Octave down">8vb</button><button class="mini" data-oct="12" data-id="${esc(t.id)}" title="Octave up">8va</button><button class="mini" data-ren="${esc(t.id)}">rename</button><button class="mini del" data-del="${esc(t.id)}">delete</button></span></div>`; }).join("");
  el.querySelectorAll("[data-use]").forEach(r => r.onchange = () => setSetting("active", r.dataset.use));
  el.querySelectorAll("[data-oct]").forEach(b => b.onclick = () => { const t = ts.find(x => x.id === b.dataset.id); for (const n of t.notes) n.n = clamp(n.n + +b.dataset.oct, 0, 127); save(); paintAll(); });
  el.querySelectorAll("[data-ren]").forEach(b => b.onclick = () => { const t = ts.find(x => x.id === b.dataset.ren), n = prompt("Name this take", t.name); if (n) { t.name = n.slice(0, 28); save(); paintTakes(); } });
  el.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { const t = ts.find(x => x.id === b.dataset.del); if (!confirm("Delete " + t.name + "?")) return; state.takes = ts.filter(x => x !== t); if (t.audio) { idb.del(t.id); delete voiceData[t.id]; }
    if (state.active === t.id) state.active = state.takes.length ? state.takes[state.takes.length - 1].id : null; save(); paintAll(); }); }
function loadDemo(){ if (!state.takes.some(t => t.id === "demo")) state.takes.unshift(demoTake()); state.active = "demo"; save(); paintAll(); setStatus("Demo melody loaded (Ode to Joy, public domain). Press Play, then try the four styles."); }
const pct = x => Math.round(clamp(x, 0, 1) * 100);
const fitCls = (s) => s.empty ? "na" : s.fit >= 0.75 ? "good" : s.fit >= 0.45 ? "ok" : "bad";
function paintChords(){ if (!ui.cells) return; const H = harm(), N = H.segs.length, st = state;
  ui.styles.innerHTML = Object.entries(STYLES).map(([k, s]) => { const h = harmonize(k); return `<button class="style ${k === st.style ? "on" : ""}" data-style="${k}"><b>${esc(s.name)}</b><small>${esc(h.segs.slice(0, 4).map(x => x.name).join(" "))}${h.segs.length > 4 ? " …" : ""}</small><i>fit ${pct(h.avgFit)}%</i></button>`; }).join("");
  ui.styles.querySelectorAll("[data-style]").forEach(b => b.onclick = () => setSetting("style", b.dataset.style));
  ui.rhythm.value = String(st.rhythm); $("varLbl").textContent = st.variation ? `variation ${st.variation}` : "best fit";
  ui.cells.style.gridTemplateColumns = `repeat(${N}, minmax(0, 1fr))`;
  ui.cells.innerHTML = H.segs.map(s => `<button class="cell ${fitCls(s)} ${s.locked ? "lk" : ""} ${selSeg === s.k ? "sel" : ""}" data-seg="${s.k}" title="${esc(segLabel(s.k))}"><small>${esc(segLabel(s.k))}</small><b>${esc(s.name)}</b><em>${esc(roman(s.chord, st))}</em>
    <span class="meter"><i style="width:${s.empty ? 0 : pct(s.fit)}%"></i></span><span class="nums">${s.empty ? "no melody" : "fit " + pct(s.fit) + "%"} · sure ${pct(s.conf)}%${s.locked ? " 🔒" : ""}</span></button>`).join("");
  ui.cells.querySelectorAll("[data-seg]").forEach(b => b.onclick = () => { selSeg = selSeg === +b.dataset.seg ? null : +b.dataset.seg; paintChords(); });
  paintRoll(H); paintEditor(H);
  const filled = H.segs.filter(s => !s.empty);
  ui.why.innerHTML = filled.length ? `<b>Why these chords</b><ol>` + H.segs.map(s => `<li><b>${esc(segLabel(s.k))} ${esc(s.name)}</b>: ${s.empty ? "no melody notes here, so it follows the chords around it" : `melody notes ${esc(s.tones.map(p => NAMES[p]).join(", ") || "-")} are chord tones` + (s.avoid.length ? `; ${esc(s.avoid.map(p => NAMES[p]).join(", "))} rub (a half step above a chord tone)` : "") + (s.other.length ? `; ${esc(s.other.map(p => NAMES[p]).join(", "))} pass by` : "")}${s.locked ? " · locked by you" : ""}.</li>`).join("") + "</ol>" : "";
  lastSegPainted = -1; }
function paintRoll(H){ const el = ui.roll, notes = melody(); if (!el) return; const L = loopSteps();
  if (!notes.length) { el.innerHTML = `<div class="ph" id="ph"></div><p class="empty">The melody shows here once you have a take.</p>`; ui.ph = $("ph"); return; }
  const lo = Math.min(...notes.map(n => n.n)) - 1, hi = Math.max(...notes.map(n => n.n)) + 1, R = hi - lo + 1;
  let svg = `<svg viewBox="0 0 ${L} ${R}" preserveAspectRatio="none">`;
  for (let s = 0; s < L; s += STEPS) svg += `<rect x="${s}" y="0" width="0.15" height="${R}" class="bl"/>`;
  for (let k = 0; k < H.segs.length; k++) svg += `<rect x="${k * segL()}" y="0" width="0.3" height="${R}" class="sl"/>`;
  for (const n of notes) { const s = H.segs[clamp(Math.floor(n.s / segL()), 0, H.segs.length - 1)], p = pc(n.n), c = chordPcs(s.chord).includes(p) ? "ct" : chordPcs(s.chord).includes(pc(p - 1)) ? "av" : "ot";
    svg += `<rect x="${n.s}" y="${hi - n.n}" width="${Math.max(0.4, n.d - 0.15)}" height="0.85" rx="0.3" class="${c}"><title>${noteName(n.n)}</title></rect>`; }
  el.innerHTML = svg + `</svg><div class="ph" id="ph"></div><div class="legend"><span class="ct">chord tone</span><span class="av">rubs</span><span class="ot">passing</span></div>`; ui.ph = $("ph"); }
function paintEditor(H){ const el = ui.editor; if (selSeg == null || selSeg >= H.segs.length) { el.hidden = true; return; } const s = H.segs[selSeg]; el.hidden = false;
  el.innerHTML = `<div class="edhead"><b>${esc(segLabel(s.k))}</b> · now <b>${esc(s.name)}</b> (${esc(roman(s.chord, state))})${s.locked ? " · 🔒 locked" : ""} <button class="mini" id="edClose">close</button></div>
    <div class="alts">${s.alts.map(a => `<button class="alt ${a.cand.name === s.name ? "on" : ""}" data-alt="${esc(a.cand.name)}"><b>${esc(a.cand.name)}</b> <em>${esc(roman(a.cand.c, state))}</em><small>${s.empty ? "" : "fit " + pct(a.fit) + "%"}${s.locked ? "" : " · " + pct(a.p) + "% likely"}</small></button>`).join("")}</div>
    <div class="edrow"><input id="edType" placeholder="or type any chord (e.g. Fmaj7, D7, Bb, Am/C)" spellcheck="false"> <button class="mini" id="edSet">Set + lock</button>
    ${s.locked ? `<button class="mini" id="edUnlock">Unlock (let UnderKit choose)</button>` : `<button class="mini" id="edLock">Lock ${esc(s.name)}</button>`}<span class="hint" id="edErr"></span></div>`;
  const lockTo = name => { const L = Object.assign({}, state.locks); L[s.k] = name; setSetting("locks", L); };
  el.querySelectorAll("[data-alt]").forEach(b => b.onclick = () => lockTo(b.dataset.alt));
  $("edClose").onclick = () => { selSeg = null; paintChords(); };
  $("edSet").onclick = () => { const c = parseChord($("edType").value); if (!c) { $("edErr").textContent = "Couldn't read that chord."; return; } lockTo(chName(c)); };
  $("edType").onkeydown = e => { if (e.key === "Enter") $("edSet").click(); };
  if ($("edUnlock")) $("edUnlock").onclick = () => { const L = Object.assign({}, state.locks); delete L[s.k]; setSetting("locks", L); };
  if ($("edLock")) $("edLock").onclick = () => lockTo(s.name); }
function paintListen(){ if (!ui.abA) return; ui.abA.classList.toggle("on", state.listen === "A"); ui.abB.classList.toggle("on", state.listen === "B");
  const m = window.__ab && window.__ab.listen === "A" ? window.__ab.makeup : 1;
  ui.match.textContent = state.listen === "A" ? `Hearing A · Thin: the melody alone, raised ${(20 * Math.log10(m)).toFixed(1)} dB to match B's loudness, so fuller never wins just by being louder.` : "Hearing B · Need: your melody with the chords under it.";
  ui.click.checked = state.click; ui.melInst.value = state.melInst; ui.melSrc.value = state.melSrc;
  const t = activeTake(); $("melSrcNote").textContent = state.melSrc === "voice" ? (voiceUsable(t) ? "Playing your recorded voice (dry), bar-locked to the loop." : t && t.audio ? (t.bpm !== state.bpm ? `This take was sung at ${t.bpm} BPM; audio is never time-stretched, so its notes play on the instrument.` : "The key moved since you sang it; audio is never pitch-shifted, so its notes play on the instrument.") : "This take has no recorded audio; its notes play on the instrument.") : ""; }
function paintMix(){ ui.mix.innerHTML = CHAIRS.map(c => `<div class="ch"><label>${esc(c.name)}</label><input type="range" min="0" max="1.2" step="0.01" value="${state.gains[c.id]}" data-g="${c.id}"><button class="mini ${state.mutes[c.id] ? "on" : ""}" data-m="${c.id}">${state.mutes[c.id] ? "muted" : "mute"}</button></div>`).join("")
    + `<div class="ch"><label>Live keyboard</label><input type="range" min="0" max="1.2" step="0.01" value="${state.liveGain}" id="lg"></div><div class="ch"><label>Master</label><input type="range" min="0" max="1.2" step="0.01" value="${state.master}" id="mg"></div>`;
  ui.mix.querySelectorAll("[data-g]").forEach(r => r.oninput = () => { state.gains[r.dataset.g] = +r.value; saveMix(); });
  ui.mix.querySelectorAll("[data-m]").forEach(b => b.onclick = () => setSetting("mutes", { [b.dataset.m]: !state.mutes[b.dataset.m] }));
  $("lg").oninput = e => { state.liveGain = +e.target.value; saveMix(); }; $("mg").oninput = e => { state.master = +e.target.value; saveMix(); }; }
function saveMix(){ localStorage.setItem(APP + "-settings", JSON.stringify(state)); applyMix(); } // mixer moves don't change the harmony, so caches stay
function paintMicState(msg){ if (!ui.micState) return; ui.micBtn.textContent = mic ? "Turn mic off" : "Turn mic on";
  ui.micState.textContent = msg || (mic ? `Mic on: ${mic.label || "default input"} · ${ctx.sampleRate} Hz · ${state.monitor ? "you hear yourself (use headphones)" : "monitor off"} · sung passes are pitch-tracked into notes and the dry audio is kept` : "Mic off. Turn it on to sing or hum your melody."); }
function paintMeter(){ const m = $("meterBar"); if (!m) return; const db = peakHold > 1e-5 ? 20 * Math.log10(peakHold) : -90; m.style.width = clamp((db + 60) / 60 * 100, 0, 100) + "%"; }
function paintInput(){ ui.monitor.checked = state.monitor; ui.lat.value = state.latFixMs; $("lat_v").textContent = (state.latFixMs > 0 ? "+" : "") + state.latFixMs + " ms"; ui.recKeys.checked = !!state.recordKeys; ui.recBed.value = state.recBed; ui.quant.value = String(state.quant); ui.liveInst.value = state.liveInst; }
function paintExportBtns(){ if (!ui.wav) return; const lock = gated() && state.bars > FREE_BARS, lab = lock ? ` 🔒 ${state.bars} bars needs unlock` : ` · ${state.bars} bars`;
  ui.wav.textContent = "Export WAV" + lab; ui.mid.textContent = "Export MIDI" + lab; ui.stems.textContent = gated() ? "Export stems ZIP 🔒" : "Export stems ZIP"; ui.expMel.checked = state.expMel;
  $("expNote").textContent = (!configured() ? LAUNCH_NOTE + " " : lock ? `Exports up to ${FREE_BARS} bars are free; ${state.bars} bars exports after the unlock. ` : "") + `Files are named ${fileBase()}.wav / .mid, exactly ${state.bars} bars at 48 kHz / 24-bit with the downbeat at sample 0.`; }
function paintLicense(){ const b = ui.buy; if (configured() && LEMON.checkoutUrl) { b.textContent = "Unlock UnderKit · " + LEMON.price; b.disabled = false; b.onclick = () => window.open(LEMON.checkoutUrl, "_blank", "noopener"); }
  else { b.textContent = "Checkout opening soon · " + LEMON.price; b.disabled = true; }
  ui.licState.textContent = !configured() ? `${LAUNCH_NOTE} WAV, MIDI, chord chart and stems ZIP at every length. (${LEMON.price} when checkout opens.)` : lic.valid ? "Unlocked: 16-bar exports and stems ZIP with every take." : `Free: record, harmonize, edit and play everything; WAV, MIDI and chord chart up to ${FREE_BARS} bars. Unlock adds 16-bar exports and the stems ZIP (every part + every take + raw voice).`;
  paintExportBtns(); }
function paintKeys(){ const lo = state.kbdOct * 12 + 12, wk = [], bk = []; let wi = 0;
  for (let n = lo; n < lo + 25; n++) { const blk = [1, 3, 6, 8, 10].includes(pc(n)), lab = KEYMAP[n - lo] || ""; if (blk) bk.push(`<div class="bk" data-n="${n}" style="left:${wi * 34 - 11}px">${lab}</div>`); else { wk.push(`<div class="wk" data-n="${n}">${lab}<small>${pc(n) === 0 ? noteName(n) : ""}</small></div>`); wi++; } }
  ui.kbd.innerHTML = wk.join("") + bk.join(""); ui.kbd.querySelectorAll("[data-n]").forEach(k => { const n = +k.dataset.n;
    k.onpointerdown = e => { e.preventDefault(); k.setPointerCapture(e.pointerId); liveOn(n, 0.8, "screen"); }; k.onpointerup = k.onpointercancel = () => liveOff(n, "screen"); });
  $("oct_v").textContent = "C" + state.kbdOct; }
function paintAll(){ paintSong(); paintTakes(); paintChords(); paintListen(); paintMix(); paintInput(); paintLicense(); paintKeys(); paintTransport(); paintLoad(); paintMicState(); }

// one path for every setting change (UI and test hook): validate, persist, apply live (the scheduler reads it on the next step)
function setSetting(k, v){
  if (k === "bpm") { const n = Math.round(+v); if (!(n >= 60 && n <= 180)) { paintSong(); setStatus("BPM must be 60–180."); return false; } state.bpm = n; state.userSet.bpm = true; }
  else if (k === "keyRoot") { const d = ((+v - state.keyRoot) % 12 + 18) % 12 - 6; const L = {}; for (const [s, nm] of Object.entries(state.locks)) { const c = parseChord(nm); if (c) L[s] = chName(trC(c, d)); }
    state.locks = L; state.keyRoot = pc(+v); state.userSet.key = true; if (d) setStatus(`Melody and chords moved ${d > 0 ? "up" : "down"} ${Math.abs(d)} semitone${Math.abs(d) > 1 ? "s" : ""} to ${keyLong(state)}.`); }
  else if (k === "mode") state.mode = v === "minor" ? "minor" : "major";
  else if (k === "bars") { const n = +v; if (![4, 8, 16].includes(n)) return false; state.bars = n; for (const s of Object.keys(state.locks)) if (+s >= nSeg()) delete state.locks[s]; }
  else if (k === "recipe") { if (!RECIPES[v]) return false; state.recipe = v; }
  else if (k === "style") { if (!STYLES[v]) return false; state.style = v; state.variation = 0; }
  else if (k === "rhythm") { const n = +v; if (![0.5, 1, 2].includes(n)) return false; state.rhythm = n; state.locks = {}; selSeg = null; }
  else if (k === "variation") state.variation = clamp(Math.round(+v), 0, 99);
  else if (k === "locks") state.locks = v || {};
  else if (k === "listen") { state.listen = v === "A" ? "A" : "B"; }
  else if (k === "active") { if (!state.takes.some(t => t.id === v)) return false; state.active = v; }
  else if (k === "melInst" || k === "liveInst") { if (!INST[v]) return false; state[k] = v; }
  else if (k === "melSrc") state.melSrc = v === "voice" ? "voice" : "inst";
  else if (k === "mutes") { Object.assign(state.mutes, v); }
  else state[k] = v;
  save(); applyMix(); if (k === "listen" || !["mutes", "click"].includes(k)) applyAB();
  if (["recipe", "melInst", "liveInst"].includes(k)) ensureInstruments(neededInsts());
  paintAll(); if (k === "liveInst") refreshMidi(); return true; }

function cantPlay(){ setStatus("Can't play yet: " + missingLabels(filesFor(neededInsts())).join(", ") + " didn't load. Press Retry in the samples line."); }
async function tapStart(){ ui.tap.classList.add("hide"); await ensureCtx(); const ok = await ensureInstruments(neededInsts()); listDevices(); if (!ok) { cantPlay(); return; } setStatus("Audio on. Press ▶ Play loop to hear the melody with chords under it, or ● Record to sing your own."); }
function bind(){ for (const id of ["status", "load", "play", "rec", "pos", "takes", "cells", "roll", "editor", "why", "styles", "rhythm", "abA", "abB", "match", "click", "melInst", "melSrc", "bpm", "key", "mode", "bars", "recipe", "recipeNote", "mix",
    "monitor", "lat", "recKeys", "recBed", "quant", "buy", "licState", "licKey", "licBtn", "stems", "wav", "mid", "chart", "expMel", "kbd", "audioIn", "audioOut", "audioOutNote", "midiIn", "midiOut", "midiNote", "liveInst", "micBtn", "micState", "tap", "tapBtn", "imp", "impFile", "presetBpm", "ios"]) ui[id] = $(id);
  setOpts(ui.key, NAMES.map((n, i) => [i, n]), state.keyRoot); setOpts(ui.recipe, Object.entries(RECIPES).map(([k, r]) => [k, r.name]), state.recipe);
  setOpts(ui.liveInst, LIVE_INSTS.map(k => [k, INST[k].label]), state.liveInst); setOpts(ui.melInst, MEL_INSTS.map(k => [k, INST[k].label]), state.melInst);
  ui.tapBtn.onclick = tapStart;
  ui.play.onclick = async () => { await ensureCtx(); ui.tap.classList.add("hide"); if (play) { stop(); return; } if (await ensureInstruments(neededInsts())) start(); else cantPlay(); };
  ui.rec.onclick = async () => { await ensureCtx(); ui.tap.classList.add("hide"); if (rec) { stop(); return; } if (await ensureInstruments(neededInsts())) startRec(); else cantPlay(); };
  ui.bpm.onchange = () => setSetting("bpm", ui.bpm.value); ui.key.onchange = () => setSetting("keyRoot", +ui.key.value); ui.mode.onchange = () => setSetting("mode", ui.mode.value);
  ui.bars.onchange = () => setSetting("bars", +ui.bars.value); ui.recipe.onchange = () => setSetting("recipe", ui.recipe.value); ui.presetBpm.onclick = () => setSetting("bpm", RECIPES[state.recipe].bpm);
  ui.rhythm.onchange = () => setSetting("rhythm", +ui.rhythm.value);
  $("varBtn").onclick = () => setSetting("variation", state.variation + 1); $("varReset").onclick = () => setSetting("variation", 0);
  $("unlockAll").onclick = () => { setSetting("locks", {}); setStatus("All chords unlocked: UnderKit picks every bar again."); };
  ui.abA.onclick = () => setSetting("listen", "A"); ui.abB.onclick = () => setSetting("listen", "B");
  ui.click.onchange = () => setSetting("click", ui.click.checked); ui.melInst.onchange = () => setSetting("melInst", ui.melInst.value); ui.melSrc.onchange = () => setSetting("melSrc", ui.melSrc.value);
  ui.monitor.onchange = () => { state.monitor = ui.monitor.checked; saveMix(); if (mic) mic.mon.gain.setTargetAtTime(state.monitor ? 1 : 0, ctx.currentTime, 0.01); paintMicState(); };
  ui.lat.oninput = () => { state.latFixMs = +ui.lat.value; saveMix(); paintInput(); }; ui.recKeys.onchange = () => { state.recordKeys = ui.recKeys.checked; saveMix(); };
  ui.recBed.onchange = () => { state.recBed = ui.recBed.value; saveMix(); }; ui.quant.onchange = () => { state.quant = +ui.quant.value; saveMix(); };
  ui.micBtn.onclick = async () => { ui.tap.classList.add("hide"); if (mic) disableMic(); else await enableMic(); };
  ui.audioIn.onchange = async () => { state.audioIn = ui.audioIn.value; saveMix(); if (mic) { disableMic(); await enableMic(); } };
  ui.audioOut.onchange = async () => { state.audioOut = ui.audioOut.value; saveMix(); await applySink(); };
  ui.midiIn.onchange = () => { state.midiIn = ui.midiIn.value; saveMix(); refreshMidi(); }; ui.midiOut.onchange = () => { state.midiOut = ui.midiOut.value; saveMix(); refreshMidi(); };
  ui.liveInst.onchange = () => setSetting("liveInst", ui.liveInst.value);
  $("octDn").onclick = () => { state.kbdOct = Math.max(1, state.kbdOct - 1); saveMix(); paintKeys(); }; $("octUp").onclick = () => { state.kbdOct = Math.min(6, state.kbdOct + 1); saveMix(); paintKeys(); };
  const held = new Set(); const kn = e => { const i = KEYMAP.indexOf(e.key.toUpperCase()); return i < 0 ? null : state.kbdOct * 12 + 12 + i; };
  addEventListener("keydown", e => { if (e.target.matches("input,select,textarea") || e.repeat || e.metaKey || e.ctrlKey) return; if (e.code === "Space") { e.preventDefault(); ui.play.click(); return; } const n = kn(e); if (n == null || held.has(n)) return; held.add(n); liveOn(n, 0.8, "screen"); });
  addEventListener("keyup", e => { const n = kn(e); if (n == null) return; held.delete(n); liveOff(n, "screen"); });
  ui.imp.onclick = () => ui.impFile.click(); ui.impFile.onchange = async () => { if (ui.impFile.files.length) await importFiles([...ui.impFile.files]); ui.impFile.value = ""; };
  $("demoBtn").onclick = loadDemo;
  ui.expMel.onchange = () => { state.expMel = ui.expMel.checked; save(); paintExportBtns(); };
  const lockMsg = () => `Exporting ${state.bars} bars needs the unlock. Set the length to ${FREE_BARS} bars to export free; playing, recording and editing stay free.`;
  let busy = false; const run = async (what, fn) => { if (busy) { expMsg("An export is already running…", "warn"); return; } busy = true; [ui.wav, ui.mid, ui.stems, ui.chart].forEach(b => b.disabled = true); expProgress(0);
    try { await fn(); } catch (e) { console.error(e); expMsg(`${what} export failed: ${e && e.message ? e.message : e}`, "bad"); } finally { busy = false; [ui.wav, ui.mid, ui.stems, ui.chart].forEach(b => b.disabled = false); expProgress(null); } };
  const lockedLen = () => gated() && state.bars > FREE_BARS;
  ui.wav.onclick = () => { if (lockedLen()) { expMsg(lockMsg(), "warn"); return; } return run("WAV", async () => { const t0 = performance.now(); expMsg(`Rendering WAV (${state.bars} bars)…`, "busy");
    const w = await exportWavBytes({}); const r = await saveFile(w.bytes, w.name, "audio/wav");
    if (r === "downloaded" || r === "opened") expMsg(`Saved ${w.name}: ${w.frames.toLocaleString()} samples at 48 kHz / 24-bit, peak −1 dBFS, exactly ${state.bars} bars (${((performance.now() - t0) / 1000).toFixed(1)} s).${configured() ? "" : " " + LAUNCH_NOTE}`, "ok"); }); };
  ui.mid.onclick = () => { if (lockedLen()) { expMsg(lockMsg(), "warn"); return; } return run("MIDI", async () => { const m = exportMidBytes(); const r = await saveFile(m.bytes, m.name, "audio/midi");
    if (r === "downloaded" || r === "opened") expMsg(`Saved ${m.name}: chords, bass, pad, drums, chord blocks, your melody and every take as its own track, with a marker naming each chord.`, "ok"); }); };
  ui.chart.onclick = () => { if (lockedLen()) { expMsg(lockMsg(), "warn"); return; } return run("Chart", async () => { const c = exportChartBytes(); const r = await saveFile(c.bytes, c.name, "text/plain");
    if (r === "downloaded" || r === "opened") expMsg(`Saved ${c.name}: chord names, Roman numerals and Nashville numbers, bar by bar.`, "ok"); }); };
  ui.stems.onclick = () => { if (gated()) { expMsg("The stems ZIP (every part, every take and your raw voice) is part of the unlock.", "warn"); return; } return run("Stems", async () => { expMsg("Rendering stems…", "busy");
    const z = await exportStemsBytes({ blob: true, onProgress: (p, k) => { expProgress(p); expMsg(`Rendering stems… ${Math.round(p * 100)}% · ${k}`, "busy"); } }); const r = await saveFile(z.blob, z.name, "application/zip");
    if (r === "downloaded" || r === "opened") expMsg(`Saved ${z.name}: ${z.files.length} files, ${(z.blob.size / 1048576).toFixed(1)} MB.${configured() ? "" : " " + LAUNCH_NOTE}`, "ok"); }); };
  ui.licBtn.onclick = async () => { const key = ui.licKey.value.trim(); if (!key) { ui.licState.textContent = configured() ? "Paste your license key first." : "Checkout opening soon. License keys can't be checked until the store is live."; return; } ui.licState.textContent = "Checking…"; try { const r = await activateKey(key); if (r.ok) { Object.assign(lic, { valid: true, key, instance: r.instance }); saveLic(); paintLicense(); } else ui.licState.textContent = r.reason; } catch (e) { ui.licState.textContent = "Couldn't reach Lemon Squeezy. Try again."; } };
  ui.ios.hidden = !isIOS(); }

async function boot(){ bind(); paintAll();
  const rows = await idb.all(); for (const r of rows || []) voiceData[r.id] = { sr: r.sr, data: r.data }; paintTakes(); paintListen();
  if (navigator.requestMIDIAccess) { try { midiAccess = await navigator.requestMIDIAccess({ sysex: false }); midiAccess.onstatechange = refreshMidi; refreshMidi(); } catch (e) { ui.midiNote.textContent = "MIDI access was blocked. The on-screen keys below still play."; } }
  else ui.midiNote.textContent = "This browser has no Web MIDI (Safari). Use Chrome or Edge for a MIDI keyboard; the on-screen keys below still play.";
  listDevices(); ensureInstruments(neededInsts());
  if (lic.valid && lic.key && configured()) validateKey(lic.key, lic.instance).then(ok => { if (!ok) { lic.valid = false; saveLic(); paintLicense(); } }).catch(() => {}); }

// test hook for QA (same code paths as the UI)
window.__underkit = { state, setSetting, ensureCtx, start, stop, startRec, exportWavBytes, exportMidBytes, exportChartBytes, exportStemsBytes, saveFile, trySave, paintAll, gated, configured, renderMix, importFiles, harmonize, harm, melody, detectKey, transcribe, pitchFrames, enableMic,
  ready: () => loading.size === 0 && Object.keys(bufs).length > 0 && missingLabels(filesFor(neededInsts())).length === 0, play: () => play, active: () => active.size, liveVoices: () => liveVoices.size, sustainOn: () => sustain, INST, KIT, SAMPLES, bufs: () => Object.keys(bufs).length, latencyS, ctx: () => ctx, measureStopSilence, missingLabels, neededInsts, filesFor, liveOn, liveOff, setSustain, onMidi, lic, LEMON, playing: () => !!play, recording: () => !!rec,
  makeupAB, voiceData, chordsNow, bandEvents, loadDemo,
  async importBytes(b64, name, type){ const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i); return importFiles([new File([u], name || "take.wav", { type: type || "audio/wav" })]); } };
boot();
