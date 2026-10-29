# UnderKit

**Have a melody but no idea which chords go under it? Sing, hum or play it, and UnderKit finds the chords that fit, bar by bar.** Live: **https://underkit.vercel.app**

Record your melody on a MIDI keyboard, sing or hum it into the mic, or drop in a voice memo or a MIDI file. UnderKit turns it into notes and finds the chords that hold those notes. For every bar it shows:
- how well the chord **fits** your notes (chord tones vs. notes that rub)
- how **sure** it is (how clearly that chord beats the alternatives here)

Click any bar to swap in one of the ranked alternatives or type your own chord, then lock it. Locks always win. Then hear the melody with the chords under it on a real-sample band.

## What it does
- **Your song first:** BPM 60–180, key/mode, 4/8/16 bars, band (Ballad 68, Pop 92, Folk 100, Sparse 80). UnderKit only *suggests* a key from your notes; it never overrides yours. Everything is saved in your browser.
- **Melody in:**
  - Web MIDI keyboard (velocity, sustain pedal CC64; notes never start the transport) or on-screen/computer keys (A W S E D F T G Y H U J K).
  - Mic: YIN pitch tracking, split on pitch moves and re-attacks, snapped to 16ths/8ths or left as sung. Raw audio kept in IndexedDB.
  - Import a voice memo (WAV/MP3/M4A; a long file splits into loop-length passes) or a .mid file (top line of the busiest track).
  - Every loop pass becomes a take, and stopping mid-pass (or locking the screen) keeps the partial take; switch takes any time. While recording you hear click only, drums + click, or the band.
- **Chords under it:**
  - Four styles, all shown at once with their average fit: Simple (I IV V vi ii + V7), Pop (adds iii, sus, add9), Moody (borrowed bVI/bVII/iv), Color (7ths, secondary dominants).
  - The harmonizer weights each melody note by length, beat position and velocity, scores every candidate chord, then a Viterbi pass picks the progression that fits the melody *and* moves well. Forward-backward posteriors give the "sure" number.
  - Chord changes once per bar, twice per bar, or every 2 bars. "Try another" gives seeded (repeatable) variations.
  - The piano roll colours every note: chord tone, rub (half step above a chord tone), or passing. "Why these chords" explains each bar.
- **Listen:**
  - A/B at matched loudness: A = melody alone (Thin), B = melody + chords (Need).
  - Mixer with mute per part. Melody on a sampled instrument or your own recorded voice.
  - Click (the kit's real cross-stick sample).
  - Audio output select (`setSinkId`, with a fallback note), MIDI out (the band mirrors to your synth).
- **Export:**
  - 48 kHz / 24-bit stereo WAV at the exact loop length: downbeat at sample 0, tail folded in, peak −1.1 dBFS.
  - Type-1 MIDI: tempo, 4/4, a chord marker per bar, band tracks, a "Chord blocks" track, and the melody.
  - Chord chart (.txt): names, Roman numerals, Nashville numbers, and bar-by-bar fit/sure.
  - Stems ZIP: every band part, the melody, every take, your raw voice, plus the MIDI and chart.
  - Files are named `underkit-<style>-<bpm>bpm-<key>.wav/.mid`. On iPhone/iPad exports open the share sheet ("Save to Files").

## Sounds (real samples only)
- FluidR3_GM (MIT), pinned to gleitz/midi-js-soundfonts commit `044fab8e1456bfafc5776e86dfd6bb8697149aef` on jsDelivr, with raw.githubusercontent at the same commit as a fallback. Instruments: piano, electric piano, finger bass, strings, nylon guitar, flute, clarinet.
- Virtuosity Drums acoustic kit (CC0), bundled in `public/samples/drums`. The click is its cross-stick sample.
- There are no oscillators or noise anywhere (`qa/no_synth.sh`). If a sample host is blocked, the app names the missing instruments and keeps playback and export off.
- Demo melody: "Ode to Joy" (Beethoven), public domain. Full credits: [public/samples/CREDITS.md](public/samples/CREDITS.md).

## Pricing
- **Launch (no Lemon Squeezy product configured yet):** everything is free, at every length ("Launch: full exports free until checkout opens"). Gating switches on by itself once `LEMON.storeId` + `LEMON.productId` are set.
- **Free (once checkout is live):** record, harmonize, swap/lock chords, play; export WAV, MIDI and the chord chart up to 8 bars.
- **UnderKit license: $19 once** (no subscription). Unlocks 16-bar exports and the stems ZIP.
- **Why one-time:**
  - It's a focused tool you reach for when a melody is stuck, not a daily service.
  - It runs entirely in the browser, so there are no server or AI costs per user.
  - Songwriters on Reddit and X push back on subscriptions for single-job tools, and $19 is an easy impulse buy next to a $10/month theory app.
- **Where to sell:** Lemon Squeezy.
  - It issues license keys (the gate only accepts keys for this `storeId`/`productId`) and handles VAT and sales tax as merchant of record.
  - Gumroad also works for a one-time sale.
  - Bandcamp only makes sense bundled with a sample or MIDI pack.

## Run locally
`npm run build` copies the static files into `dist/`. Serve `dist/` with any static server (`python3 -m http.server -d dist`).

## QA
- `qa/s9.py <url>`: AUDIO-ENGINE-RULES §9 checks 1–7 plus harmony, recording (MIDI + mic), import, MIDI in/out, A/B, stems, persistence and license.
- `qa/export_test.py <url>`: WebKit iPhone 13 + Chromium downloads through the real buttons, and the iOS share sheet.
- `qa/no_synth.sh [url]`: the no-synth audit.
- `qa/fixtures/ode-flute-92bpm-C-mono16.wav` is UnderKit's own sampled-flute export of the demo melody, used as a "voice memo".

No accounts, no database, no tracking. © 2026 WorkinWithAI.
