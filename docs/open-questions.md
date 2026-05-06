# Open questions

Items not yet resolved in the Serato Remote protocol specification. Each
will be filled in as evidence accumulates from live sessions.

## Discovery

- ~~**TXT record contents.**~~ **Resolved.** The TXT record is **empty**
  (`""`). The peer publishes no key/value pairs at all. Serato accepts a
  bare advert. Any protocol version negotiation must happen inside the OSC
  handshake (likely `/StreamMgmt/Authorize/Request`), not in TXT.
- **Multiple instances.** When more than one peer is on the network, does
  each publish a distinguishable instance name? The observed instance
  name format is `<AppName> @ <hostname>` (with `@` literal, hostname
  including `.local`). Whether collision is handled by Bonjour's automatic
  ` (2)` suffix or by app-side renaming is unconfirmed.

## Connection direction

- ~~Who initiates the TCP connection?~~ **Resolved.** Serato DJ Pro is the
  TCP **client**: its binary contains `connectToHost:onPort:error:` and
  `socket:didConnectToHost:port:` selectors, and it opens zero listening
  sockets when running. The remote/peer publishes the Bonjour service and
  accepts the connection.

## Connection multiplexing

- **Why two parallel TCP connections?** Observation: Serato opens **two**
  TCP connections to the peer's port simultaneously (e.g.
  `127.0.0.1:65170 → :65161` and `127.0.0.1:65171 → :65161`). Hypotheses
  to test:
  - One for `/StreamMgmt/*` + legacy `/Status/Deck/...`; the other for
    ACI namespace (`/Control/ACI/`, `/Status/ACI/...`).
  - One for inbound status events (peer → Serato), one for outbound
    control (Serato → peer).
  - Two transceiver instances on the peer side, addressing different
    subsystems.
  Phase 2 capture will resolve by recording which OSC paths flow on which
  of the two TCP connections.

## Framing

