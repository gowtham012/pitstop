#!/usr/bin/env bash
# Make the README copies of the launch video from out/pitstop-launch.mp4:
#   docs/assets/pitstop-launch.mp4          720p with sound (linked from the README)
#   docs/assets/pitstop-launch-preview.gif  a silent autoplaying loop of the best shots
set -euo pipefail
cd "$(dirname "$0")/.."
# A full ffmpeg build (Remotion's bundled one leaves out filters such as fps).
ffmpeg=$(command -v ffmpeg) || { echo "install ffmpeg first" >&2; exit 1; }
src=out/pitstop-launch.mp4
dst=../../docs/assets

"$ffmpeg" -v error -y -i "$src" -vf "scale=1280:-2,fps=30" -c:v libx264 -crf 26 -preset slow \
  -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "$dst/pitstop-launch.mp4"

# The loop: logo burst, F2 fork + dive, the fork flying home on merge.
segs="12.6:14.4 16.0:19.0 19.6:21.0 32.9:35.0"
filter=""; inputs=""; n=0
for s in $segs; do
  a=${s%:*}; b=${s#*:}
  filter+="[0:v]trim=$a:$b,setpts=PTS-STARTPTS,fps=12,scale=800:-1:flags=lanczos,hqdn3d=6:6:12:12[v$n];"
  inputs+="[v$n]"; n=$((n + 1))
done
filter+="${inputs}concat=n=$n:v=1:a=0,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
"$ffmpeg" -v error -y -i "$src" -filter_complex "$filter" -loop 0 "$dst/pitstop-launch-preview.gif"
ls -la "$dst/pitstop-launch.mp4" "$dst/pitstop-launch-preview.gif"
