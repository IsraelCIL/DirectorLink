-- Direct HTTPS (1.12.0, ADR-082, docs/ACCOUNTS.md): the name under dlhome.cc each home's certificates
-- are for. One name a home, and a name belongs to one home for good: the first request for a
-- certificate a home may make binds it (src/https.js). Names are public (Certificate Transparency
-- logs list every certificate), so this is what keeps another home from asking for one: in D1, not
-- in the home's Durable Object, which knows only its own home. The address its A record points at is
-- kept by the home's object, never here.

CREATE TABLE https_names (
  name TEXT PRIMARY KEY,               -- '<20 base32 letters and digits>.dlhome.cc'
  home_id TEXT NOT NULL UNIQUE,        -- the home it belongs to (homes.id; no foreign key: the name
                                       -- stays the home's while no account has it)
  created_at TEXT NOT NULL,            -- ISO 8601, UTC: when the home first asked for it
  issued_at TEXT                       -- when its first certificate was issued (for Let's Encrypt's
                                       -- weekly limit on new names); null until then
);

CREATE INDEX https_names_issued ON https_names (issued_at);
