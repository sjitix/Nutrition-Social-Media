"use client";

import { useEffect, useRef, useState } from "react";
import { COMMAND_EXAMPLES, parseCommand, type ParsedCommand } from "./commands";

/**
 * Type what you want. No model, no round trip to decide what you meant.
 *
 * The palette is the fast path for people who would rather not hunt for a control: `⌘K` / `Ctrl K`
 * anywhere on the board, type "regenerate tuesday" or "log burger 650", press Enter. `parseCommand`
 * resolves it deterministically, and the palette **shows the reading before it runs** — so an
 * ambiguous line is a choice rather than a surprise, and a line it cannot read is refused instead of
 * being approximated.
 *
 * What it will not do: guess. If nothing parses, it says so and points at the assistant, which is
 * the thing that exists for sentences rather than commands.
 */
export function CommandPalette({
  onPick,
  onClose,
}: {
  /** Hand the chosen reading up; the parent previews or runs it. */
  onPick: (cmd: ParsedCommand) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const readings = parseCommand(text);

  useEffect(() => {
    input.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  // Keep the highlight inside the list as the readings change under it.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, readings.length - 1)));
  }, [readings.length]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(readings.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter" && readings[cursor]) {
      e.preventDefault();
      onPick(readings[cursor]);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-plum-deep/45 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[520px] overflow-hidden rounded-[14px] bg-bgsoft shadow-2xl"
      >
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="Type a change — regenerate tuesday, log burger 650, protein 180"
          aria-label="Type a command"
          className="w-full border-b border-line bg-bgsoft px-4 py-3.5 text-[14px] outline-none placeholder:text-mut"
        />

        {text.trim() === "" ? (
          <div className="px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">Try</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {COMMAND_EXAMPLES.map((ex) => (
                <li key={ex}>
                  <button
                    type="button"
                    onClick={() => setText(ex)}
                    className="rounded-full border border-line bg-cream px-2.5 py-1 text-[11.5px] transition hover:border-vio"
                  >
                    {ex}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : readings.length === 0 ? (
          <p className="px-4 py-4 text-[12.5px] leading-relaxed text-mut">
            I can&apos;t read that as a change. The commands above are the vocabulary — for anything
            said in a sentence,{" "}
            <a href="/sage/assistant" className="font-semibold text-vio hover:text-vio-deep">
              ask the assistant
            </a>
            .
          </p>
        ) : (
          <ul className="max-h-[50vh] overflow-y-auto py-1.5">
            {readings.map((r, i) => (
              <li key={i}>
                <button
                  type="button"
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => onPick(r)}
                  className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-[12.5px] transition ${
                    i === cursor ? "bg-tint" : "hover:bg-tint/60"
                  }`}
                >
                  <span className="flex-1">{r.label}</span>
                  {r.preview && (
                    <span className="shrink-0 text-[9.5px] font-bold uppercase tracking-[0.12em] text-mut">
                      preview
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="border-t border-line px-4 py-2 text-[10.5px] text-mut">
          Enter runs it · arrows choose · Esc closes. Nothing here calls a model.
        </p>
      </div>
    </div>
  );
}
