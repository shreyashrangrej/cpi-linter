/**
 * Lightweight lexical helpers for Groovy / JavaScript sources.
 *
 * We don't need a full parser: rules work with regexes over two "views" of the
 * source that keep every character at its original offset:
 *   - `noComments`: comments blanked out, string literals intact
 *   - `code`:       comments AND string-literal contents blanked out
 * Blanking keeps newlines so offsets and line numbers stay aligned.
 */

export interface Block {
  open: number;
  close: number;
  /** Text between the previous statement boundary and the `{` (comments removed). */
  header: string;
}

export interface LexedSource {
  text: string;
  noComments: string;
  code: string;
  lineStarts: number[];
  blocks: Block[];
}

const blank = (s: string) => s.replace(/[^\n]/g, " ");

export function lex(text: string): LexedSource {
  const n = text.length;
  let noComments = "";
  let code = "";
  let i = 0;

  const emit = (chunk: string, kind: "code" | "comment" | "string") => {
    if (kind === "code") {
      noComments += chunk;
      code += chunk;
    } else if (kind === "comment") {
      noComments += blank(chunk);
      code += blank(chunk);
    } else {
      noComments += chunk;
      // keep the delimiters, blank the contents
      code += chunk.length >= 2 ? chunk[0] + blank(chunk.slice(1, -1)) + chunk[chunk.length - 1] : blank(chunk);
    }
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      emit(text.slice(i, stop), "comment");
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      emit(text.slice(i, stop), "comment");
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const triple = c !== "`" && text.startsWith(c.repeat(3), i);
      const delim = triple ? c.repeat(3) : c;
      let j = i + delim.length;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text.startsWith(delim, j)) {
          j += delim.length;
          break;
        }
        // single-line strings can't span lines; bail out to avoid eating the file
        if (!triple && c !== "`" && text[j] === "\n") break;
        j++;
      }
      const stop = Math.min(j, n);
      const chunk = text.slice(i, stop);
      if (triple) {
        noComments += chunk;
        code += delim + blank(chunk.slice(3, -3)) + (chunk.length >= 6 ? delim : "");
      } else {
        emit(chunk, "string");
      }
      i = stop;
      continue;
    }
    emit(c, "code");
    i++;
  }

  // keep lengths identical even if slicing above was off at EOF
  if (code.length !== n) code = code.padEnd(n).slice(0, n);
  if (noComments.length !== n) noComments = noComments.padEnd(n).slice(0, n);

  return { text, noComments, code, lineStarts: computeLineStarts(text), blocks: findBlocks(code, noComments) };
}

function findBlocks(code: string, noComments: string): Block[] {
  const blocks: Block[] = [];
  const stack: number[] = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "{") stack.push(i);
    else if (c === "}") {
      const open = stack.pop();
      if (open === undefined) continue;
      blocks.push({ open, close: i, header: headerBefore(code, noComments, open) });
    }
  }
  // unclosed blocks extend to EOF
  for (const open of stack) {
    blocks.push({ open, close: code.length, header: headerBefore(code, noComments, open) });
  }
  return blocks.sort((a, b) => a.open - b.open);
}

function headerBefore(code: string, noComments: string, open: number): string {
  let depth = 0;
  let i = open - 1;
  // allow `if (x)\n{` brace-on-next-line style
  while (i >= 0 && /\s/.test(code[i])) i--;
  for (; i >= 0; i--) {
    const c = code[i];
    if (c === ")") depth++;
    else if (c === "(") depth--;
    // Groovy statements often end at a newline rather than `;`
    else if (depth === 0 && (c === ";" || c === "{" || c === "}" || c === "\n")) break;
  }
  return noComments.slice(i + 1, open).replace(/\s+/g, " ").trim();
}

/** 1-based line and column for an offset. */
export function position(src: { lineStarts: number[] }, offset: number): { line: number; column: number } {
  const line = lineOf(src.lineStarts, offset);
  return { line, column: offset - src.lineStarts[line - 1] + 1 };
}

export function lineText(src: { text: string; lineStarts: number[] }, line: number): string {
  const start = src.lineStarts[line - 1] ?? 0;
  const end = src.lineStarts[line] ?? src.text.length + 1;
  return src.text.slice(start, end - 1).replace(/\r$/, "");
}

/** Blocks enclosing an offset, innermost first. */
export function enclosingBlocks(src: LexedSource, offset: number): Block[] {
  return src.blocks.filter((b) => b.open < offset && offset < b.close).reverse();
}

/** True if the offset lies inside a comment. */
export function inComment(src: LexedSource, offset: number): boolean {
  return src.noComments[offset] !== src.text[offset];
}

export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === "\n") starts.push(k + 1);
  return starts;
}

export function lineOf(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
