# Building and testing DirectorLink

A C4Z is a ZIP-based Control4 driver package. DirectorLink packages `driver.xml`, `driver.lua` and the Lua modules under `driver/src/` at the archive root, plus the API description generated from `api/openapi.yaml`.

## Tools

- Python 3 with `pip install -r requirements-dev.txt` (PyYAML, openapi-spec-validator, jsonschema)
- Lua 5.1 (`lua5.1`, `luac5.1`) for syntax checks and the driver tests
- Node.js 22 for the JavaScript syntax check and the app tests; the cloud tests also run `wrangler dev` (`npx wrangler@4.143.0`)

## Everything CI runs

From the repository root. CI (`.github/workflows/validate.yml`) runs the same in parallel jobs,
about 4 minutes in all: the driver tests in three parts (`lua5.1 driver/tests/run.lua --shard 1/3`,
`2/3`, `3/3`, split by the times listed in `driver/tests/run.lua`; every suite is in one part), the
time-zone runs, the build and checks, and the app and cloud tests. The last job, `validate`, passes
only when all of them passed.

```bash
find driver -name '*.lua' -print0 | xargs -0 -n1 luac5.1 -p   # Lua syntax
lua5.1 driver/tests/run.lua                                    # driver tests (fake Director)
TZ=Asia/Jerusalem lua5.1 driver/tests/run.lua test_calendar test_schedules test_holy_times     # and TZ=America/New_York
python -m unittest discover -s tests/scripts                   # the build and check scripts themselves
node --test tests/scripts/*.test.mjs                           # the check of the live sites (scripts/verify_live.mjs)
python scripts/check_repo.py                                   # no local tool configuration or secrets tracked
python scripts/check_api.py                                    # spec is valid and matches the driver routes
python scripts/build.py                                        # dist/DirectorLink.c4z + dist/openapi.json
python scripts/check_package.py                                # package contents and contracts
(cd dist && sha256sum DirectorLink.c4z openapi.json)           # checksums, compared with the release's
python scripts/check_contract.py                               # real HTTP responses vs the spec
python scripts/check_app.py                                    # the app
python scripts/check_sites.py                                  # console and landing page
find app console cloud -name '*.js' -print0 | xargs -0 -n1 node --check   # JavaScript syntax
node --test tests/app/*.test.mjs                               # app: lock, sealed requests, pairing code, offline mode, …
node --test tests/cloud/*.test.mjs                             # account service and relay under `wrangler dev`, local D1
```

## Package layout

```text
driver.xml
driver.lua
src/
  main.lua
  api/        HTTP server, router, handlers, generated openapi_spec.lua
  auth/       API keys, roles, pairing, profiles, invitations
  adapters/   Light V2, Light V1 (legacy Light proxy), Thermostat V2, Control4 thermostat proxy,
              blinds, cameras, KNX Contact/Relay, Relay Door, Gate and Garage Door Controllers,
              DoorBird
  cloud/      relay connection, WebSocket, the end-to-end lock, sealed requests
  control4/   discovery and normalization
  core/       json, log, store, random, x25519, registry, version, scenes, schedules, sun, weather, …
certs/
  directorlink-roots.pem   the roots the relay's certificate is checked against (docs/RELAY.md)
www/
  icons/      the device's icons in Composer and the Control4 app
```

No Lua squishing or encryption is used, so package contents and errors stay easy to inspect. Of `driver/certs/`, only the CA file that `src/cloud/websocket.lua` names (`WebSocket.CA_FILE`) is packaged, and any other file there stops the build: Git ignores other `.pem` files, so a key left there would not show in `git status`. `check_package.py` expects exactly that file, and every certificate OpenSSL would load from it must be one of the pinned roots.

The source manifest `driver/DirectorLink.c4zproj` lists the same files and folders for Snap One's Driver Packager, but a Packager build lacks the generated API description (`src/api/openapi_spec.lua`) and the stamped version, and nothing checks it. Official builds, and any package to install, come from `scripts/build.py`.

A test package for the negative check of the relay's certificate (docs/TESTING.md, 0p) comes from `python scripts/build.py --roots-only "ISRG Root X1"`: it writes only `dist/DirectorLink-wrong-roots.c4z`, whose CA file trusts that one root, and leaves `dist/DirectorLink.c4z` alone. It is never the default, its CA file fails `check_package.py`'s roots check, and the release workflow never builds or uploads it.

## Checksums and reproducible builds

The build is byte-for-byte reproducible on every OS: fixed zip timestamps, a fixed "creating system" in the zip headers, and LF line endings in `openapi.json` and in the CA file (whatever the checkout has; `.gitattributes` also keeps every text file LF in checkouts, whatever `core.autocrlf` says). The same commit therefore produces the same SHA-256 on Windows, macOS and Linux, and `check_package.py` fails if a package breaks those rules.

To check that a file matches a release, compare it with that release's `SHA256SUMS.txt`:

```bash
sha256sum DirectorLink.c4z openapi.json          # or: certutil -hashfile DirectorLink.c4z SHA256
```

