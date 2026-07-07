# serato-connect documentation

This directory documents the **Serato Remote protocol** — the OSC-over-TCP
protocol that Serato DJ Pro speaks for live deck/track/mixer telemetry over
the local network. `serato-connect` aims to implement a client for this
protocol so that downstream apps can react to Serato in real time without
polling history files.

## Contents

- **[protocol.md](./protocol.md)** — full protocol specification: transport,
  discovery, connection lifecycle, every known OSC message with argument
  types and semantics.
- **[open-questions.md](./open-questions.md)** — items that are known to be
  unknown: argument meanings yet to be confirmed, edge cases, version
  differences, etc.

## Status

This is an in-progress specification. The protocol surface (paths,
classes, flow) is mapped; specific argument semantics and a few control-flow
details require empirical verification against a running Serato DJ Pro
instance. Items needing verification are marked **[unverified]** inline.

## Scope

The Serato Remote protocol is one of two integration modes for Serato data:

| Mode | Source | Latency | Coverage |
|---|---|---|---|
| File-based | `~/Music/_Serato_/` (history sessions, database, GEOB tags) | ~2s (mtime poll) | Track loaded, history, library, tags |
| **Network (this doc)** | `_SeratoIOSRemote._tcp` Bonjour service | sub-frame | Live playhead, faders, loop state, track changes, beat info |

These modes are complementary, not exclusive — `serato-connect` will support
both, with the network mode preferred when a live Serato DJ Pro instance is
discoverable on the network.
