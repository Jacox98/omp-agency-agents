import type { KeybindingsManager } from "@oh-my-pi/pi-coding-agent";
import { jsx, type KeyEvent, type PasteEvent, signal, type UiNode, untrack } from "@oh-my-pi/pi-tui";

/** The part of the host keymap views need: whether a key event is bound to an action. */
export type KeyMatcher = Pick<KeybindingsManager, "matches">;
export type { KeyEvent };

/** A row-drawn view that receives decoded key events, so it follows the user's keybindings. */
export interface KeyView {
  render(width: number): readonly string[];
  handleKey(key: KeyEvent): void;
  handlePaste?(text: string): void;
}

/**
 * Mount `create`'s view as a focused `canvas` node. The view's `requestRender` and every key or
 * paste it receives repaint it.
 */
export function mountKeyView(create: (requestRender: () => void) => KeyView): UiNode {
  const tick = signal(0);
  const requestRender = () => tick.set(untrack(tick) + 1);
  const view = create(requestRender);
  return jsx("canvas", {
    paint: (width: number) => {
      tick();
      return view.render(width);
    },
    onKey: (key: KeyEvent) => {
      if (key.kind === "release") return false;
      view.handleKey(key);
      requestRender();
      return true;
    },
    onPaste: (paste: PasteEvent) => {
      view.handlePaste?.(paste.text);
      requestRender();
      return true;
    },
  }) as UiNode;
}
