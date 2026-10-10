# Roadmap

What is done is in the release notes: [`docs/releases/`](releases/), newest [v1.10.0](releases/v1.10.0.md). This page lists only what is still to come.

## Next

- **DirectorLink · UniFi Protect for Control4**, the free driver in its own repository, on DirectorLink 1.10's camera agreement: the console's cameras and doorbells, their pictures and live video, their detections and rings, through Ubiquiti's official Protect API with an API key. Tested with a client's UniFi system through their Director logs before release; then its page on directorlink.io/drivers.
- **An assistant (opt-in).** An AI that understands any sentence and proposes the actions to confirm, with the home's own AI key, called from the phone so that DirectorLink's servers never see it; its own privacy note first, because names and requests would reach the AI's company.
- **Commands that do even more:** steps for blinds and fans, a step to a level, more than three things at once.

## Later

- Alerts that stay on when the app starts while the home can't be reached, and are confirmed at the next start.
- Releases signed on GitHub, the signature checked by the driver in plain Lua (the minimum OS stays 3.3.0).
- Fans with other than four speeds, from the fan's own speed list.
- Better diagnostics for devices DirectorLink does not support yet.

## Not planned

- **Installing driver updates from the app, or automatically.** A driver can only replace itself through a way around Control4's file protection that Control4 does not document. Updates stay in Composer, with the app's guided notice (ADR-035).
- Editing the Control4 project (Composer programming, its scenes and schedules), and plugins.
- Changing DirectorLink's Composer settings from the app (built for 1.4.0, withdrawn: they stay in Composer).
