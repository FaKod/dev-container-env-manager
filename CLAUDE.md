# DevEnv Manager — Claude Code Notes

## Environment

ARM64 (aarch64) Linux container. Node.js is **not** pre-installed.

## Required system packages

Install everything in one shot:

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Electron runtime dependencies
sudo apt-get install -y \
  libnspr4 libnss3 \
  libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libatspi2.0-0 libdrm2 \
  libgtk-3-0 libasound2t64

# node-pty build tools
sudo apt-get install -y python3 make g++

# Cross-compiler for building the x64 AppImage from ARM64
sudo apt-get install -y gcc-x86-64-linux-gnu g++-x86-64-linux-gnu
```

## Post-install steps

After `npm install`, fix the Electron sandbox binary and rebuild node-pty:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
node_modules/.bin/electron-rebuild -f -w node-pty
```

## Running

```bash
npm run dev        # dev mode (hot-reload)
npm run build      # production JS bundle only → out/
npm run dist       # x64 AppImage (always, cross-compiled via gcc-x86-64-linux-gnu)
```

To launch a built AppImage in a container (no display server required for testing):

```bash
"dist/FaKods Legendary DevContainer Manager-1.0.0.AppImage" --no-sandbox
```

`--no-sandbox` is only needed in containers where `chrome-sandbox` cannot be owned by root. Not needed on a normal desktop install.

## AppImage target

`npm run dist` always builds the **x64** AppImage using the cross-compiler (works from any host arch).
Output lands in `dist/`.
