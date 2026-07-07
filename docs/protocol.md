# Serato Remote Protocol

A specification of the OSC-over-TCP protocol Serato DJ Pro uses to expose
real-time deck, track, and mixer state to local-network peers. Originally
designed for the (now-discontinued) **Serato Remote** iOS application, the
protocol remains live and is consumed by third-party integrations such as
external lighting controllers.

> **Status legend.** Statements without qualifiers are confirmed by direct
> evidence. **[unverified]** marks behavior that is strongly inferred but
> awaiting empirical confirmation. **[unknown]** marks gaps we have not yet
> filled.

---

## 1. Transport stack

```
┌─────────────────────────────────────────────────┐
│ Application: OSC 1.1 messages (oscpack)         │
│   (path string + type-tag + args)               │
├─────────────────────────────────────────────────┤
│ Framing: bare OSC packet + 16-byte sentinel     │  [verified — Serato 3.3.5.29]
│   per packet over a single TCP stream           │
├─────────────────────────────────────────────────┤
│ Transport: TCP                                  │
├─────────────────────────────────────────────────┤
│ Discovery: mDNS / Bonjour                       │
│   service type: _SeratoIOSRemote._tcp           │
└─────────────────────────────────────────────────┘
```

### 1.1 OSC encoding

Standard OSC 1.1 (Serato uses **oscpack** internally — confirmed by
characteristic `oscpack` error strings such as `Malformed Error Recieved`,
`invalid packet size`, and `element size must be multiple of four`
embedded in the binary). Each message is a 4-byte-aligned blob containing

1. The address pattern (null-terminated, padded to 4-byte boundary)
2. The type-tag string starting with `,` (e.g. `,if`, `,is`, `,ifff`, `,bii`)
3. Arguments in the order/types declared by the type-tag

Type tags used by this protocol:

| Tag | Type | Used by |
|---|---|---|
| `i` | int32 | deck index, capability flag, status flags |
| `f` | float32 | most numeric values (positions, faders, BPM, booleans-as-float) |
| `s` | string | track title, artist, file path, peer name/UUID, status enum |
| `b` | blob (4-byte length prefix + raw bytes, padded to 4-byte) | session token in `/StreamMgmt/Authorize/Request` |

### 1.2 TCP framing — bare OSC + 16-byte sentinel

Each frame on the wire is one bare OSC packet (no length prefix) followed
by a constant 16-byte sentinel:

```
<bare OSC packet>  <16-byte SENTINEL>
```

The sentinel is the same 16 bytes after every frame:

```
4c aa c2 ae 35 b1 c4 76 db 5a 64 44 03 bd 41 70
```

Verified live against Serato DJ Pro 3.3.5.29 (2026-05-05). The sentinel
appears as a hardcoded constant in the Serato binary near the
`serato::connection::USBMuxDNetworkStream` typeinfo and is consistent with
how `CocoaAsyncSocket`'s `readDataToData:` framing works (read until you
see this delimiter).

A reader must be tolerant of TCP boundary effects: the OSC packet half and
the sentinel half can arrive split across multiple `read()` calls or
coalesced into one. Parse the OSC packet by its self-describing length
(address + type-tag + typed args), then verify and consume the 16 bytes
that follow.

---

## 2. Discovery

### 2.1 Bonjour service

| Field | Value |
|---|---|
| Service type | `_SeratoIOSRemote._tcp` |
| Domain | `local.` |
| Port | dynamic; published in the SRV record |
| TXT records | **empty** — no key/value pairs are published. Serato accepts a bare advert. Any version negotiation must occur in the OSC handshake. |
| Instance name | `<peer name> @ <hostname>` (e.g. `MyApp @ studio.local`) — the literal `@` and surrounding spaces appear to be convention; uniqueness is provided by hostname suffix |

### 2.2 Roles

The "**remote**" endpoint (originally the Serato Remote iOS app; in this
library, an instance of `serato-connect`) **publishes** the Bonjour service
and accepts inbound TCP connections.

**Serato DJ Pro itself acts as the client** — it browses for
`_SeratoIOSRemote._tcp`, and when a remote advertises, Serato connects to
it and streams its state outward. This is the inverse of what the names
suggest: the DJ application reaches out to the remote, not the other way
round.

This means a `serato-connect` realtime client must:

- Run an mDNS publisher for `_SeratoIOSRemote._tcp` on a chosen TCP port
- Run a TCP server on that port, accepting Serato's inbound connection
- Drive the OSC handshake and subscription as the **server** side