- **TCP packet framing format.** Strongly suspected to be a 4-byte
  big-endian length prefix (`oscpack`'s default), but unconfirmed against
  real bytes on the wire. Could alternatively be SLIP-style framing or
  simple OSC-bundle delimiters.

## Authorization

- **Authorize argument shape.** What does `/StreamMgmt/Authorize/Request`
  carry? A token? A client name? A protocol version?
- **Authorize response shape.** Does `/StreamMgmt/Authorize/Response`
  return success/failure, a session ID, capability flags?
- **User consent UX.** Does the desktop user see a "allow this remote?"
  prompt on first pairing, or is authorization automatic?
- **Re-authorization.** Is auth state persisted across restarts of either
  side?

## Pairing

- **Pair argument shape.** What does `/StreamMgmt/Pairing/Pair` carry?
- **StatusChanged argument shape.** What enum/flags does the desktop
  send to indicate paired/unpaired/error states?
- **Multi-remote behavior.** Can multiple remotes be paired simultaneously?
  If so, does each get an independent stream, or do they share?

## Subscription model

- **Is `/Register/Status/<topic>` mandatory or filtering?** Does the
  desktop withhold updates until subscribed, or does it always emit and the
  registration just lets the remote opt out of unwanted topics?
- **Argument shape.** Do `/Register/...` paths carry any args (e.g. a flag
  to start/stop the subscription)?

## Heartbeat

- **`/Ping` direction and cadence.** Is it remote → desktop, desktop →
  remote, or both? At what interval? What's the timeout for treating the
  peer as dead?
- **Ping payload.** Does it carry any args (e.g. a sequence number,
  timestamp)?

## Status message details

- **Deck index convention.** 0-based or 1-based? The protocol supports four
  decks; whether they are addressed `0..3` or `1..4` is unconfirmed.
- **`/Status/Deck/Playhead` three floats.** Best candidates:
  - `(positionSeconds, lengthSeconds, bpm)`
  - `(positionSeconds, lengthSeconds, playRate)` where playRate ≠ 1 at
    non-zero pitch
  - `(positionBeats, beatPhase, bpm)`
  - some combination involving the deck's sample rate
  Disambiguate by loading a known-length track, scrubbing to a known
  position, and varying the pitch fader.
- **`/Status/Video/Mixer/Crossfader` range.** Either -1.0…+1.0 (centered)
  or 0.0…1.0 (left → right). Determine by capturing the value at hard-left,
  center, and hard-right positions.
- **`/Status/Video/Deck/Mixer/Upfader` range.** Almost certainly 0.0…1.0
  but unconfirmed. Are there any non-linear curves applied?
- **`/Status/Deck/Loop/BeatLength` value when loop is off.** Does it stay
  at the last value or get reset to 0?
- **Update rate / throttling.** What's the maximum frequency for
  `/Status/Deck/Playhead`? Is it tied to the audio frame rate, screen
  refresh, or something else?
- **`/Status/Deck/Song/Valid`.** Confirmed type tag (suspected `if`)
  and confirmed values for "loaded" vs. "not loaded".

## Path mysteries

- **`/authorise`.** British spelling, distinct from `/StreamMgmt/Authorize/...`.
  Origin and purpose unknown. Possibilities: legacy handshake from an
  earlier protocol version; alternate path used in a different transport
  mode; vestigial code.
- **The `Video/` namespace prefix on mixer paths.** `Upfader` and
  `Crossfader` live under `/Status/Video/...` rather than `/Status/Mixer/...`.
  Likely vestigial naming from when the protocol was extended to cover
  Serato Video, but unconfirmed. Are there `/Status/Video/<other>` paths
  that haven't been observed?

## ACI namespace

Serato DJ Pro 3.x exposes three additional path namespaces for its internal
**ACI** (action-channel) messaging system:

```
/Control/ACI/<id>
/Register/Status/ACI/<id>
/Status/ACI/<id>
```

- **What does ACI stand for?** Likely "Action Channel Interface" or "Audio
  Control Interface". Internal references use lowercase `aci` and a
  `proto_enum_to_aci_map`, suggesting protobuf-style numeric message IDs.
- **Wire format of `<id>`.** Is it a numeric suffix (`/Status/ACI/42`),
  a hierarchical path (`/Status/ACI/Deck/1/Playhead`), or something else?
- **Argument schema per ACI message ID.** Each message has an associated
  data shape that needs to be enumerated.
- **Coexistence with `/Status/Deck/...`.** Does Serato emit both schemes
  in parallel, or does it pick one based on peer capability negotiated
  during the Authorize/Pair handshake?
- **`/Control/ACI/<id>`.** This is the first inbound *control* path
  observed (peer → Serato). Out of scope for read-only consumers but
  useful for any future feature where the consumer wants to drive Serato
  (e.g. trigger a hot cue from a stream-deck integration).

## Activation

- **What triggers Serato DJ Pro to start browsing for a peer?** Does it
  poll continuously, or only after a settings flag is enabled? Observed
  state: with a peer publishing the service, Serato should auto-discover
  and connect — but the exact preconditions on the Serato side have not
  been confirmed.
- **TXT record contents required for Serato to accept the advert.** A
  remote publishing a bare `_SeratoIOSRemote._tcp` advert with no TXT data
  may or may not be accepted. The TXT record likely contains at least a
  protocol version and possibly an instance ID.

## Error handling

- **Malformed message behavior.** Does the desktop drop the connection on
  a bad OSC packet, or skip and continue?
- **Auth/pair failure path.** What does the desktop send if it rejects an
  Authorize or Pair request?
- **Resource limits.** What happens if the remote subscribes to too many
  topics, or sends messages too fast?

## Versioning

- **Protocol version.** Is there any version negotiation? The TXT record
  is the most likely place to find a version field.
- **Compatibility across Serato DJ versions.** Has the protocol changed
  between Serato DJ 2.x and 3.x? Are any paths deprecated or new?
