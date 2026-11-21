import { sanitizeText } from "@oh-my-pi/pi-utils";

export function singleLine(value: string): string {
  return sanitizeText(value).replace(/\s+/g, " ").trim();
}
