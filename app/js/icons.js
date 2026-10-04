// Inline stroke icons (24 × 24, currentColor). Static markup only — never data.

const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  camera:
    '<path d="M3 8a2 2 0 0 1 2-2h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="12" cy="13" r="3.5"/>',
  climate: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0Z"/><path d="M12 11v6"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  bulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z"/>',
  blinds: '<path d="M4 4h16"/><path d="M5 4v16h14V4"/><path d="M5 8h14M5 12h14M5 16h14"/>',
  fan: '<circle cx="12" cy="12" r="1.5"/><path d="M12 10.5C11 7 11.5 3 14.5 3c2 0 2.5 2 1.5 3.5-1 1.6-2.6 2.6-4 4Z"/><path d="M13.3 12.8c3.4 1 6 4 4.3 6.5-1.1 1.7-3 1-3.8-.5-.9-1.7-.9-3.6-.5-6Z"/><path d="M10.7 12.8C7.4 13.9 4.5 13.4 4 10.4c-.3-2 1.6-2.8 3.2-2.2 1.8.7 3 2.2 3.5 4.6Z"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9Z"/>',
  chevronBack: '<path d="m15 18-6-6 6-6"/>',
  chevronForward: '<path d="m9 18 6-6-6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  moveBack: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  moveForward: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  arrowUp: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
  // The handle a room is dragged by (Settings → Rooms).
  grip: '<circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  cloudOff: '<path d="m3 3 18 18"/><path d="M8.5 6.3A6 6 0 0 1 17.7 10H18a4 4 0 0 1 2.4 7.2M17 18H7a5 5 0 0 1-1.4-9.8"/>',
  wifiOff: '<path d="m3 3 18 18"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 4.2-2.5M14.8 10.4A10 10 0 0 1 19 12.9"/><path d="M2 9a15 15 0 0 1 4.3-2.8M11 5.1A15 15 0 0 1 22 9"/><path d="M12 20h.01"/>',
  noPicture: '<path d="m3 3 18 18"/><path d="M9.5 5H15l1.5 2H19a2 2 0 0 1 2 2v8.5M17 20H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2"/><path d="M9.9 10.9a3 3 0 0 0 4.2 4.2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  // Filled: the Apple logo of the Sign in with Apple button.
  apple:
    '<path fill="currentColor" stroke="none" d="M12.15 6.9c-.95 0-2.42-1.08-3.96-1.04-2.04.03-3.91 1.18-4.96 3.01-2.12 3.68-.55 9.1 1.52 12.09 1.01 1.45 2.21 3.09 3.79 3.04 1.52-.07 2.09-.99 3.94-.99 1.83 0 2.35.99 3.96.95 1.64-.03 2.68-1.48 3.68-2.95 1.16-1.69 1.64-3.33 1.66-3.42-.04-.01-3.18-1.22-3.22-4.86-.03-3.04 2.48-4.49 2.6-4.56-1.43-2.09-3.62-2.32-4.39-2.38-2-.16-3.68 1.09-4.62 1.09Zm3.38-3.07c.84-1.01 1.4-2.43 1.25-3.83-1.21.05-2.66.8-3.53 1.82-.78.9-1.46 2.34-1.27 3.71 1.34.1 2.71-.69 3.55-1.7Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m16 7 3 3"/><path d="m18 5 2 2"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="M12 3v2"/>',
  door: '<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><path d="M4 21h16"/><path d="M14 12h.01"/>',
  // Refrigerators: the refrigerator, and its features (Sabbath mode is the candles).
  fridge: '<rect x="5.5" y="2.5" width="13" height="19" rx="2"/><path d="M5.5 9.5h13"/><path d="M9 5.5v1.5M9 12.5v3"/>',
  coolFast: '<path d="M9 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0Z"/><path d="M7 11v6"/><path d="M17 4v11"/><path d="m13.5 11.5 3.5 3.5 3.5-3.5"/>',
  snowflake: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="m9.5 4.5 2.5 2 2.5-2M9.5 19.5l2.5-2 2.5 2"/>',
  ice: '<path d="M12 3.5 19.5 7.5v9L12 20.5l-7.5-4v-9Z"/><path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9"/>',
  drop: '<path d="M12 3.5c3 3.7 6 7 6 10.5a6 6 0 0 1-12 0c0-3.5 3-6.8 6-10.5Z"/>',
  // The alarm (read-only): its partitions, and one in alarm.
  shield: '<path d="M12 3 4.5 6v5.5c0 4.4 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5.1 7.5-9.5V6Z"/>',
  siren: '<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M5 18h14v3H5Z"/><path d="M12 3v2M4.6 6.6l1.4 1.4M19.4 6.6 18 8"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  // Scenes: the tab, "leaving home", "movie", Run and Copy.
  scene: '<path d="M11 3.5 12.8 8 17.5 9.8 12.8 11.6 11 16.3 9.2 11.6 4.5 9.8 9.2 8Z"/><path d="m18 14 .9 2.1 2.1.9-2.1.9L18 20l-.9-2.1-2.1-.9 2.1-.9Z"/>',
  leave: '<path d="M10 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4"/><path d="M14 8l4 4-4 4"/><path d="M18 12H9"/>',
  movie: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 11h18"/><path d="m4 7 3-3 3 3M11 7l3-3 3 3"/>',
  play: '<path d="M8 5.5v13l10.5-6.5Z"/>',
  // Schedules: time and weather.
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  // Settings → Controller → History: a clock turning back.
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 4v4.5H8"/><path d="M12 7.5V12l3 2"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h16a3 3 0 1 1-3 3"/><path d="M3 16h7"/>',
  rain: '<path d="M7 15a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 8a3.5 3.5 0 0 1 .5 7Z"/><path d="m8 18-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/>',
  // Shabbat and holidays (the Jewish calendar): two candles.
  candles:
    '<path d="M4 21h16"/><path d="M6.5 21V11h3v10M14.5 21V11h3v10"/><path d="M8 3.5c.9 1 1.5 1.9 1.5 2.8a1.5 1.5 0 0 1-3 0c0-.9.6-1.8 1.5-2.8ZM16 3.5c.9 1 1.5 1.9 1.5 2.8a1.5 1.5 0 0 1-3 0c0-.9.6-1.8 1.5-2.8Z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.4 0 2-1 2-2 0-1.5-1.2-1.8-1.2-3 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3Z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
  rooms: '<path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-7h6v7"/>',
  controller: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h.01M11 12h.01"/><path d="M15 12h3"/>',
  // Settings: People and devices, and Backup.
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M15.5 4.7a3.5 3.5 0 0 1 0 6.6"/><path d="M18 14.3a6.5 6.5 0 0 1 3.5 5.7"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>',
  // Music (Sonos). Playback controls are not mirrored in right-to-left layouts.
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  pause: '<path d="M8 5.5v13M16 5.5v13"/>',
  skipNext: '<path d="M5.5 5.5v13l9-6.5Z"/><path d="M18.5 5.5v13"/>',
  skipPrevious: '<path d="M18.5 5.5v13l-9-6.5Z"/><path d="M5.5 5.5v13"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  volumeOff: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
};

// Icons that point along the reading direction; CSS mirrors them in right-to-left layouts.
const DIRECTIONAL = new Set(["chevronBack", "chevronForward", "moveBack", "moveForward"]);

export function icon(name, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `icon ${DIRECTIONAL.has(name) ? "icon-directional" : ""} ${className}`.trim());
  svg.innerHTML = PATHS[name] || PATHS.info;
  return svg;
}
