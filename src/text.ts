import { sanitizeText } from "@oh-my-pi/pi-utils";

export function singleLine(value: string): string {
  return sanitizeText(value).replace(/\s+/g, " ").trim();
}

const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/y;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function visibleWidth(text: string): number {
  return Bun.stringWidth(text);
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
  if (width < 1 || !text) return [];
  return Bun.wrapAnsi(text, width, { hard: true, trim: false }).split("\n");
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = "…", pad = false): string {
  if (maxWidth <= 0) return "";
  const total = visibleWidth(text);
  if (total <= maxWidth) return pad ? text + " ".repeat(maxWidth - total) : text;
  const ellipsisWidth = visibleWidth(ellipsis);
  const useEllipsis = ellipsisWidth <= maxWidth ? ellipsis : "";
  const target = maxWidth - visibleWidth(useEllipsis);
  let out = "";
  let width = 0;
  let hasAnsi = false;
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x1b) {
      ANSI_ESCAPE.lastIndex = i;
      const match = ANSI_ESCAPE.exec(text);
      if (match) {
        out += match[0];
        hasAnsi = true;
        i = ANSI_ESCAPE.lastIndex;
        continue;
      }
    }
    const nextEsc = text.indexOf("\x1b", i);
    const chunk = nextEsc === -1 ? text.slice(i) : text.slice(i, nextEsc);
    let stopped = false;
    for (const { segment } of GRAPHEMES.segment(chunk)) {
      const segWidth = visibleWidth(segment);
      if (width + segWidth > target) {
        stopped = true;
        break;
      }
      out += segment;
      width += segWidth;
    }
    if (stopped) break;
    i = nextEsc === -1 ? text.length : nextEsc;
  }
  out += useEllipsis;
  width += visibleWidth(useEllipsis);
  if (hasAnsi) out += "\x1b[0m";
  return pad && width < maxWidth ? out + " ".repeat(maxWidth - width) : out;
}
