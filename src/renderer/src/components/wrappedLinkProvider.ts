import type { ILinkProvider, ILink, Terminal } from '@xterm/xterm'

// ─── Pure reconstruction core ─────────────────────────────────────────────────
// Kept free of xterm/DOM so the wrapping rules can be exercised directly in a
// test against literal screen contents.

export interface BufferRow {
  /** Exactly `cols` characters — pad short rows before passing them in. */
  text: string
  /** True when the terminal itself soft-wrapped this row from the one above. */
  isWrapped: boolean
}

/** One row's slice of a URL. A wrapped URL yields one piece per row it covers. */
export interface UrlPiece {
  row: number // index into the `rows` array
  startCol: number // 0-based, inclusive
  endCol: number // 0-based, inclusive
}

export interface WrappedUrl {
  url: string
  pieces: UrlPiece[]
}

// Same strict URL matcher the stock @xterm/addon-web-links uses: http(s):// up to
// the first whitespace/quote, trimming dangling punctuation/brackets.
const URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g

/** Leading run of characters that may appear inside a URL. */
const URL_BODY_RUN = /^[^\s"'!*(){}|\\^<>`]+/

/** Punctuation that ends a sentence rather than a URL. */
const TRAILING_PUNCT = /[.,;:!?]/

/**
 * Vertical rules a TUI may draw down each side of a panel. Content inside such a
 * frame has to be unwrapped before a URL split across its rows can be rejoined.
 */
const FRAME_CHARS = new Set(['│', '┃', '║', '┆', '┇', '┊', '┋', '▏', '▕', '|'])

/** Cap on reconstruction length, mirroring the stock addon's guard. */
const MAX_URL_LENGTH = 2048

/**
 * How far short of the content's right edge a fragment may stop and still count
 * as "ran out of room". Zero would demand a perfectly flush break, which real
 * TUIs rarely produce — they stop a few columns early to leave a padding gutter.
 */
const WRAP_SLACK = 4

function firstNonSpace(s: string): number {
  let i = 0
  while (i < s.length && s[i] === ' ') i++
  return i < s.length ? i : -1
}

function lastNonSpace(s: string): number {
  let i = s.length - 1
  while (i >= 0 && s[i] === ' ') i--
  return i
}

interface Content {
  /** The row with any surrounding frame rules removed. */
  text: string
  /** Column the content starts at, for mapping indices back to the screen. */
  left: number
}

/**
 * Strip a TUI panel's side rules so the text between them can be treated as the
 * real line. Rows without a frame are returned whole.
 */
function contentRegion(raw: string, cols: number): Content {
  let left = 0
  let right = cols - 1

  const f = firstNonSpace(raw)
  if (f >= 0 && FRAME_CHARS.has(raw[f])) left = f + 1

  const l = lastNonSpace(raw)
  if (l > left && FRAME_CHARS.has(raw[l])) right = l - 1

  if (right < left) return { text: '', left }
  return { text: raw.slice(left, right + 1), left }
}

function isUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate)
    const base =
      url.username && url.password
        ? `${url.protocol}//${url.username}:${url.password}@${url.host}`
        : url.username
          ? `${url.protocol}//${url.username}@${url.host}`
          : `${url.protocol}//${url.host}`
    return candidate.toLowerCase().startsWith(base.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Grow a URL fragment downwards across rows.
 *
 * A row is only treated as carrying the rest of the URL when all of the
 * following hold, which together make a false join unlikely:
 *  - the fragment above is the last thing on its line and ran out of room
 *    (or the terminal soft-wrapped, which is proof on its own);
 *  - this row holds nothing *but* the continuation — a line with other words on
 *    it is ordinary output, not the tail of a URL;
 *  - the continuation does not start its own `http(s)://`, so two long links on
 *    consecutive lines are never fused into one.
 */
function buildFrom(
  rows: BufferRow[],
  cols: number,
  row: number,
  content: Content,
  startIdx: number,
  first: string
): WrappedUrl | null {
  let url = first
  const pieces: UrlPiece[] = [
    {
      row,
      startCol: content.left + startIdx,
      endCol: content.left + startIdx + first.length - 1
    }
  ]

  let curRow = row
  let curContent = content
  let curEnd = startIdx + first.length - 1

  while (url.length < MAX_URL_LENGTH) {
    const next = rows[curRow + 1]
    if (!next) break

    const nextContent = contentRegion(next.text, cols)
    if (!nextContent.text) break

    if (!next.isWrapped) {
      // The application broke this line itself. Only continue if the fragment
      // above actually reached the edge of the available width.
      if (curEnd !== lastNonSpace(curContent.text)) break
      if (curContent.text.length - 1 - curEnd > WRAP_SLACK) break
    }

    const chunkStart = firstNonSpace(nextContent.text)
    if (chunkStart < 0) break
    // A soft-wrapped row resumes in the very first column; indented text is a
    // fresh line of output rather than the remainder of the URL.
    if (next.isWrapped && chunkStart !== 0) break

    const run = URL_BODY_RUN.exec(nextContent.text.slice(chunkStart))
    if (!run) break
    const chunk = run[0]

    if (nextContent.text.slice(chunkStart + chunk.length).trim() !== '') break
    if (/^(https?):\/\//i.test(chunk)) break

    url += chunk
    pieces.push({
      row: curRow + 1,
      startCol: nextContent.left + chunkStart,
      endCol: nextContent.left + chunkStart + chunk.length - 1
    })

    curRow += 1
    curContent = nextContent
    curEnd = chunkStart + chunk.length - 1
  }

  // The regex already trims punctuation on a single row; a joined tail has to be
  // trimmed here, shrinking (or dropping) the pieces that covered it.
  let remove = 0
  while (remove < url.length && TRAILING_PUNCT.test(url[url.length - 1 - remove])) remove++
  if (remove > 0) {
    url = url.slice(0, url.length - remove)
    let left = remove
    while (left > 0 && pieces.length > 0) {
      const last = pieces[pieces.length - 1]
      const len = last.endCol - last.startCol + 1
      if (len > left) {
        last.endCol -= left
        left = 0
      } else {
        left -= len
        pieces.pop()
      }
    }
  }

  if (pieces.length === 0 || !isUrl(url)) return null
  return { url, pieces }
}

/**
 * Find every URL visible in `rows`, rejoining those split across rows by either
 * terminal soft-wrap or an application's own line breaking.
 */
export function findWrappedUrls(rows: BufferRow[], cols: number): WrappedUrl[] {
  const found: WrappedUrl[] = []

  for (let r = 0; r < rows.length; r++) {
    const content = contentRegion(rows[r].text, cols)
    if (!content.text) continue

    const rex = new RegExp(URL_REGEX.source, URL_REGEX.flags)
    let match: RegExpExecArray | null
    while ((match = rex.exec(content.text))) {
      const built = buildFrom(rows, cols, r, content, match.index, match[0])
      if (built) found.push(built)
    }
  }

  return found
}

// ─── xterm binding ────────────────────────────────────────────────────────────

/** How far above/below the hovered row to look for the rest of a wrapped URL. */
const WINDOW_ROWS = 40

/**
 * Link provider that reconstructs URLs split across rows.
 *
 * The stock web-links addon only stitches rows the terminal itself wrapped
 * (`isWrapped`). Full-screen apps — Claude Code's login prompt among them —
 * break long URLs themselves, often inside a drawn panel, so those rows carry no
 * wrap flag and the addon linkifies only the first fragment.
 *
 * Each row's slice becomes its own link carrying the full reconstructed URL, so
 * the hover underline hugs the URL text instead of painting across the panel
 * borders, and clicking any fragment opens the whole thing.
 */
export class WrappedLinkProvider implements ILinkProvider {
  constructor(
    private readonly _terminal: Terminal,
    private readonly _activate: (event: MouseEvent, uri: string) => void
  ) {}

  public provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const buf = this._terminal.buffer.active
    const cols = this._terminal.cols
    const targetIdx = y - 1

    const top = Math.max(0, targetIdx - WINDOW_ROWS)
    const bottom = Math.min(buf.length - 1, targetIdx + WINDOW_ROWS)

    const rows: BufferRow[] = []
    for (let i = top; i <= bottom; i++) {
      const line = buf.getLine(i)
      const raw = line ? line.translateToString(false) : ''
      rows.push({
        text: raw.length >= cols ? raw.slice(0, cols) : raw.padEnd(cols, ' '),
        isWrapped: line?.isWrapped ?? false
      })
    }

    const target = targetIdx - top
    const links: ILink[] = []

    for (const { url, pieces } of findWrappedUrls(rows, cols)) {
      for (const piece of pieces) {
        if (piece.row !== target) continue
        links.push({
          range: {
            start: { x: piece.startCol + 1, y: top + piece.row + 1 },
            end: { x: piece.endCol + 1, y: top + piece.row + 1 }
          },
          text: url,
          activate: this._activate
        })
      }
    }

    callback(links.length ? links : undefined)
  }
}