### 2.3 Discovery flow

```
remote (publisher / TCP server)            Serato DJ Pro (client)
  │                                          │
  │  publishes <instance>._SeratoIOSRemote   │
  │  ._tcp.local. SRV → host:port            │
  │  TXT empty                               │
  │ ────────── mDNS announce ───────────────▶│
  │                                          │
  │                                          │ browses _SeratoIOSRemote._tcp
  │                                          │ resolves SRV
  │                                          │
  │ ◀──── TCP connect (× 2 connections) ─────│
  │                                          │
```

### 2.4 Two parallel TCP connections

Serato opens **two** TCP connections to the published port simultaneously
(observed: source ports `:52977` and `:52978` both connecting to the same
`:52976` listener). Verified (2026-05-05) the two connections have
distinct roles:

| Conn | Role | Traffic observed |
|---|---|---|
| #1 (first opened) | **Heartbeat** | only `/Ping` exchanges, every ~10 s. Likely the `BonjourServiceDiscovery` channel — the binary contains references separating ping handling from `StreamMgmt` |
| #2 (second opened) | **Control** | `/StreamMgmt/Authorize/Request`, `/StreamMgmt/Pairing/*`, and (after pairing) `/Register/...` and `/Status/...` flow here |

A `serato-connect` server implementation should accept multiple inbound
connections from the same peer and treat each as an independent OSC
stream (each with its own framing state). `/Ping` arrives on conn #1 only
in the captures so far; the implementation should still respond to it on
whichever connection it arrives on.

---

## 3. Connection lifecycle

> **Note on direction labels.** Below, "Serato" = the DJ application (TCP
> client) and "remote" = the mDNS publisher / TCP server. The
> initiating side of each handshake message is **[unverified]** — to be
> confirmed when a real session is captured.

```
remote (server)                         Serato (client)
  │                                       │
  │  ◀──────── TCP accept ─────────────── │
  │                                       │
  │  ◀── /StreamMgmt/Authorize/Request ── │   [unverified direction]
  │  ── /StreamMgmt/Authorize/Response ─▶ │
  │                                       │
  │  ◀── /StreamMgmt/Pairing/Pair ─────── │   [unverified direction]
  │  ── /StreamMgmt/Pairing/StatusChanged ▶
  │                                       │
  │  ◀── /Register/Status/<topic> (×N) ──│   [unverified direction]
  │                                       │
  │  ◀── /Status/<topic> (continuous) ── │   stream begins
  │  ◀── /Status/<topic> ───────────────│
  │  ◀── /Status/<topic> ───────────────│
  │                                       │
  │  ─── /Ping ─────────────────────────▶│   heartbeat (cadence: [unknown])
  │  ◀── /Ping ─────────────────────────│
  │                                       │
  │  ── /StreamMgmt/Pairing/UnPair ────▶ │
  │                                       │
  │  ◀── TCP FIN ──────────────────────│
```

### 3.1 Authorization

| Path | Type tag | Args | Purpose |
|---|---|---|---|
| `/StreamMgmt/Authorize/Request` | `,bii` | `(sessionToken: blob[16], ?: i, ?: i)` | Sent by Serato → remote immediately on connect #2. The blob is a 16-byte session token (likely a UUID); both ints have been observed as `1`. |
| `/StreamMgmt/Authorize/Response` | `,bii` **[unverified]** | likely echoes the same blob with status flags | Best-supported hypothesis: response mirrors the request shape. Live tests of `,bii` mirror responses (with both ints set to `1`) did not advance the handshake during the 2026-05-05 capture — Serato received the response but went silent on conn#2 within ~313 s. Possible explanations still in play: the int fields must be specific status codes (e.g. `0,0`), the blob must be transformed rather than echoed verbatim, or an additional message must follow within a tight timing window. |

The Authorize/Request format string `%b%i%i` is verified by direct
observation of the wire (and matches a corresponding constant in the
Serato binary at offset `0x1a45126` in the arm64 slice).

**Note on format-string evidence (2026-05-05):** A complete sweep of
the arm64 slice's `__cstring` section shows that Serato uses adjacent
printf-style OSC format strings for **only two** outbound messages:
`%b%i%i` next to `/StreamMgmt/Authorize/Request` and `%s%s%i` next to
`/StreamMgmt/Pairing/Pair`. All other outbound messages
(`StatusChanged`, `UnPair`, `/Ping`) are built via a typed/templated
oscpack API with no adjacent format string. The absence of a format
string adjacent to `/StreamMgmt/Authorize/Response` is therefore
**neutral** evidence — it does not prove receive-only, since Serato's
typed builder API leaves no `%`-format trace either. The receive-only
conclusion for Response is supported instead by direct observation
(Serato sent Authorize/Request both runs, never Response).

