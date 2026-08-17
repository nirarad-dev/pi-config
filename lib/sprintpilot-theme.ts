/**
 * Cursor Dark, as published at https://cmuxthemes.com/themes/cursor-dark/.
 *
 * That page defines a terminal theme: a background, a foreground, and the
 * sixteen ANSI slots. It carries no syntax-token or diff mappings. The purple,
 * yellow, and near-white below are sampled from Cursor's own rendering; the
 * rest assign the palette's colours using the conventional terminal
 * mapping — blue for keywords, green for strings, yellow for numeric literals,
 * purple for constants, cyan for types and callables. The diff colours reuse
 * the palette's green and red rather than introducing hues it does not contain.
 *
 * Two deliberate departures from the raw palette, both for legibility on this
 * background:
 *   - Comments lift the palette's bright black (#505050) to #6f6f6f. At
 *     #505050 on #141414 the contrast is roughly 2:1, which is below the point
 *     where comments stay readable.
 *   - Ordinary code uses #d6d6dd rather than the theme's #ffffff
 *     foreground, which is reserved for emphasis. Pure white on every token
 *     flattens the highlighting it is supposed to sit beneath.
 */

export const CURSOR_DARK = {
  background: "#141414",
  foreground: "#ffffff",
  text: "#d6d6dd",
  black: "#2a2a2a",
  brightBlack: "#505050",
  comment: "#6f6f6f",
  red: "#bf616a",
  green: "#a3be8c",
  yellow: "#e5c993",
  blue: "#81a1c1",
  purple: "#a7a0f4",
  cyan: "#88c0d0",
} as const;

const token = (color: string) => ({ color });

/**
 * Prism style object for react-syntax-highlighter.
 *
 * `code`/`pre` carry no font, line-height, or text-shadow: the diff viewer
 * paints word-level backgrounds on a layer beneath this text, and any metric
 * the theme sets for itself would shift the glyphs off that layer.
 */
export const cursorDarkPrismTheme: Record<string, React.CSSProperties> = {
  'code[class*="language-"]': { color: CURSOR_DARK.text, background: "none" },
  'pre[class*="language-"]': { color: CURSOR_DARK.text, background: CURSOR_DARK.background },

  comment: { color: CURSOR_DARK.comment, fontStyle: "italic" },
  prolog: token(CURSOR_DARK.comment),
  doctype: token(CURSOR_DARK.comment),
  cdata: token(CURSOR_DARK.comment),

  punctuation: token(CURSOR_DARK.text),
  operator: token(CURSOR_DARK.blue),

  keyword: token(CURSOR_DARK.blue),
  "keyword.control": token(CURSOR_DARK.blue),
  atrule: token(CURSOR_DARK.blue),
  "attr-value": token(CURSOR_DARK.green),
  "attr-name": token(CURSOR_DARK.green),
  tag: token(CURSOR_DARK.blue),
  selector: token(CURSOR_DARK.blue),

  string: token(CURSOR_DARK.green),
  char: token(CURSOR_DARK.green),
  regex: token(CURSOR_DARK.yellow),
  url: token(CURSOR_DARK.green),

  number: token(CURSOR_DARK.yellow),
  boolean: token(CURSOR_DARK.purple),
  constant: token(CURSOR_DARK.purple),
  symbol: token(CURSOR_DARK.purple),

  // Types move to cyan now that numbers hold the yellow, so a literal and a
  // type name stay distinguishable.
  "class-name": token(CURSOR_DARK.cyan),
  builtin: token(CURSOR_DARK.cyan),
  function: token(CURSOR_DARK.cyan),
  "function-variable": token(CURSOR_DARK.cyan),

  variable: token(CURSOR_DARK.text),
  property: token(CURSOR_DARK.text),
  parameter: token(CURSOR_DARK.text),
  namespace: token(CURSOR_DARK.cyan),

  important: { color: CURSOR_DARK.red, fontWeight: "bold" },
  deleted: token(CURSOR_DARK.red),
  inserted: token(CURSOR_DARK.green),
  entity: token(CURSOR_DARK.cyan),
};
