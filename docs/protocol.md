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
`invalid packet size`, and `element size must be multiple of four` embedded in
the binary). Each message is a 4-byte-aligned blob containing

1. The address pattern (null-terminated, padded to 4-byte boundary)
2. The type-tag string starting with `,` (e.g. `,if`, `,is`, `,ifff`, `,bii`)
3. Arguments in the order/types declared by the type-tag

Type tags used by this protocol:

| Tag | Type                                                      | Used by                                                         |
| --- | --------------------------------------------------------- | --------------------------------------------------------------- |
| `i` | int32                                                     | deck index, capability flag, status flags                       |
| `f` | float32                                                   | most numeric values (positions, faders, BPM, booleans-as-float) |
| `s` | string                                                    | track title, artist, file path, peer name/UUID, status enum     |
| `b` | blob (4-byte length prefix + raw bytes, padded to 4-byte) | session token in `/StreamMgmt/Authorize/Request`                |

### 1.2 TCP framing — OSC packet + 16-byte sentinel

Each frame on the wire is one OSC **packet** followed by a constant 16-byte
sentinel:

```
<OSC packet>  <16-byte SENTINEL>
```

An "OSC packet" is **either** a plain OSC message (`/address` + type-tag + args)
**or** an OSC bundle (`#bundle` + 8-byte time-tag + a sequence of
4-byte-size-prefixed elements). Serato uses plain messages for the handshake
(`Authorize`, `Pairing`) and **bundles for the `/Status/…` stream** — see
[§4](#4-status-messages). It also sends **argless** messages (an address with an
empty or absent type-tag section, valid OSC 1.0) during pairing.

The sentinel is the same 16 bytes after every frame:

```
4c aa c2 ae 35 b1 c4 76 db 5a 64 44 03 bd 41 70
```

Verified live against Serato DJ Pro 3.3.5.29. The sentinel appears as a
hardcoded constant in the Serato binary near the
`serato::connection::USBMuxDNetworkStream` typeinfo and matches how
`CocoaAsyncSocket`'s `readDataToData:` framing works (read until you see this
delimiter).

**Reading strategy: split on the sentinel, not by packet length.** A bundle's
total length is _not_ self-describing at the top level (there is no element
count or overall size header — it ends only where the sentinel begins), so a
reader cannot compute the frame length from the packet structure alone. Instead,
scan for the 16-byte sentinel to delimit each frame, then decode the preceding
packet — expanding a `#bundle` into its contained messages, and treating a
missing type-tag as zero args. A reader must also tolerate TCP boundary effects:
the packet and the sentinel can arrive split across multiple `read()` calls or
coalesced into one. (This is what `serato-connect`'s `FrameReader` +
`decodeOscPacket` do.)

---

## 2. Discovery

### 2.1 Bonjour service

| Field         | Value                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service type  | `_SeratoIOSRemote._tcp`                                                                                                                                              |
| Domain        | `local.`                                                                                                                                                             |
| Port          | dynamic; published in the SRV record                                                                                                                                 |
| TXT records   | **empty** — no key/value pairs are published. Serato accepts a bare advert. Any version negotiation must occur in the OSC handshake.                                 |
| Instance name | `<peer name> @ <hostname>` (e.g. `MyApp @ studio.local`) — the literal `@` and surrounding spaces appear to be convention; uniqueness is provided by hostname suffix |

### 2.2 Roles

The "**remote**" endpoint (originally the Serato Remote iOS app; in this
library, an instance of `serato-connect`) **publishes** the Bonjour service and
accepts inbound TCP connections.

**Serato DJ Pro itself acts as the client** — it browses for
`_SeratoIOSRemote._tcp`, and when a remote advertises, Serato connects to it and
streams its state outward. This is the inverse of what the names suggest: the DJ
application reaches out to the remote, not the other way round.

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
`:52976` listener). Verified (2026-05-05) the two connections have distinct
roles:

| Conn               | Role          | Traffic observed                                                                                                                                              |
| ------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 (first opened)  | **Heartbeat** | only `/Ping` exchanges, every ~10 s. Likely the `BonjourServiceDiscovery` channel — the binary contains references separating ping handling from `StreamMgmt` |
| #2 (second opened) | **Control**   | `/StreamMgmt/Authorize/Request`, `/StreamMgmt/Pairing/*`, and (after pairing) `/Register/...` and `/Status/...` flow here                                     |