**[unknown]** — exact semantics of the two int fields. Plausible
candidates: protocol version, capability flags, peer type, error code.

**[unknown]** — whether the user is prompted on the Serato side to
confirm a new pairing. No prompt was observed during the live session,
so pairing may be implicit on first connection.

### 3.2 Pairing

| Path | Type tag | Args | Purpose |
|---|---|---|---|
| `/StreamMgmt/Pairing/Pair` | `,ssi` | `(peerName: s, peerUUID: s, isActive: i)` | Initiates a pairing session. The format string `%s%s%i` is hardcoded in the Serato binary at offset `0x1a45146`. |
| `/StreamMgmt/Pairing/StatusChanged` | `,s` **[unverified]** | `(state: s)` where state ∈ `"Paired"`, `"PairedNotActive"` | Notifies the peer of pairing-state transitions. The two enum strings `Paired` and `PairedNotActive` are present in the binary at `0x1a450b0` and `0x1a450b7` respectively; no other StatusChanged values were found. |
| `/StreamMgmt/Pairing/UnPair` | argless **[unverified]** | — | Tears down the pairing cleanly. No format string follows the path in the binary, suggesting it carries no args. |

**[unknown]** — direction of `Pair` (whether the remote initiates pairing
or Serato sends `Pair` first after Authorize/Response). The boost binding
`RemoteManagement::method(path, bool, string&, string)` matches a
4-argument handler — likely the **send** side of Pair (`isActive`,
`peerName`, `peerUUID`). The remote-side state machine for Pair has not
yet been verified end-to-end against a successful pairing.

**[unknown]** — whether pairing is one-shot per session or persistent across
restarts; whether multiple remotes can be paired simultaneously.

### 3.3 Subscription

After pairing succeeds, the remote subscribes to the topics it cares about
by sending one `/Register/Status/<topic>` message per topic. The desktop
then begins emitting `/Status/<topic>` messages whenever the underlying
state changes.

**[unverified]** — it is also possible that subscription is implicit (i.e.
the desktop sends all topics regardless), and `/Register/Status/<topic>`
serves as an opt-in filter. Verify by capturing a session that omits some
`/Register/...` paths.

### 3.4 Heartbeat

The `/Ping` message is exchanged on connection #1 (the heartbeat channel)
roughly every **10 seconds**. Verified pattern (2026-05-05):

```
Serato → remote   /Ping  (argless)
remote → Serato   /Ping  (argless, sent in reply within ~1 ms)
... 10 s pause ...
Serato → remote   /Ping
...
```

`/Ping` is **bidirectional and argless** in both directions. Either side
can send it; the receiving side replies with the same message. Verified
across 30+ exchanges spanning ~5 minutes.

**[unknown]** — the dead-peer timeout (how long without a reply before
Serato closes the connection). Captures so far show only successful
exchanges within ~1 ms latency.

---

## 4. Status messages

These are the events the desktop pushes to the remote during a paired
session. The remote opts into the topics it wants via the matching
`/Register/Status/<topic>` paths.

### 4.1 Track / song

| OSC path | Type tag | Args | Notes |
|---|---|---|---|
| `/Status/Deck/Song/Title` | `is` | `(deckIndex, title)` | UTF-8 track title |
| `/Status/Deck/Song/Artist` | `is` **[unverified]** | `(deckIndex, artist)` | UTF-8 artist string |
| `/Status/Deck/Song/Filepath` | `is` | `(deckIndex, path)` | Absolute filesystem path on the desktop machine |
| `/Status/Deck/Song/Valid` | `if` **[unverified]** | `(deckIndex, valid)` | Likely 1.0 / 0.0 boolean indicating whether the deck is currently loaded with a track |

`deckIndex` is **0-based, range 0..3** — verified by static analysis of
the arm64 slice (binary contains `Deck 0..3 change to INT mode` strings,
no `Deck 4`). All four topics have matching `/Register/Status/...`
companions.

### 4.2 Playhead

| OSC path | Type tag | Args | Notes |
|---|---|---|---|
| `/Status/Deck/Playhead` | `ifff` | `(deckIndex, ?, ?, ?)` | Live playhead position update — the most frequent message during playback |

**[unknown]** — the meaning of the three floats. Plausible candidates,
in order of likelihood:

