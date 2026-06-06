// The YouTube Data API returns snippet titles HTML-escaped (e.g. "Tom &amp;
// Jerry", "don&#39;t"). Decode them so they display correctly and so per-channel
// regexes match the text the user actually sees. A reused textarea handles every
// named/numeric entity without a lookup table.
let decoder: HTMLTextAreaElement | null = null;

export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&") || typeof document === "undefined") {
    return text;
  }
  if (!decoder) {
    decoder = document.createElement("textarea");
  }
  decoder.innerHTML = text;
  return decoder.value;
}
