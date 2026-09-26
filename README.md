# Aurora Lyrics

A Spicetify extension: full-screen, animated, synced lyrics for Spotify Desktop.

![Aurora Lyrics](docs/preview.png)

A full-screen, animated, synced lyrics overlay for Spotify Desktop.

- **Background:** the album art slowly drifts and rotates behind the lyrics, with film grain to avoid banding. The art is blurred as a 256 px thumbnail and scaled up, which keeps the GPU cost low. Album-colour gradient and solid backgrounds are also available.
- **Flow motion (default):** lines move in a staggered spring wave. The leading line moves first and the rest follow a few milliseconds apart. Nearby lines get depth-of-field blur.
- **Other styles:** Slide (smooth scroll), Scale (springy zoom), Fade (3-line carousel), and Cinematic (one big line that blurs in).
- **Now Playing panel card:** Spotify's "Lyrics preview" card in the right-hand Now Playing panel is replaced with ours: all six sources, synced and auto-scrolling, word fill, tinted from the album, click a line to jump, click the card (or ⤢) to open fullscreen. Turn it off in Settings → General → Interface to get Spotify's card back.
- **Translation:** press **T** or the 文A button (bottom-left) to show a translation under every line, in your Spotify language or any language picked in Settings → Sources → Translation. Only unique, foreign lines are translated (a mixed K-pop song won't repeat its English lines; a song already in your language just says so). Also shown in the Now Playing card. Uses Google's free Chrome-dictionary translation endpoint; results are cached per song.
- **Hover a line** to bring it into focus: it sharpens, a soft highlight appears behind it, and its timestamp shows. Click to jump there.
- **Seven layouts** (Settings → Look → Layout), with a cross-fade when you switch:
  - **Split** (default): big cover and track info beside the lyrics. The cover steps back when paused, and clicking it plays or pauses.
  - **Mirrored**: the same, with the cover on the right.
  - **Poster**: the cover bleeds edge to edge down the left and dissolves into the background, with large title text over it.
  - **Vinyl**: the cover becomes the label of a record that spins while playing, with grooves and a still light reflection.
  - **Stage**: small cover and info across the top, lyrics centred below.
  - **Captions**: big centred cover with only the current and next line underneath, like subtitles.
  - **Lyrics only**: just the words, with small track info in the corner.

  Wide layouts need at least 900×540 and Stage/Captions at least 600px of height; smaller windows fall back to lyrics only.
- **Word-by-word animation** in five styles: **Fill** (smooth sweep), **Glow** (word lights up), **Pop** (springy bounce), **Rise** (words float into place), and **Letters** (a letter-by-letter wave). Held words swell and glow. Background vocals appear as a smaller line under the main one and fill in time with it. Instrumental breaks show three dots that fill up over the gap.
- **Estimated word timing** (optional) spreads each line's time across its words, so word animations also work on line-synced lyrics. Estimated timing is labelled *est. words*.
- **Typography:** Spotify Mix, System, Inter, Outfit, Rounded, and Serif fonts. Four weights. Pure-white text or a tint taken from the album colours.
- **Transitions:** lyrics cross-fade on track change and rise in with a stagger around the current line. Use the mouse wheel to browse the lyrics; the view returns to the current line after 3 s.
- **Player:** three zones on one baseline: lyrics source + timing offset (left), a floating player with a hover-preview progress bar, shuffle / previous / play-pause / next / repeat (centre), and like / volume / settings / fullscreen / close (right). It auto-hides with the cursor, leaving only a hairline progress line.
- **State screens** built around the album cover: loading, no lyrics (with an *Import lyrics* button), instrumental, and error (with *Try again*).
- **Lyrics formats:** LRC and enhanced LRC, including `[ti] [ar] [al] [by] [offset]` tags, repeated timestamps, and gaps. Unsynced lyrics auto-scroll.
- **Six lyrics sources**, reorderable and switchable in settings. Four of them can deliver word-by-word timing:

  | Source | Timing | How it's reached |
  | --- | --- | --- |
  | Apple Music (Paxsenix) | **word/syllable**, background vocals, duets | iTunes Search finds the Apple track (validated), then the community Paxsenix API returns Apple's lyrics; both called directly |
  | Musixmatch | **word** (richsync), line, plain | mobile API through the CORS proxy with a free token (the tokenless desktop API returns a decoy song, so it is never used) |
  | Spotify | line (rarely syllable) | Spotify's lyrics endpoint, called directly with your session token |
  | NetEase | **word** (YRC), line | NetEase Cloud Music's API, through the CORS proxy |
  | LRCLIB | line, plain | open community database, called directly |
  | Unison | **word** (TTML, with background vocals) | better-lyrics community database, called directly |

  The ✎ panel's *Load lyrics from* list shows what each source returned for the current track (word sync, line sync, no lyrics, unreachable, busy). Your imported lyrics always come first, then the cache, then the sources in your order. The first usable result is shown right away. The search continues until it finds the quality you asked for (*Keep searching until*: word sync by default), and the display upgrades in place when it does. You can also pick a source for a single track under **✎ → Load lyrics from**, and that choice is remembered.
- **Settings** apply live and persist. The panel has an icon rail with five pages (Lyrics, Look, Motion, Sources, General), a search box that filters settings across all pages, and uses segmented controls, style cards, font tiles, and filled sliders. It opens below Spotify's window controls. Reduced motion follows the system setting or can be forced on or off.

## Install

Needs [Spicetify](https://spicetify.app) (tested with CLI 2.45.1 / Spotify 1.3.2) and, optionally, Node 18+ to rebuild.

```powershell
.\install.ps1
```

The script builds `dist/`, copies it to `%APPDATA%\spicetify\Extensions`, enables it, and runs `spicetify apply`, which restarts Spotify.

To install manually:

```powershell
node build.mjs
Copy-Item dist\aurora-lyrics.js "$(spicetify path userdata)\Extensions\"
spicetify config extensions aurora-lyrics.js
spicetify apply
```

### Disable / uninstall

```powershell
.\install.ps1 -Uninstall
# or manually:
spicetify config extensions aurora-lyrics.js-
spicetify apply
```

## Use

| Action | How |
| --- | --- |
| Open / close | Top-bar or play-bar lyrics button, or **Alt+L** |
| Close | **Esc** (closes the settings panel first, if it's open) |
| Offset −/+100 ms | `[` / `]`, or the buttons in the control bar. Click the value to reset it. |
| Fullscreen | **F**, or the control-bar button |
| Translate | **T**, or the 文A button next to the source chip |
| Seek | Click a lyric line, or click/drag the progress bar (←/→ when it's focused) |
| Browse lyrics | Mouse wheel. Returns to the current line after 3 s or on Esc. |
| Play / pause / skip, shuffle, repeat | Player at the bottom centre (the dot under shuffle / repeat shows they are on; repeat-one shows a "1") |
| Like, volume | Bottom right (hover the speaker for the volume slider; click it to mute) |
| Lyrics source, reload, import | Click the source chip bottom-left (opens *This track*) |
| Import lyrics | ✎ button → paste text or import an `.lrc`/`.txt` file → *Save for this track* |
| Choose the source for this track | ✎ button → *Load lyrics from* (Auto = search all) |
| See what every source returns | ✎ button → *Test all sources* (or `FullscreenLyrics.testSources()` in DevTools). Ignores on/off switches; changes nothing. |
| Play / pause (split view) | Click the big cover |

Offset sign: **+** shows lyrics **earlier**, which matches the LRC `[offset:]` convention.

From DevTools (`spicetify enable-devtools`) you can also call `FullscreenLyrics.open()`, `.close()`, or `.toggle()`.

## Develop

```text
src/
  main.js        entry: waits for Spicetify, injects CSS, buttons, player listeners
  overlay.js     overlay controller: DOM, playback loop, lyric loading, settings → CSS
  view.js        LyricsView: renders lines, active-line/word tracking, layouts
  panel.js       settings drawer (generated from the schema) + lyrics import editor
  npv.js         lyrics card in Spotify's Now Playing panel (replaces Spotify's preview card)
  translate.js   line-by-line translation (batched, aligned, cached)
  providers.js   Spotify + LRCLIB providers, registry, and the resolver (quality tiers, progressive upgrades, pinning)
  net.js         fetch / CORS-proxy / Spotify-auth helpers (no CosmosAsync for third-party hosts)
  sources.js     Musixmatch, NetEase, and Unison network code (tokens, backoff, matching)
  formats.js     pure converters: Musixmatch richsync, NetEase YRC, TTML
  lrc.js         lyrics model, LRC / enhanced LRC / plain parsers, word-timing estimator, LRC serializer
  cache.js       LRU lyrics cache (TTL + negative cache) and imported-lyrics store
  settings.js    settings schema, defaults, validation, persistence
  storage.js     Spicetify.LocalStorage → localStorage → memory fallback
  player.js      defensive wrappers for Spicetify.Player (track info, position)
  icons.js       inline SVG icons
  util.js        helpers
  styles.css     all styles (inlined into the bundle at build time)
build.mjs        zero-dependency bundler → dist/aurora-lyrics.js
test/            node:test unit tests (parsers, formats, providers, resolver)
dev/             browser preview harness with a mocked Spicetify
install.ps1      install / uninstall helper
```

```powershell
npm test                    # unit tests
node build.mjs              # build once
npm run preview             # http://localhost:5178/dev/preview.html (mock Spotify, no install needed)
                            # add ?loop to repeat the current mock track instead of auto-advancing

# Live development inside Spotify:
node build.mjs --watch --out "$(spicetify path userdata)\Extensions"
spicetify watch -e          # reloads Spotify when the extension file changes
```

The sources are ES modules so the tests can import them directly. The build strips `import`/`export` and concatenates the files into one IIFE, because Spicetify loads an extension as a single classic script. Top-level names must be unique across `src/` files; the build checks this.

## Manual test checklist

- [ ] Alt+L and both buttons open and close the overlay. Esc closes it, and Spotify's UI is unaffected afterwards.
- [ ] A synced track: the active line follows playback. Seek forward and back, and pause/resume: the right line stays active.
- [ ] Track change while open: the background cross-fades and the lyrics reload. Track change while closed: fresh lyrics appear on open.
- [ ] Repeat-one: lyrics restart at the top when the track loops.
- [ ] A track with only unsynced lyrics: plain text auto-scrolls. Scrolling manually pauses auto-scroll for about 5 s.
- [ ] A track with no lyrics shows "No lyrics found for this track." A podcast episode shows the "not available" message.
- [ ] Offset buttons and `[` `]` shift timing. The value persists after restarting Spotify.
- [ ] Each animation style, alignment, font size, spacing, blur, darkening, and background style updates live.
- [ ] Turning *Show previous/next lines* off leaves only the active line.
- [ ] Reduced motion set to *Always*: no sliding or scaling, only short fades.
- [ ] Controls hide after inactivity and reappear on mouse move. Pin keeps them visible.
- [ ] Import an `.lrc` with `[offset:]` and word tags: the source shows *Imported · word-synced*, and *Remove imported* reverts to the online source.
- [ ] Turn off every source: an explanatory message appears. Reload bypasses the cache.
- [ ] On a popular song, the source chip shows a word-sync source (usually Musixmatch). On a song with only line sync, the lyrics appear quickly and may upgrade a moment later.
- [ ] ✎ → *Load lyrics from* → pick a source. That source sticks after reopening. *Auto* goes back to the normal search.
- [ ] Try each word animation (Fill, Glow, Pop, Rise, Letters) on a word-synced song. Turn on *Estimate word timing* for a line-synced one.
- [ ] Split view: the cover shrinks when paused, clicking it toggles playback, and a narrow window falls back to lyrics only.
- [ ] Resize the window from very narrow to large: lines wrap and stay centered on the anchor.
- [ ] Fullscreen button / F enters and leaves fullscreen. Closing the overlay exits fullscreen.

## Known limitations

- **Spotify's lyrics endpoint is internal.** `spclient…/color-lyrics/v2` is undocumented and can change or be region/account-restricted. The extension falls back to LRCLIB, and to your imported lyrics.
- **Why not CosmosAsync.** On Spotify 1.3.x, Spicetify 2.45.1 sends every `CosmosAsync` request to Spotify's native resolver, which throws "Resolver not found" for non-Spotify hosts, and it drops custom headers. The extension therefore uses `fetch()` directly for hosts that allow cross-origin requests, and Spicetify's CORS proxy (`cors-proxy.spicetify.app`, or your `spicetify:corsProxyTemplate`) for hosts that don't: NetEase and the Musixmatch mobile API.
- **Unofficial APIs.** Musixmatch, NetEase, and Unison are used the way community lyrics apps such as lyrics-plus and ivLyrics use them. None is an official partner API, so any of them can change, rate-limit, or disappear. Rate-limited sources are skipped quietly for a few minutes and the next source is tried; you only see an error if nothing could be reached.
- **Wrong-song protection.** Every Musixmatch, NetEase, and LRCLIB result is checked against the playing track (title and artist must match, duration within a few seconds), so covers, other-language versions, and decoy responses are rejected rather than shown.
- **Musixmatch needs a token.** Its lyrics need a token, and Musixmatch captcha-limits token requests per IP. The CORS proxy is shared by all Spicetify users, so tokens sometimes can't be obtained. In that case Musixmatch is skipped for 15 minutes and the next source is used. If you use lyrics-plus, its saved token is reused.
- **Word sync coverage varies.** Musixmatch richsync covers many popular songs, and NetEase covers a lot of Asian and Western catalogue. Unison is sparse. Estimated word timing is an approximation.
- **LyricsPlus was removed.** One of its servers returns a Cloudflare 530 and the other's domain no longer resolves.
- **LRCLIB is community-sourced.** Matching uses title, artist, and duration (±5 s), so occasional mismatches happen. Use Reload, or import the correct lyrics.
- **Unsynced auto-scroll is an estimate** based on track progress, not real timing.
- **The offset is global, not per track.** For a single track, import lyrics with an `[offset:]` tag.
- **Window dragging.** The overlay adds its own drag strip across the top 36 px. On some Spotify builds the native title-bar area may behave slightly differently while the overlay is open.
- Imported lyrics and the cache live in Spicetify's LocalStorage. They are per machine and not synced.
- **Web fonts** (Inter, Outfit, Rounded, Serif) come from Google Fonts. They are requested only when you hover or select one of those tiles. If Spotify blocks the request, the text falls back to a similar local font. Spotify Mix and System never touch the network.
- **Flow and depth blur** animate every line on each change. They're smooth on typical hardware; on a very weak GPU, pick *Slide* or turn *Depth blur* off.

## Ideas

- Per-track offset stored alongside the cache
- Duet colouring (TTML agents / Musixmatch performer tags)
- Translation/romanization line under each lyric
- Tap-to-sync editor for creating LRC timings from plain lyrics
- Dynamic accent color for the active line from the album palette
- Export current lyrics as `.lrc`
