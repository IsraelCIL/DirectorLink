-- DirectorLink in numbers (ADR-052, docs/ACCOUNTS.md): three totals the hourly cron counts for
-- GET /v1/stats and the website. Totals only: nothing about any one home or account. A count that
-- fails (D1, or GitHub for the downloads) leaves its row as it was, with when it was last counted.

CREATE TABLE stats (
  name TEXT PRIMARY KEY,              -- 'homes', 'people' or 'downloads'
  value INTEGER NOT NULL,
  updated_at TEXT NOT NULL            -- ISO 8601, UTC: when it was last counted
);
