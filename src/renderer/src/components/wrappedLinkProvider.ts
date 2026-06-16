import type { ILinkProvider, ILink, Terminal } from '@xterm/xterm'

// Same strict URL matcher the stock @xterm/addon-web-links uses: http(s):// up to
// the first whitespace/quote, trimming dangling punctuation/brackets.
const URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/g

// Cap how far we reconstruct across rows, mirroring the stock addon's guard.
const MAX_BLOCK_LENGTH = 2048

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
 * Link provider that reconstructs URLs split across rows.
 *
 * The stock web-links addon only stitches rows that xterm flagged `isWrapped`
 * (terminal soft-wrap). Full-screen apps (e.g. Claude Code's OAuth prompt) wrap
 * long URLs to the terminal width with their own line breaks, so those rows are
 * NOT `isWrapped` and the addon linkifies only the first row's fragment.
 *
 * We additionally treat a row that is filled to the last column ("full to edge")
 * as flowing into the next row, which captures hard-wrap-at-width. Every
 * reconstructed candidate is still validated with `new URL()` before it becomes
 * a link, so over-joining plain text can't produce a bogus link.
 */
export class WrappedLinkProvider implements ILinkProvider {
  constructor(
    private readonly _terminal: Terminal,
    private readonly _activate: (event: MouseEvent, uri: string) => void
  ) {}

  public provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const buf = this._terminal.buffer.active
    const cols = this._terminal.cols
    const start = y - 1

    // A row flows into the next when xterm soft-wrapped the next row, OR when
    // this row is filled to its last column (hard-wrap at width).
    const flowsDown = (index: number): boolean => {
      const cur = buf.getLine(index)
      const next = buf.getLine(index + 1)
      if (!cur || !next) return false
      if (next.isWrapped) return true
      const full = cur.translateToString(false)
      return (full[cols - 1] ?? ' ') !== ' '
    }

    // Walk up to the first row of the logical block, then down to the last.
    let top = start
    let length = cols
    while (top > 0 && flowsDown(top - 1) && length < MAX_BLOCK_LENGTH) {
      top--
      length += cols
    }
    let bottom = start
    length = (bottom - top + 1) * cols
    while (flowsDown(bottom) && length < MAX_BLOCK_LENGTH) {
      bottom++
      length += cols
    }

    // Concatenate rows untrimmed and normalized to exactly `cols` chars each, so
    // a string index maps cleanly back to (row, col): row = top + idx/cols.
    let text = ''
    for (let i = top; i <= bottom; i++) {
      const line = buf.getLine(i)
      const raw = line ? line.translateToString(false) : ''
      text += raw.length >= cols ? raw.slice(0, cols) : raw.padEnd(cols, ' ')
    }

    const rex = new RegExp(URL_REGEX.source, URL_REGEX.flags)
    const links: ILink[] = []
    let match: RegExpExecArray | null
    while ((match = rex.exec(text))) {
      const uri = match[0]
      if (!isUrl(uri)) continue
      const startIdx = match.index
      const endIdx = startIdx + uri.length - 1
      const range = {
        start: { x: (startIdx % cols) + 1, y: top + Math.floor(startIdx / cols) + 1 },
        end: { x: (endIdx % cols) + 1, y: top + Math.floor(endIdx / cols) + 1 }
      }
      links.push({ range, text: uri, activate: this._activate })
    }

    callback(links.length ? links : undefined)
  }
}
