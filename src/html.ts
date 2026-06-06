// The YouTube Data API returns snippet titles/descriptions HTML-escaped (e.g.
// "Tom &amp; Jerry", "don&#39;t"). Decode them so they display correctly and so
// per-channel regexes match the text the user actually sees. DOMParser parses the
// string into an inert document (no scripts run) and we read its text back out —
// the result is rendered by React as text, never reinjected as HTML.
let parser: DOMParser | null = null;

export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&") || typeof DOMParser === "undefined") {
    return text;
  }
  if (!parser) {
    parser = new DOMParser();
  }
  return parser.parseFromString(text, "text/html").body?.textContent ?? text;
}