A `serato-connect` server implementation should accept multiple inbound
connections from the same peer and treat each as an independent OSC stream (each
with its own framing state). `/Ping` arrives on conn #1 only in the captures so
far; the implementation should still respond to it on whichever connection it
arrives on.

---

## 3. Connection lifecycle

"Serato" = the DJ application (TCP **client**); "remote" = the mDNS publisher /
TCP **server** (`serato-connect`). Serato opens **two** parallel TCP
connections: #1 carries only the `/Ping` heartbeat; #2 carries the auth → pair →
status flow. The sequence below is **verified live end-to-end** (Serato DJ Pro
3.3.5.29, 2026-07-27).

```mermaid
sequenceDiagram
    autonumber
    participant R as serato-connect<br/>(mDNS publisher / TCP server)
    participant S as Serato DJ Pro<br/>(TCP client)

    Note over R: publish _SeratoIOSRemote._tcp<br/>(empty TXT) on chosen port
    R-->>S: mDNS announce
    Note over S: browses, resolves SRV

    rect rgb(30,60,90)
    Note over R,S: Conn #1 — heartbeat
    S->>R: TCP connect
    loop every ~10 s
        S->>R: /Ping (argless)
        R->>S: /Ping (echo)
    end
    end

    rect rgb(40,70,50)
    Note over R,S: Conn #2 — control
    S->>R: TCP connect

    Note over S: generate 16-byte nonce
    S->>R: /StreamMgmt/Authorize/Request  ,bii<br/>(nonce, 1, 1)
    Note over R: digest = MD5(nonce ‖ secret)
    R->>S: /StreamMgmt/Authorize/Response  ,ssb<br/>(peerName, peerUuid, digest[16])
    Note over S: verify digest == MD5(nonce ‖ secret)<br/>for either hardcoded secret

    S->>R: /StreamMgmt/Pairing/Pair  ,ssi<br/>("SDJ @ host", "Serato DJ", isActive=0)
    R->>S: /StreamMgmt/Pairing/Pair  ,ssi<br/>(peerName, peerUuid, isActive=1)

    loop per topic
        R->>S: /Register/Status/&lt;topic&gt;
    end

    loop live
        S->>R: #bundle { /Status/Deck/Song/Title ,is,<br/>/Status/Deck/Playhead ,ifff, … }
    end

    opt teardown
        R->>S: /StreamMgmt/Pairing/UnPair
        S-->>R: TCP FIN
    end
    end
```

Notes on the flow:

- **Auth (5–6)** is the crux: the response is `,ssb` carrying
  `MD5(nonce ‖ secret)`. A wrong shape or digest makes Serato go silent on conn
  #2 — see [§3.1](#31-authorization).
