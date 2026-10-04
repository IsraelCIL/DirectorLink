// DirectorLink in numbers (ADR-052): asks the account service for its totals once, at load, and
// shows them only when there are at least 25 homes and the answer is what it should be. Otherwise
// the section stays hidden, as the page has it: no empty box, nothing moves.

export const STATS_URL = "https://api.directorlink.io/v1/stats";
export const MIN_HOMES = 25;
const TIMEOUT_MS = 8000;
const TOTALS = ["homes", "people", "downloads"];

const count = (value) => Number.isSafeInteger(value) && value >= 0;

// The totals to show, or null: an answer that is not three counts, or fewer homes than MIN_HOMES.
export function totalsToShow(answer) {
  if (!answer || typeof answer !== "object" || !TOTALS.every((name) => count(answer[name]))) {
    return null;
  }
  return answer.homes >= MIN_HOMES ? { homes: answer.homes, people: answer.people, downloads: answer.downloads } : null;
}

export async function loadTotals(fetcher = fetch) {
  try {
    const response = await fetcher(STATS_URL, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok ? totalsToShow(await response.json()) : null;
  } catch {
    return null;
  }
}

// Fills the section's numbers and shows it; leaves it hidden when there is nothing to show.
export async function showNumbers(doc = document, fetcher = fetch) {
  const section = doc.getElementById("numbers");
  if (!section) {
    return false;
  }
  const totals = await loadTotals(fetcher);
  if (!totals) {
    return false;
  }
  const format = new Intl.NumberFormat("en-US");
  for (const name of TOTALS) {
    const slot = section.querySelector(`[data-total="${name}"]`);
    if (!slot) {
      return false;
    }
    slot.textContent = format.format(totals[name]);
  }
  section.hidden = false;
  return true;
}

if (typeof document !== "undefined") {
  showNumbers();
}
