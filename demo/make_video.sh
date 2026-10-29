#!/usr/bin/env bash
# Trims the screen capture to the moment Play was pressed and lays the app's exported WAV under it. Captions only: no voice-over, no generated audio.
set -euo pipefail; cd "$(dirname "$0")"
V=$(python3 -c "import json;print(json.load(open('marks.json'))['video'])"); P=$(python3 -c "import json;print(json.load(open('marks.json'))['play'])"); A=$(python3 -c "import json;print(json.load(open('marks.json'))['wav'])")
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf; OUT=${1:-underkit-demo.mp4}
cap(){ echo "drawtext=fontfile=$FONT:text='$1':fontsize=34:fontcolor=white:box=1:boxcolor=0x0e1013cc:boxborderw=14:x=(w-text_w)/2:y=h-92:enable='between(t,$2,$3)'"; }
VF="$(cap 'Got a melody but no chords?' 0 3.6),$(cap 'UnderKit finds the chords under it, bar by bar' 3.6 7.2),$(cap 'Fit + sure for every bar. Swap or lock any chord.' 7.2 12.4),$(cap 'Real-sample band. WAV, MIDI, chord chart, stems.' 12.4 16.6),$(cap 'underkit.vercel.app  -  \$19 once' 16.6 21)"
ffmpeg -loglevel error -y -ss "$P" -i "$V" -i "$A" -t 21 -map 0:v -map 1:a -af "adelay=110|110" -vf "$VF,format=yuv420p" -r 30 -c:v libx264 -crf 20 -preset medium -c:a aac -b:a 192k -shortest -movflags +faststart "$OUT"
ffprobe -v error -show_entries stream=codec_type,codec_name,duration -of compact "$OUT"
