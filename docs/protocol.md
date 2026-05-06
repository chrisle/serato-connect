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
│ Application: OSC 1.1 messages                   │
│   (path string + type-tag + args)               │
├─────────────────────────────────────────────────┤
│ Framing: 4-byte big-endian length prefix        │  [unverified — oscpack default]
│   per OSC packet over a single TCP stream       │
├─────────────────────────────────────────────────┤
│ Transport: TCP                                  │
├─────────────────────────────────────────────────┤
│ Discovery: mDNS / Bonjour                       │
│   service type: _SeratoIOSRemote._tcp           │
└─────────────────────────────────────────────────┘
```

### 1.1 OSC encoding

Standard OSC 1.1: each message is a 4-byte-aligned blob containing

1. The address pattern (null-terminated, padded to 4-byte boundary)
2. The type-tag string starting with `,` (e.g. `,if`, `,is`, `,ifff`)
3. Arguments in the order/types declared by the type-tag

Type tags used by this protocol:

| Tag | Type | Used by |
|---|---|---|
| `i` | int32 | deck index |
| `f` | float32 | most numeric values (positions, faders, BPM, booleans-as-float) |
| `s` | string | track title, artist, file path |

### 1.2 TCP framing **[unverified]**

OSC packets are most likely framed with a 4-byte big-endian length prefix
(this is `oscpack`'s default mode for TCP and matches the "Packet" naming in
the implementation). To be confirmed by inspecting the byte stream.

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
(observed: source ports `:65170` and `:65171` both connecting to the same
`:65161` listener). The reason for the dual channel is **[unverified]**;
hypotheses:

1. Distinct channels for legacy `/Status/Deck/...` vs. modern
   `/Status/ACI/...` topic schemes (see §5.1.1).
2. Read-only status channel + bidirectional control channel.
3. Two transceiver instances, each scoped to a subsystem.

A `serato-connect` server implementation should accept multiple inbound
connections from the same peer and treat each as an independent OSC
stream (each with its own framing state).

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

| Path | Type tag | Purpose |
|---|---|---|
| `/StreamMgmt/Authorize/Request` | **[unknown]** | Requests authorization. Direction **[unverified]** — likely Serato → remote on connect. |
| `/StreamMgmt/Authorize/Response` | **[unknown]** | Authorization result. |

**[unknown]** — argument shape, whether any token/secret is exchanged, and
whether the user is prompted on the Serato side to confirm a new pairing.

### 3.2 Pairing

| Path | Type tag | Purpose |
|---|---|---|
| `/StreamMgmt/Pairing/Pair` | **[unknown]** | Initiates a pairing session. |
| `/StreamMgmt/Pairing/StatusChanged` | **[unknown]** | Notifies the peer of pairing-state transitions. |
| `/StreamMgmt/Pairing/UnPair` | **[unknown]** | Tears down the pairing cleanly. |

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

The `/Ping` message is exchanged periodically to confirm liveness.
Direction and cadence are **[unknown]**.

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

**[unknown]** — whether `deckIndex` is 0-based or 1-based. The
`/Register/...` companion paths exist for all four topics above.

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
/authorise        ← [unknown] — British-spelled; may be a legacy/alternate
                    handshake path. Purpose and direction unconfirmed.
```

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
/Register/Status/Deck/Song/Title
/Register/Status/Deck/Song/Artist
/Register/Status/Deck/Song/Filepath
/Register/Status/Deck/Song/Valid
/Register/Status/Deck/Loop/AutoLoopOn
/Register/Status/Deck/Loop/BeatLength
/Register/Status/Deck/Loop/LoopRollOn
/Register/Status/Video/Deck/Mixer/Upfader
/Register/Status/Video/Mixer/Crossfader
```

### 5.3 Status push

```
/Status/Deck/Playhead
/Status/Deck/Song/Title
/Status/Deck/Song/Artist
/Status/Deck/Song/Filepath
/Status/Deck/Song/Valid
/Status/Deck/Loop/AutoLoopOn
/Status/Deck/Loop/BeatLength
/Status/Deck/Loop/LoopRollOn
/Status/Video/Deck/Mixer/Upfader
/Status/Video/Mixer/Crossfader
```

---

## 6. Decks

The protocol supports up to **4 decks**, addressed by integer index. The
indexing convention (0-based vs. 1-based) is **[unverified]**.

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
          read 4-byte length prefix [unverified]
          read N bytes
          parse OSC message
          dispatch on path → typed event
     e. respond to /Ping promptly; track liveness.
4. on Serato disconnect, clean up subscriptions.
```
