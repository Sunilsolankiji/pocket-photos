# PocketPhotos

A self-hosted, Google Photos–style server for your photos and videos, designed to run on a
spare Android phone (e.g. **Samsung Galaxy S23 FE**) with an **external USB SSD**, serving your
whole home Wi-Fi. It also runs on any Windows/macOS/Linux machine with Node.js.

* Timeline grouped by day, infinite scroll, fast square thumbnails
* Full-screen viewer with swipe / arrow keys, video streaming with seeking (HTTP range)
* Upload from any phone or PC browser (multi-file, drag & drop, progress, duplicate detection)
* Favorites, albums, search (filename, folder, date like `2024-05` or `may`, camera model, `video`)
* Trash with automatic permanent deletion after 30 days
* Reads EXIF dates/orientation/camera, video creation time/duration, Android filename dates
* HEIC/TIFF previews converted on the fly (via ffmpeg)
* **Multiple users** with ID + password, created on a password-protected admin page that only opens on the phone itself
* **Each user only sees their own photos, videos and albums**
* **User profiles**: display name, profile photo, contact details, birthday, and personal theme / accent colour / photo size / start page
* **Access from anywhere** over HTTPS (router port forwarding, free DuckDNS address, auto-generated certificate)
* scrypt-hashed passwords, session cookies, CSRF + brute-force protection
* Installable to your home screen (PWA manifest)
* **No npm dependencies** and no native modules – only Node.js + ffmpeg, so it installs cleanly in Termux

Your files are never moved or re-encoded: PocketPhotos indexes the folders you already have
on the SSD (`DCIM/`, `Pictures/`, …). Each user's uploads are saved as originals to `Users/<user-id>/YYYY/MM/`.
Thumbnails and the index live in a hidden `.pocketphotos/` folder on the SSD.

---

## Setup on the Samsung S23 FE

