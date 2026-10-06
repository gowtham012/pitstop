# pitstop launch video

A ~51 second, 1920×1080 60 fps launch video, made with [Remotion](https://www.remotion.dev) (React, rendered frame by frame) and an original soundtrack synthesized in [`scripts/soundtrack.py`](scripts/soundtrack.py).

| Shot | Frames | What happens |
| --- | --- | --- |
| Chaos | 0–600 | One terminal becomes twenty-six; the camera pulls back through them |
| Break | 600–720 | Everything freezes: "there's a better way." |
| Vortex | 720–900 | The terminals spiral into one point; flash; the pitstop logo |
| Hero | 900–1500 | `pit` flies in, F2 forks, the camera dives into the fork |
| Branches | 1500–1860 | Two more forks, then an exploded 3D view |
| Merge | 1860–2220 | F3, the fork flies home, a shockwave, main is told |
| Montage | 2220–2580 | Twelve features, one per beat |
| Outro | 2580–3060 | Logo, promise, install |

Every cut lands on a beat (120 BPM = 30 frames). If you move a shot in `src/Video.tsx`, move the matching times in `scripts/soundtrack.py`.

## Render

```bash
npm install
python3 scripts/soundtrack.py          # writes public/soundtrack.wav (needs numpy)
npm run render                         # out/pitstop.mp4
npm run studio                         # preview and scrub in the browser
```

On a machine where Remotion can't download its own Chrome, point it at one: `REMOTION_BROWSER=/path/to/chrome npm run render`.

Remotion is free for individuals and small teams; see its [license](https://www.remotion.dev/license) before a company uses it to render. Fonts: Inter and JetBrains Mono (SIL Open Font License).