1. `(positionSeconds, lengthSeconds, bpm)`
2. `(positionSeconds, lengthSeconds, playRate)` — where `playRate` is 1.0
   at unity, varies with pitch fader
3. `(positionBeats, beatPhase, bpm)` — beat-aligned alternative

To be disambiguated by inspecting argument values during a session where
position, length, and BPM are independently varied (e.g. load a known-length
track, scrub to a known position, change pitch).

### 4.3 Loop state

| OSC path | Type tag | Args | Notes |
|---|---|---|---|
| `/Status/Deck/Loop/AutoLoopOn` | `if` | `(deckIndex, on)` | 1.0 / 0.0 boolean |
| `/Status/Deck/Loop/BeatLength` | `if` | `(deckIndex, beats)` | Active loop length in beats (e.g. 0.25, 0.5, 1, 2, 4, 8…) |
| `/Status/Deck/Loop/LoopRollOn` | `if` | `(deckIndex, on)` | 1.0 / 0.0 boolean |

### 4.4 Mixer

| OSC path | Type tag | Args | Notes |
|---|---|---|---|
| `/Status/Video/Deck/Mixer/Upfader` | `if` | `(deckIndex, position)` | Per-deck channel fader position. Range **[unverified]** — likely 0.0–1.0. The `Video/` namespace prefix appears to be vestigial — values represent the audio channel fader. |
| `/Status/Video/Mixer/Crossfader` | `f` | `(position,)` | Crossfader position. Range **[unverified]** — likely either -1.0…+1.0 (centered) or 0.0…1.0 (left-to-right). |

---

## 5. Known and unknown OSC paths

For completeness, this is the full set of OSC address patterns currently
known to be part of the protocol.

### 5.1 Stream management (handshake)

```
/StreamMgmt/Authorize/Request
/StreamMgmt/Authorize/Response
/StreamMgmt/Pairing/Pair
/StreamMgmt/Pairing/StatusChanged
/StreamMgmt/Pairing/UnPair
/Ping
/Error/<...>      ← [unverified] — error namespace prefix appears in the
                    binary at 0x101a44fe3 alongside a "Malformed Error
                    Recieved" log string. Suffix paths and arg shapes are
                    not yet observed live.
```

> **Note**: an earlier draft of this spec listed a `/authorise` (British
> spelling) path as a mystery. That was a false alarm — the binary
> string is actually `/authorize` (American), located at `0x101a4c0e1`
> next to `https://secure.soundcloud.com` and `/oauth/token`. It is a
> SoundCloud OAuth2 endpoint, completely unrelated to the Serato Remote
> protocol.

### 5.1.1 Two parallel topic schemes

Serato DJ Pro internally has an **ACI** (action-channel) message system,
exposed on the network under three additional namespaces:

```
/Control/ACI/<id>            ← inbound controls (remote drives the DJ app)
/Register/Status/ACI/<id>    ← subscribe to ACI status by message id
/Status/ACI/<id>             ← ACI status push by message id
```

These are **[unverified]** in terms of how they relate to the
`/Status/Deck/...` and `/Status/Video/...` topics documented below.
Two plausible models:

1. **Capability negotiation** — Serato uses `/Status/Deck/...` for legacy
   peers (the original Serato Remote app, SoundSwitch) and `/Status/ACI/...`
   for newer/native peers. The choice is made during the
   Authorize/Pair exchange.
2. **Layered emit** — Serato emits both schemes in parallel; consumers can
   pick whichever they prefer.

Until a live capture confirms which messages flow on a real session, this
spec documents only the `/Status/Deck/...` and `/Status/Video/...` paths,
because they have known argument schemas (the ACI ids do not).

### 5.2 Subscription registrations

```
/Register/Status/Deck/Playhead
/Register/Status/Deck/Slicer/Loop
/Register/Status/Deck/Song/Title
/Register/Status/Deck/Song/Artist
/Register/Status/Deck/Song/Filepath
/Register/Status/Deck/Song/Valid
/Register/Status/Deck/Loop/AutoLoopOn
/Register/Status/Deck/Loop/BeatLength
/Register/Status/Deck/Loop/LoopRollOn
/Register/Status/Deck/Loop/LoopInOutPoint
/Register/Status/Deck/Loop/ManualLoopIn
/Register/Status/Deck/Loop/ManualLoopOn
/Register/Status/Deck/Loop/ManualLoopOut
/Register/Status/Deck/Loop/ManualLoopSetting
/Register/Status/Video/Deck/Mixer/Upfader
/Register/Status/Video/Mixer/Crossfader
```

