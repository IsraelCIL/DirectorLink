# Roadmap

What is done is in the release notes: [`docs/releases/`](releases/), newest [v1.7.0](releases/v1.7.0.md). This page lists only what is still to come.

## Next

Not decided yet.

## Later

- A notification when a new device asks to join, so the approving device need not have the app open.
- A member's own new device approved by that member, not only by an admin (the controller then makes the invitation).
- Alerts that stay on when the app starts while the home can't be reached, and are confirmed at the next start.
- Refrigerators: switches only for the features the model has, once the refrigerator driver reports them.
- Releases signed on GitHub, the signature checked by the driver in plain Lua (the minimum OS stays 3.3.0).
- Fans with other than four speeds, from the fan's own speed list.
- Better diagnostics for devices DirectorLink does not support yet.
- KNX percentage dimming ([#11](https://github.directorlink.io/issues/11)).

## Not planned

- **Installing driver updates from the app, or automatically.** A driver can only replace itself through a way around Control4's file protection that Control4 does not document. Updates stay in Composer, with the app's guided notice (ADR-035).
- Editing the Control4 project (Composer programming, its scenes and schedules), and plugins.
- Changing DirectorLink's Composer settings from the app (built for 1.4.0, withdrawn: they stay in Composer).
