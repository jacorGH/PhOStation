# PhoStation

PS1 netplay in the browser, built the same way as N6PhO: the host runs the game in EmulatorJS (PCSX-ReARMed core) and streams video and audio to everyone over WebRTC. Friends send their controller input back. Up to 4 players plus any number of spectators.

## Deploy

Push this folder to a GitHub repo and turn on GitHub Pages. Open the Pages URL on your phone and use **Add to Home Screen** for fullscreen. Everything else (EmulatorJS, PeerJS, JSZip, pdf.js) loads from CDNs.

## Play

**Host:** Host a game → pick a disc → Start. Share the 5-letter code or the invite link. Friends can join before you press Start.

**Friends:** Join a room → type the code (or open the invite link) → Play or Watch.

Disc formats: `.chd` and `.pbp` are best on phones (single file, smaller). `.iso` and single `.bin` work too. `.zip`, `.7z` and `.rar` archives are unpacked once when you add them, then compressed to `.pbp` automatically, so they load fast every time after that. Readme files and other junk inside the archive are skipped. Unpacked and compressed data is written to storage as it's produced; only the archive itself has to fit in memory while it unpacks. For `.bin`/`.cue`, select the `.cue` and all its `.bin` files together. Selecting several `.cue` files builds a multi-disc playlist.

Games you pick are saved to **Your games** on that device, so next time you just tap one. Removing a game from the list doesn't touch the original file.

**Shrink** (in the games list) converts a .bin/.cue, .img or raw .iso into a compressed .pbp right on the phone. Multi-disc sets become one .pbp per disc plus a playlist. **Save** sends the .pbp to the share sheet so you can keep it in Files or give it to a friend.

**Speed** (host setup and in-game menu): Quality, Balanced, Fast, Turbo. Faster presets skip drawing frames, simplify sound effects and underclock the emulated console. If the phone's screen is limited to 30 fps (Low Power Mode), the emulator switches to its own 60 fps timer automatically.

BIOS is optional. The core's built-in BIOS runs most games, and a real BIOS (e.g. `scph1001.bin`) improves compatibility. It's remembered on the device.

## Features

- Delta-style touch pad: multitouch, slide between buttons, 8-way D-pad, optional analog sticks, haptics (Android vibration, iOS 18+ switch tick)
- Delta skin import (`.deltaskin`, PNG or PDF art). Delta has no PS1 skins, so SNES/N64/GBA skins are mapped: a→Circle, b→Cross, x→Triangle, y→Square, l/r→L1/R1, zl/zr→L2/R2. Missing shoulder buttons appear as small pills.
- Split-screen views: whole, top/bottom, left/right, quarters. With "No screen watching" on, each player only sees their own slice.
- Multitap for 3–4 player games (toggle restarts the game)
- Voice chat mesh between everyone with the mic on
- Auto-reconnect that holds your port for 2 minutes
- Connection stats (ping, fps, stream tier) and automatic stream quality per player, or a fixed tier
- Save states (3 slots + quick save) with picture previews, restart, fast forward, and the full EmulatorJS menu on request
- Autosave every 3 minutes and whenever the app goes to the background. Starting a game offers to pick up where you left off, and the home screen has a one-tap Continue for your last game.
- Pause for everyone (friends see a Paused banner). Solo games pause automatically while the menu is open.
- Hold-to-fast-forward button on the pad for the host
- Turbo buttons: pick any of Cross, Circle, Square, Triangle, L1, R1, L2, R2 to auto-repeat while held
- Controller size and opacity sliders
- Display: Sharp, Smooth, Scanlines or CRT look, and Original 4:3 or Fill screen. Works for guests too.
- GameShark cheats, saved per game
- Screenshots to the share sheet (host and guests)
- Bluetooth controllers and keyboard for guests (Z ✕, X ○, A □, S △, Q/W L1/R1, 1/2 L2/R2, Enter Start, Shift Select)

## Connections

**Room codes** use a free lobby server (PeerJS) to introduce players, then the game streams peer-to-peer.

**Direct invites** skip the lobby entirely, like old Hamachi/LAN setups where you swapped IP addresses. The host taps Direct invite and sends the link; the friend opens it and sends back a reply code; the host pastes it and you're connected. The codes contain each side's IP addresses and ports, and WebRTC punches through both NATs. Works on the same Wi-Fi (LAN) or across the internet. Each invite is for one friend; if a direct link drops, make a new invite (their port is held for 2 minutes). Invites are about 680 characters (about 900 with relay logins) and replies about 240.

**The host is the broker.** Once friends are connected, the host passes connection messages between them, so voice chat is a full mesh (everyone hears everyone) with no lobby server, whether friends joined by room code or direct invite.

**Your own relay.** Settings > Your relay sets up a TURN relay just for you: a free Cloudflare Worker (1,000 GB a month free) or your own server with `relay/setup-coturn.sh`. See `relay/README.md`. With sharing on, invites carry short-lived relay logins so friends on strict networks can connect too.

**Check my connection** (Settings, host setup, join screen, in-game menu) tests the lobby server, whether UDP peer-to-peer gets out, your NAT type (open or strict/symmetric) and your TURN relay, then explains what to do. Run it on both phones. The in-game stats show which path each connection actually took: LAN, Direct, or Relay.

## Good to know

- Discs are written straight into the emulator without extra copies, so a game needs about its own size in memory. If the page ever restarts mid-load, the app tells you where it stopped. On iPhone that means Safari ran out of memory, and a `.chd` or `.pbp` copy of the disc fixes it.
- If friends get stuck on "Connecting", run the connection check on both phones. If either side is Strict or Blocked, set up your free relay (Settings > Your relay).
- The host should keep PhoStation in the foreground. iOS pauses background tabs, which freezes the game for everyone.
- Turning on the mic on iPhone can switch iOS into call audio mode, which makes game sound quieter. That's an iOS behavior.
- If a game ignores the analog stick, open the menu → Show emulator menu → Settings and set the controller type to DualShock.
- Multitap core option names vary across PCSX-ReARMed versions. If players 3–4 don't respond, check Multitap in the emulator menu's Settings.
- The split view is a display crop, so the full frame is still sent to each guest.

## Files

```
index.html          app shell
css/app.css         styles
js/boot.js          capture/audio hooks, prefs, storage (loads before EmulatorJS)
js/library.js       saved games (IndexedDB + private files)
js/shrink.js        .pbp conversion controller
js/unpack.js        .zip/.7z/.rar unpacking
js/disk-worker.js   writes unpacked files to storage
js/spill.js         streams big files to storage (private files or IndexedDB)
js/pbp-worker.js    .pbp encoder (runs in a background worker)
js/emu.js           EmulatorJS wrapper, input injection, save states, split-view math
js/controls.js      touch pad, Delta skin layout, gamepad, keyboard, haptics
js/delta.js         .deltaskin importer
js/net.js           PeerJS host/guest, voice, reconnect, quality
js/direct.js        direct invites (compact code exchange, no lobby)
js/mesh.js          voice mesh brokered by the host
js/ice.js           STUN/TURN servers, your relay, shared relays
relay/              Cloudflare Worker, coturn setup script, relay guide
js/nettest.js       connection check
js/app.js           screens and menu
sw.js, manifest     PWA
```