A package built locally from the release's commit gives the same values, and so does the installed package on a controller (`/mnt/internal/c4z/DirectorLink.c4z`). CI prints the checksums of every build in the "Show package checksums" step.

## Driver tests

`driver/tests/` runs the real driver against a fake Director (`c4mock.lua`) in plain Lua 5.1. Requests go in as raw bytes through `OnServerDataIn`, exactly as on a controller, and the tests check responses, error codes, the Control4 commands each change produces, CORS, authentication, logging and that secrets never reach the log.

`scripts/check_contract.py` goes one step further: it serves the same driver on a local TCP port, calls every operation with a real HTTP client, and validates each response's status, Content-Type and body against `api/openapi.yaml`. It fails if any operation in the spec is not exercised.

## Local dev server

To work on the app or an API client without a controller:

```bash
python scripts/build.py                        # optional: serve the real API description
python scripts/dev_server.py                   # driver + fake Director on http://localhost:41999
python -m http.server 8080 --directory app     # app on http://localhost:8080
```

Use `localhost` as the controller address and the pairing code the dev server prints. The fake project (`Mock.demoProject` in `driver/tests/c4mock.lua`) has two rooms; five lights, two of them on the older Light proxy, and one more older light that cannot be read, listed as unsupported; three thermostats: an AC zone and, in °F, a Control4 thermostat with heat and cool setpoints and floor heating on its heat setpoint; four blinds, two of them shades that report their movement (one only opens and closes fully); three cameras, a DoorBird and a KNX door relay. It answers the weather itself; commands are recorded but not executed.

## Versions

`VERSION` holds `MAJOR.MINOR.PATCH` (for example `0.2.0`, no suffixes) and is the only file to edit for a release. The build stamps it into the package:

- `src/core/version.lua` → `Version.BRIDGE_VERSION = "0.2.0"` (the source keeps `"dev"`)
- `driver.xml` `<version>` → `MAJOR*10000 + MINOR*100 + PATCH` (0.2.0 → 200), the increasing integer Control4 uses for driver updates
- the embedded and published API description → `info.version`

## Release policy

Built `.c4z` files are not committed. Every official build is produced by GitHub Actions and attached to a GitHub Release. Releases are immutable from 1.1.0 on, once the repository's immutable-releases setting is on: after publishing, neither the tag nor the files can change. 1.0.0 and older were published mutable. The app's update notice offers only immutable releases (ADR-035).

1. Work on a `dev/<feature>` branch and merge it to `main` through a pull request.
2. A commit on `main` that changes `VERSION` is released once **Validate DirectorLink** (`validate.yml`) has passed on it: the release workflow (`release.yml`) does not run the tests again. When Validate completes on `main`, its first job, `gate`, runs only if that run succeeded on a push to `main` of this repository (never after a pull request's run or a fork's), and only for a commit whose `VERSION` differs from the commit before it (`main` takes one squashed commit per pull request); it asks GitHub's API whether Validate passed on that commit and whether the commit is on `main`, and refuses a release that exists. The second job, `build` (read-only), checks the API description against the driver (`check_api.py`), builds and checks the package (`check_package.py`) and records the checksums; the driver, time-zone, app and cloud tests and `check_contract.py` ran in Validate on that same commit, and the build is reproducible, so it is the package Validate built and checked. Then the run waits for the owner's approval (below). After it, `publish` builds again from the same commit, publishes only if the files are byte for byte the ones `build` checked, and creates the `v<version>` release at that commit with:

```text
DirectorLink.c4z
openapi.json
SHA256SUMS.txt
```

Release notes come from `docs/releases/v<version>.md`. The workflow refuses to replace an existing release, before asking for the approval and again before publishing. `gh release create` uploads the files before it publishes the release, so it works with immutable releases.

From the merge to the approval: about 5 to 7 minutes (Validate's 4 to 6, more when one of its jobs is slow; then `gate` and `build`, about a minute and a half with their runners' start), was about 20. Every push to `main` starts a short **Publish DirectorLink Release** run, which says "nothing to release" when `VERSION` did not change.

When Validate fails on the commit that changed `VERSION`, nothing is built or asked: the release waits. If it failed by chance, **Re-run failed jobs** in Validate's run; once it passes, the release starts by itself. If it needs a fix, merge the fix (it does not change `VERSION`), wait for Validate to pass on it, then **Actions → Publish DirectorLink Release → Run workflow** on `main`: run by hand, the workflow releases `main`'s latest commit, after the same checks (Validate passed on it, the release does not exist yet).

### After a merge: the owner approves

Nothing reaches production without the owner's approval (ADR-075). Deploying the sites and publishing a release each wait in GitHub's `production` environment. After a merge to `main` that changes `app/`, `console/`, `site/` or `github-link/` (the sites) or `VERSION` (a release):

1. Open **Actions**, then the run: **Deploy DirectorLink sites** for the sites, **Publish DirectorLink Release** for the driver (it starts when Validate DirectorLink has passed, a few minutes after the merge). Its "check" job, or its "gate" and "build" jobs, run first; the next one shows **Waiting**.
2. **Review deployments**, tick **production**, **Approve and deploy**. **Reject** stops it; nothing is published.
3. For the sites, **Watch the live sites** runs once the deploy is done and should say that everything served is the same as the source (see below).

