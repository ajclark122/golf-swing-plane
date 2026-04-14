# Golf Camera Lines (iPhone)

Single-page web app that shows the iPhone **front camera** and lets you add/move/delete multiple alignment lines over the live video.

## Install as a web app (recommended)
1. Open the app URL in Safari.
2. Tap **Share** → **Add to Home Screen**.
3. Launch it from your home screen (more full-screen, fewer Safari UI distractions).

## Why this must be hosted
iPhone camera access (`getUserMedia`) requires **HTTPS**. It will not reliably work from:
- `file://` (opening an HTML file from the Files app)
- `http://192.168.x.x` (plain HTTP on your LAN)

GitHub Pages works well because it provides HTTPS automatically.

## Usage
- Tap **Start camera** (it becomes **Stop camera**)
- Choose **Front** or **Side** view (each view saves its own lines)
- Tap **Add line**
- Tap a line to select it
  - Drag endpoint handles to rotate/resize
  - Drag the body to move the whole line
- Tap **Delete** to remove the selected line
- Tap **Record** for a 5s countdown, then **Stop** to finish (download saves with overlays)

Lines persist via `localStorage` on your phone.

