# Upstream relationship

This vendored Pi Talk component is derived from [ExistentialAudio/BlackHole](https://github.com/ExistentialAudio/BlackHole) and remains licensed under GNU GPLv3.

The initial Pi Talk implementation is based on:

- BlackHole version: `0.7.1`
- Upstream commit: `561d934c77a1fa64987e01ccabe890fed30e181f`

The original upstream changelog is preserved in [`UPSTREAM_CHANGELOG.md`](UPSTREAM_CHANGELOG.md).

## Updating the vendored source

Updates are intentionally performed manually so the containing Pi Talk repository does not need a BlackHole Git remote or submodule:

1. Fetch or clone the latest BlackHole source separately.
2. Review upstream changes since the commit recorded above.
3. Port relevant changes into `BlackHole/`, `BlackHole.xcodeproj/`, and any required framework settings.
4. Preserve Pi Talk device names, bundle IDs, factory UUIDs, artwork, notices, and build/install scripts.
5. Confirm no upstream branding or protected artwork was added to Pi Talk release bundles.
6. Build from this directory with `./Scripts/build_pi_talk_drivers.sh`.
7. Perform end-to-end audio tests on macOS.
8. Update the version and upstream commit recorded here.

Published Pi Talk releases should identify the exact containing-repository commit that supplies the corresponding GPL source.