### 1. Install the apps (from F-Droid, **not** the Play Store – the Play Store Termux is outdated)
* [Termux](https://f-droid.org/packages/com.termux/)
* [Termux:Boot](https://f-droid.org/packages/com.termux.boot/) – start the server automatically after a reboot (open it once after installing)
* [Termux:API](https://f-droid.org/packages/com.termux.api/) – optional (wake-lock helpers)

### 2. Connect and prepare the SSD
Plug the SSD in (USB-C, ideally with a powered hub/adapter that also charges the phone).
exFAT is the best filesystem for an SSD shared with PCs. In **My Files** you should see it as *USB storage*.

### 3. Copy PocketPhotos to the phone
Copy this whole `pocket-photos` folder to the phone (e.g. into `Download/`), then in Termux:

```sh
termux-setup-storage                     # tap Allow (grant "All files access" if asked)
cp -r ~/storage/downloads/pocket-photos ~/pocket-photos
cd ~/pocket-photos
bash scripts/termux-install.sh
```

The installer installs Node.js + ffmpeg + openssl, lists storage volumes (your SSD is `/storage/XXXX-XXXX`),
asks for the media folder, writes `config.json` and sets up auto-start.

### 4. Start it
```sh
~/pocket-photos/scripts/start.sh
```
Then open `http://<phone-ip>:8080` on any device on your Wi-Fi. The phone's IP is in
*Settings → Connections → Wi-Fi → ⚙ next to your network*.

### 5. Create users (on the phone)
Open **`http://localhost:8080/admin`** in Chrome **on the S23 FE itself**. This admin page does not
open from any other device – not on Wi-Fi and not from the internet.

On the first visit it asks you to **choose an admin password or PIN** (at least 6 characters), so
someone holding your unlocked phone can't manage users. The admin sign-in ends after 30 minutes of
inactivity (or 12 hours, or a server restart); 5 wrong attempts lock it for 15 minutes. Change it with
*Change admin password*. **Forgot it?** Stop the server and run `node server.js --reset-admin-password`,
then start the server and choose a new one (users and photos are not touched).

* **Generate user** – leave the fields empty for a random ID and a strong password, or type your own
  (e.g. `mom`). The credentials are shown once with a *Copy all* button; send them to the person.
* **Folders** – every user owns `Users/<id>/` (where their uploads go). To show photos already on the
  SSD, click *Give folder access* and pick e.g. `DCIM` or `Pictures/Family` (empty = whole drive).
  A folder belongs to one user only; a more specific folder wins (`DCIM/Camera` beats `DCIM`).
  Items in folders nobody owns are counted as *Not visible to anyone*.
* **Reset password**, **Sign out everywhere**, sign out single devices, **Delete user**
  (their files stay on the SSD).

Users sign in at `http://<phone-ip>:8080` with their **User ID + password** and can change their
own password in *Settings*.

**Profile** (tap the round avatar at the top right): each user can set a display name, profile photo
(from their own photos, or *Use as profile photo* in a photo's ⓘ info), email, phone and birthday,
and personalise the app – theme (auto/dark/light), accent colour, photo size and the page the app opens on.
The Photos page greets them by name (and wishes them a happy birthday). These details are private to the
user; the admin page only shows the display name. Signing out resets the look to the default.

> Upgrading from the single-password version? Your old password now belongs to user **`owner`**,
> who keeps access to the whole drive.

> **Tip:** reserve the phone's IP in your router (DHCP reservation) so the address never changes,
> and use "Add to Home screen" in the browser for an app-like experience.

### 6. Keep it running 24/7 (important on Samsung)
* Pull down the Termux notification → **Acquire wakelock** (the start script does this automatically).
* *Settings → Apps → Termux → Battery* → **Unrestricted** (do the same for Termux:Boot).
* *Settings → Battery → Background usage limits* → make sure Termux is **not** in sleeping / deep sleeping apps; add it to **Never sleeping apps**.
* *Settings → Battery → More battery settings* → enable **Protect battery** (limits charge to 80–85 %, great for a phone that's always plugged in).
* *Settings → Connections → Wi-Fi → ⋮ → Advanced* → keep Wi-Fi on during sleep.

### If the SSD is read-only for Termux
Android may block apps from writing to the root of USB drives. PocketPhotos detects this at
startup: it still shows your library (read-only: uploads and delete are disabled) and keeps its
thumbnails/index in Termux's home. To get full read/write access, use the folder Android always
lets Termux write to on the SSD:

```
/storage/XXXX-XXXX/Android/data/com.termux/files/Photos
```
Set that as `mediaDir` in `config.json`. ⚠️ Android deletes this folder if Termux is uninstalled –
back it up before uninstalling.

---

## Configuration
Edit `config.json` (see `config.example.json`) or use environment variables:

| Key | Env var | Default | Meaning |
|---|---|---|---|
| `mediaDir` | `PP_MEDIA_DIR` | `./library` | Root folder of photos/videos (scanned recursively; hidden folders, `Android/`, `LOST.DIR` are skipped) |
| `dataDir` | `PP_DATA_DIR` | `<mediaDir>/.pocketphotos` | Index (`db.json`), thumbnails, previews |
| `port` / `host` | `PP_PORT` / `PP_HOST` | `8080` / `0.0.0.0` | Where to listen |
| `workers` | `PP_WORKERS` | `2` | Parallel ffmpeg jobs (2 keeps the phone cool) |
| `thumbSize` / `previewSize` | | `360` / `2048` | Thumbnail / HEIC-preview size in px |
| `uploadDir` | `PP_UPLOAD_DIR` | `Users` | Per-user home folders (`Users/<id>/`) inside `mediaDir` |
| `httpsPort` | `PP_HTTPS_PORT` | `8443` | HTTPS port for access from outside (0 = off) |
| `tlsCert` / `tlsKey` | `PP_TLS_CERT` / `PP_TLS_KEY` | `<dataDir>/tls/*.pem` | Certificate files (self-signed one is created automatically; replaced files are reloaded hourly) |
| `duckdnsDomain` / `duckdnsToken` | `PP_DUCKDNS_DOMAIN` / `PP_DUCKDNS_TOKEN` | | Free dynamic address (easier to set on the admin page) |
| `publicHost` | `PP_PUBLIC_HOST` | | Your own domain, if you have one |
| `allowRemoteHttp` | `PP_ALLOW_REMOTE_HTTP` | `false` | Accept plain HTTP from the internet (not recommended) |
| `openssl` | `PP_OPENSSL` | from `PATH` | Used to create the self-signed certificate |
| `rescanMinutes` | `PP_RESCAN_MINUTES` | `15` | Automatic rescan interval (0 = off). Also via the admin page |
| `trashDays` | `PP_TRASH_DAYS` | `30` | Trash auto-empty age |
| `maxUploadBytes` | `PP_MAX_UPLOAD_BYTES` | 20 GB | Largest single upload |
| `pregenerate` | `PP_PREGENERATE` | `true` | Build all thumbnails in the background after a scan |
| `ffmpeg` / `ffprobe` | `PP_FFMPEG` / `PP_FFPROBE` | from `PATH` | Tool paths |

Numbers are checked at start-up (e.g. ports 0-65535, `workers` 1-16, `thumbSize` 64-1024,
`previewSize` 512-8192, `trashDays` 1-3650); an invalid value stops the server with a clear message
instead of silently disabling a feature. Unknown keys in `config.json` are reported as warnings.

Without ffmpeg the server still works (photos show originals as thumbnails; videos get placeholders and file dates).

## Running on a PC instead
```sh
node server.js                          # uses ./library
PP_MEDIA_DIR=/mnt/ssd/Photos node server.js
```
Requires Node.js 18.15+ (ffmpeg recommended).

## Tests
```sh
npm test        # uses ffmpeg/ffprobe/openssl from PATH (or PP_FFMPEG / PP_FFPROBE / PP_OPENSSL) when available
```

## Access from outside your home Wi-Fi
PocketPhotos runs a second, encrypted server on port **8443** (HTTPS). The admin page shows your
public IP, the exact address to use and the steps below.

1. **Fixed IP for the phone** – in your router, reserve the phone's current IP (DHCP reservation).
2. **Port forward** – router → *Port forwarding / Virtual server*: external TCP `8443` → phone IP, port `8443`.
   Forward **only 8443**, never 8080 (plain HTTP from the internet is refused anyway).
3. **Check for CGNAT** – the router's WAN/Internet IP must match the *Public IP* on the admin page.
   If the router shows `100.64–127.x.x`, `10.x` or another private address, your ISP shares one IP
   between customers and port forwarding cannot work; ask the ISP for a public IPv4 address.
4. **Free address that follows your IP (recommended)** – sign in at [duckdns.org](https://www.duckdns.org),
   create e.g. `myphotos`, and enter the sub-domain + token on the admin page. The phone updates it
   every 5 minutes. Then press *Regenerate certificate* so the name is included.
5. Open `https://myphotos.duckdns.org:8443` from mobile data, accept the certificate warning once
   (*Advanced → Proceed*), and sign in.

**No browser warning (optional):** get a free Let's Encrypt certificate with `acme.sh` in Termux:
```sh
pkg install socat curl && curl https://get.acme.sh | sh
export DuckDNS_Token="<your token>"
~/.acme.sh/acme.sh --issue --dns dns_duckdns -d myphotos.duckdns.org --server letsencrypt
~/.acme.sh/acme.sh --install-cert -d myphotos.duckdns.org \
  --fullchain-file /path/to/.pocketphotos/tls/cert.pem --key-file /path/to/.pocketphotos/tls/key.pem
```
(Paths: the *Certificate* line on the admin page.) PocketPhotos picks up renewed files automatically.

## Security notes
* The admin page and admin API answer only to requests made on the phone itself
  (`localhost`, checked by both source address and `Host` header to stop DNS-rebinding tricks),
  and additionally need the admin password (hashed with scrypt in `db.json`).
* Plain HTTP is accepted only from home-network addresses; the internet must use HTTPS, and
  cookies are marked `Secure` there.
* Passwords are hashed with scrypt; 10 wrong attempts per IP (and 60 from the whole internet)
  lock sign-in for 15 minutes. Failed attempts are listed on the admin page.
* Each user can only list, open, stream, download, change or delete items in their own folders,
  and only see their own albums. Server paths and scan details are hidden from other devices.
* Pages are served with a strict Content-Security-Policy (no inline or third-party scripts),
  `nosniff`, `frame-ancestors 'none'` and same-origin resource policy. Admin changes additionally require
  a matching `Origin` header. Photo metadata (EXIF) is type-checked before it is stored or displayed.
* Slow or stalled connections are dropped (20 s for headers, 2 min of inactivity, 30 s for JSON bodies).
* Anything exposed to the internet carries risk: use long generated passwords and keep Termux updated
  (`pkg upgrade`). A VPN such as Tailscale is the safer alternative if you don't need browser access
  for others.

## Useful notes
* Copy photos onto the SSD from a PC as usual – they appear after the next rescan.
* **Delete forever** (or trash auto-empty) deletes the original file from the SSD.
* An unplugged SSD never wipes your favorites/albums: a scan that finds zero files is ignored.
* Logs from auto-start go to `~/pocketphotos.log`.
