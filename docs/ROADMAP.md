# Roadmap

What is done is in the release notes: [`docs/releases/`](releases/), newest [v1.11.0](releases/v1.11.0.md). This page lists only what is still to come.

## Next

- **DirectorLink · UniFi Protect, its sounds as alerts:** its next version sends a camera's sounds as `Alert` with one label (DirectorLink 1.11 names them), and a report from a real UniFi system.
- **The iPhone at home without DirectorLink's servers:** HTTPS on the controller with a certificate for the home's own address, if a Control4 driver can serve HTTPS (being checked).
- **An assistant (opt-in).** An AI that understands any sentence and proposes the actions to confirm, with the home's own AI key, called from the phone so that DirectorLink's servers never see it; its own privacy note first, because names and requests would reach the AI's company.

## Later

- Alerts that stay on when the app starts while the home can't be reached, and are confirmed at the next start.
- Releases signed on GitHub, the signature checked by the driver in plain Lua (the minimum OS stays 3.3.0).
- Fans with other than four speeds, from the fan's own speed list.
- Better diagnostics for devices DirectorLink does not support yet.

## Not planned

- **Installing driver updates from the app, or automatically.** A driver can only replace itself through a way around Control4's file protection that Control4 does not document. Updates stay in Composer, with the app's guided notice (ADR-035).
- Editing the Control4 project (Composer programming, its scenes and schedules), and plugins.
- Changing DirectorLink's Composer settings from the app (built for 1.4.0, withdrawn: they stay in Composer).
