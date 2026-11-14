# Epson L565 Cloud Print & Spooler System

A lightweight, modern PWA and edge spooling system designed for seamless printing to an Epson L565 all-in-one printer from any device (iOS, Android, macOS, Linux, Windows), powered by **Cloudflare Workers**, **Cloudflare KV**, and an always-on **Raspberry Pi 5** CUPS gateway.

🌐 **Live PWA App**: [https://epson-print.priyanshukh1201.workers.dev](https://epson-print.priyanshukh1201.workers.dev)

---

## 🏗️ Architecture

```
[ Mobile Phone / PWA ]
          │  HTTPS
          ▼
[ Cloudflare Workers & Static Assets ]
  - Hosts Mobile PWA (Presets, Settings, PDF Preview, Live Ink Gauges)
  - Spools temporary print files & jobs in Cloudflare KV (1-hr TTL)
          ▲
          │  Outbound HTTPS Poll + Telemetry (every 3s)
[ Raspberry Pi 5 (alarm) ]
  - Background systemd service: `epson-spooler.service`
  - Passes jobs directly to CUPS via `lp -d Epson_L565_USB`
  - Queries ink marker levels (Black, Cyan, Magenta, Yellow) & printer state
          │  USB / Wi-Fi
          ▼
[ Epson L565 All-in-One Printer ]
```

---

## 🚀 Editing the UI & Deploying from Another Machine

To make changes to the frontend or API from another computer:

### 1. Clone the repository
```bash
git clone git@github.com:priiyannshu/epson.git
cd epson
```

### 2. Make your edits
- Frontend UI & styles: `public/index.html`, `public/style.css`, `public/app.js`
- Edge API routes: `src/index.ts`
- Spooler script: `pi-agent/epson_spooler.py`

### 3. Deploy to Cloudflare
Make sure you are logged into Wrangler (`wrangler whoami`). Then deploy:
```bash
CLOUDFLARE_ACCOUNT_ID=913053598d368551936e69dd07298da5 npx wrangler deploy
```
Your changes will be live instantly across all devices.

---

## ⚙️ Features

- **PWA & Offline Shell**: Installable to iOS/Android home screens as a native-feeling app.
- **In-App Previews**: PDF multi-page canvas rendering and image previews prior to printing.
- **⚡ One-Tap Presets**:
  - `Normal B&W`: A4, Plain Paper, Monochrome, 1 copy, Fit to page.
  - `Color High`: A4, Plain Paper High Quality, Full Color.
  - `Photo 4x6`: 4x6" Borderless, Glossy Photo High Quality.
  - `Draft B&W`: A4, Plain Paper, Fast Economy Monochrome.
- **Expandable Settings**: Every Epson L565 setting (14 paper sizes, 9 media types, scaling, custom page ranges, copies).
- **Live Telemetry**: Real-time ink percentages (K/C/M/Y) and printer online/idle status.
- **Auto-Standby**: Printer sleep timer configured to 5 minutes for energy saving and silent operation.
