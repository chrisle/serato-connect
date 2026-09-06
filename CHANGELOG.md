# Change log

## v1.4.3

- fix: the SQLite driver keeps building under npm 12, which blocks install scripts by default


## v1.4.2

- fix: patch file-type ReDoS vuln by upgrading music-metadata to v11
- fix: handle Serato tracks without deck info


## v1.4.1

- fix: a new track no longer shows up under the previous track's artist


## v1.4.0

- ci: serato-connect releases reach npm again instead of failing on every push
- fix: show the playing track on the overlay again with Serato
- docs: record the upfader as linear 0.0-1.0, verified live
- docs: record the crossfader range as 0.0-1.0, verified live
- feat: see which Serato instance you're paired with
- docs: add sequence diagram and record verified playhead + framing details
- feat: add a live terminal monitor demo for the Serato Remote client
- fix: report accurate play state and live BPM from the Serato playhead
- docs: document the verified Serato Remote handshake and status stream
- feat: stream live Serato DJ deck, playhead, and mixer state over the network


## v1.3.0

- chore: save Serato Remote protocol reverse-engineering work
- test: stub process.platform so version-detection tests pass on Linux CI
- docs: update Serato Remote protocol notes from live capture
- refactor: switch TCP framing from length-prefix to 16-byte sentinel
- feat: add OSC blob argument type to support Serato handshake
- docs: document the SeratoRemoteClient network mode in the README
- chore: expose remote-protocol API and add bonjour-service dep
- feat: add SeratoRemoteClient for the OSC-over-TCP Serato Remote protocol
- feat: add OSC 1.1 encoder and length-prefix TCP framer
- docs: add Serato Remote protocol reverse-engineering notes


## v1.2.3

- refactor: use better-sqlite3-multiple-ciphers for Electron 43 compatibility


## v1.2.2

- ci: upgrade npm before publishing so OIDC trusted publishing works


## v1.2.1

- ci: switch publish workflow to OIDC trusted publishing


## v1.2.0

- fix(ci): publish no longer fails when several connect repos release together
- fix: serato library now publishes again so consumer apps get the v3 path expansion
- feat: support additional v3 candidate paths in detectSeratoInstallation


## v1.1.1

- fix: use LOCALAPPDATA for Serato v4 library path on Windows
- fix: parse v3 history text fields as UTF-16 BE instead of latin1


## v1.0.4

- feat: add incremental history tracking with cursor

## v1.0.3

- ci: trigger fresh workflow run
- ci: trigger fresh workflow run
- chore: release v1.0.2
- fix: add contents write permission for git push
- fix: handle yarn.lock and improve changelog generation
- ci: auto-version bump and publish on push to main
- docs: update prolink-connect reference to alphatheta-connect
- chore: update dependencies for stability
- docs: add related packages section to README
- chore: remove GitHub Actions, publish locally via 1Password


## v1.0.2

- fix: add contents write permission for git push
- fix: handle yarn.lock and improve changelog generation
- ci: auto-version bump and publish on push to main
- docs: update prolink-connect reference to alphatheta-connect
- chore: update dependencies for stability
- docs: add related packages section to README
- chore: remove GitHub Actions, publish locally via 1Password


## v1.0.1

- fix: handle null return from execSync in release script
- chore: change license to MIT
- chore: trigger CI
- chore: trigger CI
- fix: correct 1Password secret path for npm token
- Add release script and changelog for automated npm publishing
- Add test workflow for PRs and non-main branches
- Add NPM publish workflow with 1Password integration
- Fix: Serato DJ Pro only supports macOS and Windows
- Add comprehensive unit tests for serato-connect
- Update README with comprehensive API documentation
- Integrate library access methods into SeratoConnect class
- Add crate and database V2 parsers for library access
- Add audio file reader for extracting Serato metadata
- Add GEOB frame parsers for cues, beatgrid, and autotags
- Add Serato32 and Base64 encoding utilities
- Initial serato-connect package

## v1.0.0

- Initial release