### 5.3 Status push

```
/Status/Deck/Playhead
/Status/Deck/Slicer/Loop
/Status/Deck/Song/Title
/Status/Deck/Song/Artist
/Status/Deck/Song/Filepath
/Status/Deck/Song/Valid
/Status/Deck/Loop/AutoLoopOn
/Status/Deck/Loop/BeatLength
/Status/Deck/Loop/LoopRollOn
/Status/Deck/Loop/LoopInOutPoint
/Status/Deck/Loop/ManualLoopIn
/Status/Deck/Loop/ManualLoopOn
/Status/Deck/Loop/ManualLoopOut
/Status/Deck/Loop/ManualLoopSetting
/Status/Video/Deck/Mixer/Upfader
/Status/Video/Mixer/Crossfader
```

This catalog is **verified complete** against the arm64 binary
(2026-05-05) — all 16 topic suffixes appear verbatim in the
`__cstring` section, prefixed at runtime with either `/Register/` or
`/`. Additional topics may exist within the dynamic ACI namespace
(`/Status/ACI/<id>`); see §5.1.1.

---

## 6. Decks

The protocol supports up to **4 decks**, addressed by integer index
**0..3** (0-based — verified 2026-05-05 via static analysis of the
Serato binary).

Higher-level state derivable from the message stream:

| Property | Source message | Notes |
|---|---|---|
| Loaded track title | `/Status/Deck/Song/Title` | last-write-wins per deck |
| Loaded track artist | `/Status/Deck/Song/Artist` | |
| Loaded track file path | `/Status/Deck/Song/Filepath` | use to look up GEOB metadata, crate membership, etc. |
| Track loaded? | `/Status/Deck/Song/Valid` | [unverified] |
| Live position | `/Status/Deck/Playhead` | high-frequency update |
| Track length | `/Status/Deck/Playhead` (one of the floats) | [unverified] |
| BPM (current/effective) | `/Status/Deck/Playhead` (one of the floats) | [unverified] |
| Channel fader | `/Status/Video/Deck/Mixer/Upfader` | |
| Loop active? | `/Status/Deck/Loop/AutoLoopOn` | |
| Loop length | `/Status/Deck/Loop/BeatLength` | in beats |
| Loop roll active? | `/Status/Deck/Loop/LoopRollOn` | |

Mixer-wide:

| Property | Source message | Notes |
|---|---|---|
| Crossfader position | `/Status/Video/Mixer/Crossfader` | |

---

## 7. Things this protocol does **not** expose

Based on the available message set, the following data — present in
Serato's file-based outputs (history files, database, GEOB tags) — does
not appear to flow over the Remote protocol:

- Cue points, hot cues, saved loops (read from GEOB tags in the audio file)
- Beatgrid markers (read from GEOB / streaming XML)
- Crate / playlist membership (read from `_Serato_/Subcrates/`)
- Full library track list (read from `_Serato_/database V2`)
- Historical play log (read from `_Serato_/History/Sessions/`)
- Per-track key, energy, custom color (read from GEOB / database)

A complete realtime+library client therefore combines the protocol stream
with the existing file-based readers in `serato-connect`.

---

## 8. Example: minimum viable client

Because Serato DJ Pro is the TCP **client**, a `serato-connect` realtime
implementation acts as the **server**:

```
1. start mDNS publisher:
     register a service of type _SeratoIOSRemote._tcp on a chosen port,
     with an empty TXT record. Use an instance name of the form
     "<peer name> @ <hostname>".
2. start TCP listener on that port. Accept multiple connections from the
   same peer — Serato opens two parallel streams.
3. when Serato connects (per stream):
     a. on incoming /StreamMgmt/Authorize/Request, reply with
        /StreamMgmt/Authorize/Response.
     b. on incoming /StreamMgmt/Pairing/Pair, reply with
        /StreamMgmt/Pairing/StatusChanged (state = paired).
     c. on incoming /Register/Status/<topic>, record the subscription.
        [unverified — registration may flow remote → Serato instead;
         confirm with a live session.]
     d. enter receive loop:
          accumulate bytes from socket
          locate the 16-byte sentinel
            (4c aa c2 ae 35 b1 c4 76 db 5a 64 44 03 bd 41 70)
          everything before the sentinel is one bare OSC packet —
            parse it (address, type-tag, args) and dispatch on path
          discard the sentinel; resume accumulating
     e. respond to /Ping promptly; track liveness.
4. on Serato disconnect, clean up subscriptions.
```