A newer deploy run cancels one still waiting, so for the sites approve the latest run (it deploys everything as of its commit). A run waits for approval for up to 30 days. Nothing is deployed or published on its own: while the owner is away, the sites stay as they are.

The environment, in **Settings → Environments → production** (made by hand once, not in the repository): **Required reviewers**: the owner's GitHub account, and **Prevent self-review** off (the owner approves runs of their own merges); **Deployment branches and tags**: selected branches, `main` only; the environment secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The repository has no Cloudflare secrets of its own (**Settings → Secrets and variables → Actions → Repository secrets**): a secret there would reach any workflow, on any branch.

## Deploying the sites

`.github/workflows/deploy.yml` publishes `app/`, `console/` and `site/` to Cloudflare Workers (static assets), and the short link `github-link/`, with `wrangler deploy` whenever one of them changes on `main`, once the owner approves (above). Its first job, `check`, runs `wrangler deploy --dry-run` on each folder, with no secrets, also for pull requests; pull requests get no preview versions, since those need the token. Each folder's `wrangler.jsonc` names its Worker and custom domain:

| Folder | Worker | Domain |
| --- | --- | --- |
| `app/` | `directorlink-app` | `app.directorlink.io` |
| `console/` | `directorlink-console` | `console.directorlink.io` |
| `site/` | `directorlink-site` | `directorlink.io`, `www.directorlink.io` |
| `github-link/` | `directorlink-github` | `github.directorlink.io` (a redirect to the repository on GitHub, keeping the path) |

The deploy needs two secrets of the `production` environment: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (an API token for the account with *Workers Scripts: Edit* and, for the `directorlink.io` zone, *Workers Routes: Edit* and *DNS: Edit* — custom domains create their DNS records). Without them the job says so, succeeds and deploys nothing.

Before deploying `app/`, `console/` and `site/`, the job writes into each a `build.json`, never committed (`.gitignore`), which the site then serves:

```json
{"commit": "<the full commit of main>", "built_at": "2026-10-08T12:00:00Z"}
```

`scripts/check_sites.py` checks that the deploy and the release run only in `production` and only from `main`, that no other job reads a secret, that each site gets its `build.json` and publishes it, and the watch below. For the release it also checks that it starts only after Validate DirectorLink (or by hand), that its first job's condition is exactly the one above (a successful run of Validate on a push to `main` of this repository, or by hand on `main`) and asks GitHub's API whether Validate passed, that every job checks out the commit Validate passed (never `github.sha`, which after Validate is `main`'s latest commit) and creates the release there, that only `publish` may write (exactly `contents: write`), and that it publishes only the files `build` checked.

### Checking what is served

`node scripts/verify_live.mjs` (Node 22, nothing to install, no secrets) checks that what the sites serve is exactly the public source: for each of app.directorlink.io, console.directorlink.io and directorlink.io it reads `/build.json`, checks that the commit is on `main`, fetches every file the folder publishes at that commit (what `wrangler deploy` uploads: not what its `.assetsignore` names, nor `_headers` and `_redirects`, which are Cloudflare's settings) and compares their SHA-256 with the commit's; it checks the headers `_headers` sets, every redirect in `_redirects` (the drivers' download, releases, issues and source links) and that `https://github.directorlink.io` leads where `github-link/worker.js` says. A site without a `build.json` (deployed before ADR-075) is compared with the latest commits of `main` that changed its folder. In a clone it reads the clone (fetching `origin`'s `main` when a site names a newer commit; `--no-fetch` never fetches); anywhere else the public repository on GitHub (`--github` forces that). Exit code 0 when everything is the same, 1 otherwise; `--json FILE` also writes the report as JSON, and `--wait` waits out a deploy that finished minutes ago. `tests/scripts/verify_live.test.mjs` tests it against fake sites.

`.github/workflows/watch-live.yml` runs it every hour and after each deploy, from a full clone, with only read access to the code and write access to issues. When something differs (a file, a header, a redirect, or a `build.json` commit that is not on `main`) the run fails and opens the issue "The live site differs from the source", or updates the one that is open, commenting when the differences change; when everything is the same again it comments there and closes it. Within 10 minutes of a deploy (`built_at`) a difference is checked again once the deploy has settled, and a site that cannot be reached or turns the check away is not a difference: the run warns and the next one checks again.

The workflows' actions are pinned to exact commits (Dependabot proposes updates, `.github/dependabot.yml`) and wrangler to an exact version. The cloud (`cloud/`) is not deployed by a workflow: see `cloud/README.md`.

The driver only answers browsers from `https://app.directorlink.io` and `https://console.directorlink.io` (since 1.0.0, not `localhost` either), so a copy of a site served anywhere else cannot talk to a controller. The dev server (`scripts/dev_server.py`) also allows `http://localhost` and `http://127.0.0.1`, for local testing.

## Minimum Director version

`driver.xml` declares `<minimum_os_version>3.3.0</minimum_os_version>` and the driver also checks the version at runtime.
