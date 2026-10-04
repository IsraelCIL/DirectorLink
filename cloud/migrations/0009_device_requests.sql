-- A new device asks to join one of its account's homes, and another device of the same account
-- that holds a key there approves it (ADR-053, docs/ACCOUNTS.md): the iPhone's Home Screen app,
-- whose storage is its own and which never receives an invitation link, joins this way. For at
-- most 10 minutes the cloud keeps what the two devices pass each other: what the new device says
-- it is, a commitment to its public key and then the key, the approving device's public key, and
-- the invitation sealed to the new device, which the cloud cannot open. A request goes once the
-- new device collects the invitation, when it is declined or withdrawn, and when it expires.

CREATE TABLE device_requests (
  id TEXT PRIMARY KEY,                -- random, 32 hex characters
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,              -- the account: only its own devices see the request
  label TEXT NOT NULL,                -- what the new device says it is ("Safari on iPhone")
  commitment TEXT NOT NULL,           -- SHA-256 (hex) over the new device's public key, sent first
  approver_key TEXT,                  -- the approving device's X25519 public key (base64)
  device_key TEXT,                    -- the new device's X25519 public key (base64), shown after it
  sealed TEXT,                        -- the invitation sealed to device_key (base64): opaque here
  created_at TEXT NOT NULL,           -- ISO 8601, UTC
  expires_at TEXT NOT NULL,
  -- Leaving the home, being removed, another account claiming it, or the account going removes it.
  FOREIGN KEY (home_id, user_id) REFERENCES members (home_id, user_id) ON DELETE CASCADE
);
CREATE INDEX device_requests_by_account ON device_requests (user_id, home_id);

-- How many requests each account started in the current hour (at most 10).
CREATE TABLE device_request_starts (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  window_start TEXT NOT NULL,         -- ISO 8601, UTC: when the hour began
  count INTEGER NOT NULL
);