- **Mutual Pair (7–8):** Serato sends `isActive=0` first; the remote's
  `isActive=1` reply is what actually opens the stream — see
  [§3.2](#32-pairing).
- **Status (10)** arrives as OSC `#bundle` packets, each still followed by the
  16-byte frame sentinel — see [§4](#4-status-messages).

### 3.1 Authorization

| Path                             | Type tag                                | Args                                           | Purpose                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/StreamMgmt/Authorize/Request`  | `,bii`                                  | `(nonce: blob[16], ?: i, ?: i)`                | Sent by Serato → remote immediately on connect #2. The blob is a **16-byte random challenge nonce** (freshly generated per connection — not a stable UUID); both ints have been observed as `1`.                                                                                                                                                             |
| `/StreamMgmt/Authorize/Response` | `,ssb` (peerName, peerUuid, digest[16]) | `(peerName: s, peerUuid: s, digest: blob[16])` | Reply from remote → Serato. The blob **must equal `MD5(nonce ‖ secret)`** — see §3.1.1. **Verified live end-to-end (Serato 3.3.5.29, 2026-07-27):** a correct digest makes Serato proceed to pairing and begin streaming `/Status/`; a wrong one makes it go silent. The two strings are the peer's own name and UUID (contents are not part of the digest). |

The Authorize/Request format string `%b%i%i` is verified by direct observation
of the wire (and matches a corresponding constant in the Serato binary at offset
`0x1a45126` in the arm64 slice).

#### 3.1.1 The response is an MD5 challenge-response — VERIFIED LIVE

**This supersedes the earlier "response mirrors the request" hypothesis.** The
`Authorize/Response` blob is **not** an echo of the nonce — it is a keyed digest
that proves the remote knows a shared secret baked into the Serato binary. The
full mechanism was recovered by static analysis and then **confirmed live** by
hooking Serato's own digest computation and driving a real handshake to a
flowing `/Status/` stream (Serato DJ Pro 3.3.5.29, 2026-07-27).

**The rule:**

```
Authorize/Response = (peerName: string, peerUuid: string, MD5(nonce ‖ secret): blob[16])
```

where `nonce` is the 16-byte blob from `Authorize/Request` and `secret` is one
of two 32-byte constants hardcoded in the Serato binary (either is accepted).

**How Serato validates it (handler `MAIN+0xb78cfc`, comparator
`MAIN+0xb78c4c`):**

```
(name, uuid, candidate) = extract Authorize/Response args   // MUST be ,ssb; candidate is a 16-byte blob
nonce = authObject + 0x108                                  // the nonce Serato sent in Authorize/Request
for secret in secretList[authObject+0x128 .. +0x130]:       // 32 bytes each
    if candidate == MD5(nonce ‖ secret):                    // MD5: init, update(nonce,16), update(secret,32), final
        authorized = true; break
else:
    // no match → Serato never advances; conn#2 stays open but silent
```

- **The response type tag MUST be `,ssb`.** The handler reads arg0 and arg1 as
  strings (`AsString`, which throws `WrongArgumentTypeException` on any other
  type) and arg2 as a blob. Sending a bare `,b` blob throws inside oscpack arg
  iteration before the digest is ever checked — which is why every earlier
  blob-only attempt stalled. The two strings are the remote's peer name and
  UUID; their _contents_ are not fed to the digest (the library sends its
  configured `peerName` and a random UUID).
- **Hash = MD5** (not MD4). Verified two ways: (1) the compression function at
  `MAIN+0xb78c4c`→`0x11af24c` uses the **MD5 T-table** as inline `movk`
  immediates (`0xd76aa478`, `0xe8c7b756`, `0x242070db`, …) with MD5 round-1
  shifts (7,12,17,22) and MD5's `F = (x&y)|(~x&z)`; (2) `MD5(nonce ‖ secretA)`
  reproduces Serato's captured digest byte-for-byte. _(An earlier draft called
  this MD4 — wrong: MD4 and MD5 share the same IV, and the T-table lives in
  `movk` immediates, not as searchable `__const` data, so a data-only search
  missed it.)_
- **Two 32-byte secrets** are hardcoded constants in `__const` (arm64 offsets
  `0x1a2d410` and `0x1a2d430`, duplicated at `0x859edf8`/`0x859ee18`) next to
  the `RemotePolicySelector` / `AccessPolicySelector` /
  `25CIOSRemotesViewController` symbols. The handler tries **each in turn**; a
  remote only needs one:

  ```
  secret A: d25db261 a4411bc1 f3788f57 723b8977 c541a4b6 19b94a9a 8b45c46f 8511c2f8
  secret B: 5e0ac1b1 20684ff3 b35c4532 b86bda9a a4e0cd4b 59094305 b7245679 24aad7c5
  ```

- **Nonce = the Authorize/Request blob**, regenerated per connection — confirmed
  live: the value at `authObject+0x108` fed to MD5 equals the blob Serato just
  sent, and the digest must be recomputed on every connect (it cannot be
  cached).

**[unknown]** — exact semantics of the two int fields in the _request_ (`,bii`,
both `1`). Plausible: protocol version, capability flags, peer type. They are
not consumed by the digest.

**[resolved]** — no Serato-side user prompt gates a new pairing; authorization
is automatic once the digest is correct (observed live).

### 3.2 Pairing

| Path                                | Type tag                 | Args                                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/StreamMgmt/Pairing/Pair`          | `,ssi`                   | `(peerName: s, peerUUID: s, isActive: i)`                  | Bidirectional. **Verified live:** right after a successful Authorize, Serato **sends** its own Pair to the remote — e.g. `("SDJ @ <host>", "Serato DJ", 0)` (isActive=0). The remote replies with its **own** Pair marked active — `(peerName, peerUuid, 1)` — and this `isActive=1` is what opens the `/Status/` stream. The format string `%s%s%i` is hardcoded at offset `0x1a45146`. |
| `/StreamMgmt/Pairing/StatusChanged` | `,s`                     | `(state: s)` where state ∈ `"Paired"`, `"PairedNotActive"` | Pairing-state notification. Enum strings present at `0x1a450b0`/`0x1a450b7`. **Not required from the remote** — replying to Serato's Pair with an active Pair (above) is sufficient to start the stream; sending `StatusChanged("Paired")` instead did not.                                                                                                                              |
| `/StreamMgmt/Pairing/UnPair`        | argless **[unverified]** | —                                                          | Tears down the pairing cleanly. No format string follows the path in the binary, suggesting it carries no args.                                                                                                                                                                                                                                                                          |

**Verified pairing flow (2026-07-27):**

```
remote                                   Serato
  │  ── Authorize/Response (,ssb) ──────▶ │  digest OK
  │  ◀── Pairing/Pair ("SDJ @ host",      │  Serato identifies itself
  │       "Serato DJ", isActive=0) ────── │
  │  ── Pairing/Pair (peerName,           │  activate
  │       peerUuid, isActive=1) ────────▶ │
  │  ── Register/Status/<topic> (×N) ────▶ │  subscribe
  │  ◀── #bundle{ /Status/... } ───────── │  stream begins (see §4)
  │  ◀── #bundle{ /Status/... } ───────── │
```

**[unknown]** — direction of `Pair` (whether the remote initiates pairing or
Serato sends `Pair` first after Authorize/Response). The boost binding
`RemoteManagement::method(path, bool, string&, string)` matches a 4-argument
handler — likely the **send** side of Pair (`isActive`, `peerName`, `peerUUID`).
The remote-side state machine for Pair has not yet been verified end-to-end
against a successful pairing.

**[unknown]** — whether pairing is one-shot per session or persistent across
restarts; whether multiple remotes can be paired simultaneously.

### 3.3 Subscription

After pairing succeeds, the remote subscribes to the topics it cares about by
sending one `/Register/Status/<topic>` message (remote → Serato) per topic. The
desktop then begins emitting `/Status/<topic>` messages whenever the underlying
state changes. **Verified live** — subscribing to all topics yields a full
stream.

**[unverified]** — whether subscription is _mandatory_ or just a filter: it is
possible the desktop would emit all topics regardless and `/Register/...` only
narrows the set. Not yet tested by omitting some `/Register/...` paths (the
library subscribes to all it needs).

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

`/Ping` is **bidirectional and argless** in both directions. Either side can
send it; the receiving side replies with the same message. Verified across 30+
exchanges spanning ~5 minutes.

**[unknown]** — the dead-peer timeout (how long without a reply before Serato
closes the connection). Captures so far show only successful exchanges within ~1
ms latency.

---

## 4. Status messages

These are the events the desktop pushes to the remote during a paired session.
The remote opts into the topics it wants via the matching
`/Register/Status/<topic>` paths.

**Framing: `/Status/` updates arrive inside OSC bundles.** Verified live
(2026-07-27): Serato does **not** send status messages as bare packets — it
wraps them in **OSC bundles** (`#bundle\0` + 8-byte time-tag + a sequence of
4-byte-size-prefixed elements), one bundle per frame, each still followed by the
16-byte sentinel. A reader must expand bundles into their contained messages
(`serato-connect`'s `FrameReader` does this via `decodeOscPacket`, and its
`Authorize/Response` / `Pair` messages are the bare-packet form). Serato also
sends **argless** OSC messages during pairing (an address with an empty or
absent type-tag section — valid OSC 1.0), so a decoder must treat a missing tag
string as "zero args" rather than rejecting the frame.

### 4.1 Track / song

| OSC path                     | Type tag | Args                  | Notes                                                                         |
| ---------------------------- | -------- | --------------------- | ----------------------------------------------------------------------------- |
| `/Status/Deck/Song/Title`    | `is`     | `(deckIndex, title)`  | UTF-8 track title. **Verified live** (`,is`, deckIndex 0..3).                 |
| `/Status/Deck/Song/Artist`   | `is`     | `(deckIndex, artist)` | UTF-8 artist string. **Verified live** (`,is`).                               |
| `/Status/Deck/Song/Filepath` | `is`     | `(deckIndex, path)`   | Absolute filesystem path on the desktop machine. **Verified live** (`,is`).   |
| `/Status/Deck/Song/Valid`    | `if`     | `(deckIndex, valid)`  | 1.0 / 0.0 boolean — whether the deck is loaded with a track. **[unverified]** |

`deckIndex` is **0-based, range 0..3** — **confirmed live** (status messages
arrive with `i:0`, `i:1`, `i:2`, `i:3`; static analysis also shows
`Deck 0..3 change to INT mode` strings, no `Deck 4`). All four topics have
matching `/Register/Status/...` companions.

### 4.2 Playhead

| OSC path                | Type tag | Args                                          | Notes                                                                                |
| ----------------------- | -------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `/Status/Deck/Playhead` | `ifff`   | `(deckIndex, positionSeconds, playRate, bpm)` | Live playhead update — the most frequent message during playback. **Verified live.** |

**The three floats are `(positionSeconds, playRate, bpm)`** — verified live
(Serato DJ Pro 3.3.5.29) by playing a track and sweeping the pitch fader:

- **float 0 — `positionSeconds`**: playhead position in seconds. Advances at
  `playRate × realtime`.
- **float 1 — `playRate`**: the current play rate. `0.0` when stopped/paused,
  `1.0` at normal speed, and the pitch-fader multiplier when playing (e.g.
  `0.920` at −8%). A non-zero value is a reliable "deck is playing" signal.
- **float 2 — `bpm`**: the current, **pitch-adjusted** BPM. Confirmed because
  `bpm / playRate` stayed constant at the track's base BPM across the whole
  pitch sweep (e.g. base `124.0`: `1.000→124.00`, `0.958→118.77`,
  `0.920→114.08`).

It is **not** `(position, length, bpm)` — the middle float is play rate, not
track length (no track-length field is exposed by this protocol at all).

### 4.3 Loop state

| OSC path                       | Type tag | Args                 | Notes                                                     |
| ------------------------------ | -------- | -------------------- | --------------------------------------------------------- |
| `/Status/Deck/Loop/AutoLoopOn` | `if`     | `(deckIndex, on)`    | 1.0 / 0.0 boolean                                         |
| `/Status/Deck/Loop/BeatLength` | `if`     | `(deckIndex, beats)` | Active loop length in beats (e.g. 0.25, 0.5, 1, 2, 4, 8…) |
| `/Status/Deck/Loop/LoopRollOn` | `if`     | `(deckIndex, on)`    | 1.0 / 0.0 boolean                                         |

### 4.4 Mixer

| OSC path                           | Type tag | Args                    | Notes                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Status/Video/Deck/Mixer/Upfader` | `if`     | `(deckIndex, position)` | Per-deck channel fader position. **Range 0.0–1.0, linear** — no curve applied, confirmed on hardware. `deckIndex` is **1-based**, and the client stores upfaders keyed by it (index 0 unused). The `Video/` namespace prefix is vestigial — values represent the audio channel fader. |
| `/Status/Video/Mixer/Crossfader`   | `f`      | `(position,)`           | Crossfader position, `,f` single float. **Range 0.0–1.0** (left→right), confirmed by sweeping to both hard stops. Not centered on 0 — consumers wanting -1…+1 must rescale.                                                                                                           |

---

## 5. Known and unknown OSC paths

For completeness, this is the full set of OSC address patterns currently known
to be part of the protocol.

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
> spelling) path as a mystery. That was a false alarm — the binary string is
> actually `/authorize` (American), located at `0x101a4c0e1` next to
> `https://secure.soundcloud.com` and `/oauth/token`. It is a SoundCloud OAuth2
> endpoint, completely unrelated to the Serato Remote protocol.

### 5.1.1 Two parallel topic schemes

Serato DJ Pro internally has an **ACI** (action-channel) message system, exposed
on the network under three additional namespaces:

```
/Control/ACI/<id>            ← inbound controls (remote drives the DJ app)
/Register/Status/ACI/<id>    ← subscribe to ACI status by message id
/Status/ACI/<id>             ← ACI status push by message id
```

These are **[unverified]** in terms of how they relate to the `/Status/Deck/...`
and `/Status/Video/...` topics documented below. Two plausible models:

1. **Capability negotiation** — Serato uses `/Status/Deck/...` for legacy peers
   (the original Serato Remote app, SoundSwitch) and `/Status/ACI/...` for
   newer/native peers. The choice is made during the Authorize/Pair exchange.
2. **Layered emit** — Serato emits both schemes in parallel; consumers can pick
   whichever they prefer.

Until a live capture confirms which messages flow on a real session, this spec
documents only the `/Status/Deck/...` and `/Status/Video/...` paths, because
they have known argument schemas (the ACI ids do not).

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

This catalog is **verified complete** against the arm64 binary (2026-05-05) —
all 16 topic suffixes appear verbatim in the `__cstring` section, prefixed at
runtime with either `/Register/` or `/`. Additional topics may exist within the
dynamic ACI namespace (`/Status/ACI/<id>`); see §5.1.1.

---

## 6. Decks

The protocol supports up to **4 decks**, addressed by integer index **0..3**
(0-based — verified 2026-05-05 via static analysis of the Serato binary).

Higher-level state derivable from the message stream:

| Property                | Source message                     | Notes                                                |
| ----------------------- | ---------------------------------- | ---------------------------------------------------- |
| Loaded track title      | `/Status/Deck/Song/Title`          | last-write-wins per deck                             |
| Loaded track artist     | `/Status/Deck/Song/Artist`         |                                                      |
| Loaded track file path  | `/Status/Deck/Song/Filepath`       | use to look up GEOB metadata, crate membership, etc. |
| Track loaded?           | `/Status/Deck/Song/Valid`          | `,if`, `1.0` = loaded (observed live)                |
| Live position           | `/Status/Deck/Playhead` float 0    | position in seconds; high-frequency update           |
| Playing? / play rate    | `/Status/Deck/Playhead` float 1    | `0` = stopped, else the pitch multiplier             |
| BPM (current/effective) | `/Status/Deck/Playhead` float 2    | pitch-adjusted BPM                                   |
| Channel fader           | `/Status/Video/Deck/Mixer/Upfader` |                                                      |
| Loop active?            | `/Status/Deck/Loop/AutoLoopOn`     |                                                      |
| Loop length             | `/Status/Deck/Loop/BeatLength`     | in beats                                             |
| Loop roll active?       | `/Status/Deck/Loop/LoopRollOn`     |                                                      |

Mixer-wide:

| Property            | Source message                   | Notes |
| ------------------- | -------------------------------- | ----- |
| Crossfader position | `/Status/Video/Mixer/Crossfader` |       |

---

## 7. Things this protocol does **not** expose

Based on the available message set, the following data — present in Serato's
file-based outputs (history files, database, GEOB tags) — does not appear to
flow over the Remote protocol:

- Cue points, hot cues, saved loops (read from GEOB tags in the audio file)
- Beatgrid markers (read from GEOB / streaming XML)
- Crate / playlist membership (read from `_Serato_/Subcrates/`)
- Full library track list (read from `_Serato_/database V2`)
- Historical play log (read from `_Serato_/History/Sessions/`)
- Per-track key, energy, custom color (read from GEOB / database)

A complete realtime+library client therefore combines the protocol stream with
the existing file-based readers in `serato-connect`.

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
   same peer — Serato opens two parallel streams (heartbeat + control).
3. receive loop (per stream):
     accumulate bytes from the socket.
     scan for the 16-byte sentinel
       (4c aa c2 ae 35 b1 c4 76 db 5a 64 44 03 bd 41 70).
     everything before it is one OSC packet: if it starts with "#bundle",
       expand the bundle into its element messages; otherwise decode the
       single message (treat a missing type-tag as zero args).
     discard the sentinel; dispatch each message on its address; repeat.
4. dispatch:
     a. /StreamMgmt/Authorize/Request (nonce, ...):
          digest = MD5(nonce ‖ secret)          // 16-byte blob
          send /StreamMgmt/Authorize/Response ,ssb
               (peerName, peerUuid, digest).
     b. /StreamMgmt/Pairing/Pair (Serato's own, isActive=0):
          send /StreamMgmt/Pairing/Pair ,ssi
               (peerName, peerUuid, isActive=1)  // the 1 opens the stream,
          then send one /Register/Status/<topic> per topic you want.
     c. /Status/<topic>: update your model / emit events.
     d. /Ping: reply /Ping promptly; track liveness.
5. on Serato disconnect, clean up.
```

> A complete, working implementation of exactly this flow lives in `src/remote/`
> (`SeratoRemoteClient` / `RemoteServer` / `RemoteSession`, with framing +
> bundle decoding in `framing.ts` / `osc.ts`).
