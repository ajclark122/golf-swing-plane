# Golf Camera Lines (iPhone)

Single-page web app that shows the iPhone **front camera** and lets you add/move/delete multiple alignment lines over the live video.

## Why this must be hosted
iPhone camera access (`getUserMedia`) requires **HTTPS**. It will not reliably work from:
- `file://` (opening an HTML file from the Files app)
- `http://192.168.x.x` (plain HTTP on your LAN)

## Deploy on GitHub Pages (private repo)
1. Create a **new private repo** (example name: `golfcam-lines`).
2. Add these files to the repo root:
   - `index.html`
   - `styles.css`
   - `app.js`
3. In GitHub, go to **Settings → Pages**:
   - **Build and deployment**: Deploy from a branch
   - **Branch**: your default branch (e.g. `main`), folder `/ (root)`
4. Wait for Pages to publish, then open the provided **`https://...`** URL on your iPhone.

## Usage
- Tap **Start camera**
- Tap **Add line**
- Tap a line to select it
  - Drag endpoint handles to rotate/resize
  - Drag the body to move the whole line
- Tap **Delete** to remove the selected line

Lines persist via `localStorage` on your phone.

