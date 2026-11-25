import * as Schema from "effect/Schema";

/**
 * Strict allowlist sanitizer for project icons a lead draws as SVG. Input is tokenized and
 * re-serialized, so nothing outside the grammar below can pass through. Clients still render
 * the result through <img>, where SVG never runs scripts or loads resources.
 */
export const PROJECT_ICON_SVG_MAX_BYTES = 8192;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_DEPTH = 32;
const MAX_ELEMENTS = 500;

const ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "text",
  "tspan",
  "title",
  "desc",
]);
const TEXT_ELEMENTS = new Set(["text", "tspan", "title", "desc"]);

const ATTRIBUTES = new Set([
  "xmlns",
  "version",
  "id",
  "viewBox",
  "preserveAspectRatio",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "dx",
  "dy",
  "d",
  "points",
  "pathLength",
  "transform",
  "offset",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "clip-path",
  "clip-rule",
  "mask",
  "stop-color",
  "stop-opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
  "shape-rendering",
  "vector-effect",
  "paint-order",
]);
// Harmless declarations models often add; dropped rather than refused.
const DROPPED_ATTRIBUTES = new Set(["xmlns:xlink", "xml:space"]);

const NAME = /^[A-Za-z_][-A-Za-z0-9_.:]*/;
const ENTITY = /&(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});/g;
const LOCAL_URL = /^url\(#[A-Za-z_][-A-Za-z0-9_.]*\)$/;

export type ProjectIconSvgResult =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly reason: string };

interface Element {
  readonly name: string;
  readonly attributes: ReadonlyArray<readonly [string, string]>;
  readonly children: Array<Element | string>;
}

class Rejected extends Schema.TaggedError<Rejected>()("ProjectIconSvgRejected", {
  reason: Schema.String,
}) {}
const isRejected = Schema.is(Rejected);
function reject(reason: string): never {
  throw new Rejected({ reason });
}

function decodeEntities(text: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});)/.test(text))
    reject("Only the standard XML character references are allowed.");
  return text.replace(ENTITY, (entity) => {
    const named: Record<string, string> = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
    };
    if (named[entity]) return named[entity];
    const code =
      entity[2] === "x" ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    if (!Number.isInteger(code) || code > 0x10ffff) reject("Invalid character reference.");
    return String.fromCodePoint(code);
  });
}

const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, "&quot;");

function checkAttribute(element: string, name: string, rawValue: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) reject(`Event handler attribute "${name}" is not allowed.`);
  if (lower === "href" || lower.endsWith(":href")) reject("Links and references are not allowed.");
  if (lower === "style") reject("The style attribute is not allowed; use presentation attributes.");
  if (DROPPED_ATTRIBUTES.has(name)) return undefined;
  if (!ATTRIBUTES.has(name)) reject(`Attribute "${name}" is not allowed.`);
  const value = decodeEntities(rawValue);
  // CSS escapes could spell url( or other functions in presentation attributes.
  if (/[\\\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
    reject(`Attribute "${name}" contains a disallowed character.`);
  const compact = value.replace(/\s+/g, "").toLowerCase();
  if (compact.includes("url(") && !LOCAL_URL.test(value.trim()))
    reject("Only local url(#id) references are allowed.");
  if (/(?:javascript|vbscript|data):|expression\(|@import/.test(compact))
    reject(`Attribute "${name}" has a disallowed value.`);
  if (name === "xmlns") {
    if (element !== "svg" || value !== SVG_NAMESPACE) reject("Only the SVG namespace is allowed.");
  }
  return value;
}

function parse(input: string): Element {
  let index = 0;
  const skipWhitespace = () => {
    while (index < input.length && /\s/.test(input[index]!)) index += 1;
  };
  skipWhitespace();
  if (input.startsWith("<?xml", index)) {
    const end = input.indexOf("?>", index);
    if (end === -1) reject("Unterminated XML declaration.");
    index = end + 2;
  }
  const stack: Element[] = [];
  let root: Element | undefined;
  let elements = 0;
  while (index < input.length) {
    if (input.startsWith("<!--", index)) {
      const end = input.indexOf("-->", index + 4);
      if (end === -1) reject("Unterminated comment.");
      index = end + 3;
      continue;
    }
    if (input.startsWith("<!", index) || input.startsWith("<?", index))
      reject("DOCTYPE, entity, CDATA and processing instructions are not allowed.");
    if (input.startsWith("</", index)) {
      index += 2;
      const match = NAME.exec(input.slice(index));
      if (!match) reject("Malformed closing tag.");
      const name = match[0];
      index += name.length;
      skipWhitespace();
      if (input[index] !== ">") reject("Malformed closing tag.");
      index += 1;
      const open = stack.pop();
      if (!open || open.name !== name) reject(`Unexpected closing tag </${name}>.`);
      continue;
    }
    if (input[index] === "<") {
      index += 1;
      const match = NAME.exec(input.slice(index));
      if (!match) reject("Malformed tag.");
      const name = match[0];
      index += name.length;
      if (!ELEMENTS.has(name)) reject(`Element <${name}> is not allowed.`);
      if (root && stack.length === 0) reject("Only one root element is allowed.");
      if (!root && name !== "svg") reject("The root element must be <svg>.");
      if (stack.length >= MAX_DEPTH) reject("The SVG is nested too deeply.");
      elements += 1;
      if (elements > MAX_ELEMENTS) reject("The SVG has too many elements.");
      const attributes: Array<readonly [string, string]> = [];
      const seen = new Set<string>();
      let selfClosing = false;
      for (;;) {
        const before = index;
        skipWhitespace();
        if (input.startsWith("/>", index)) {
          index += 2;
          selfClosing = true;
          break;
        }
        if (input[index] === ">") {
          index += 1;
          break;
        }
        if (index === before) reject(`Malformed attributes on <${name}>.`);
        const attribute = NAME.exec(input.slice(index));
        if (!attribute) reject(`Malformed attributes on <${name}>.`);
        const attributeName = attribute[0];
        index += attributeName.length;
        skipWhitespace();
        if (input[index] !== "=") reject(`Attribute "${attributeName}" needs a quoted value.`);
        index += 1;
        skipWhitespace();
        const quote = input[index];
        if (quote !== '"' && quote !== "'")
          reject(`Attribute "${attributeName}" needs a quoted value.`);
        const end = input.indexOf(quote, index + 1);
        if (end === -1) reject(`Unterminated value for "${attributeName}".`);
        const rawValue = input.slice(index + 1, end);
        index = end + 1;
        if (rawValue.includes("<")) reject(`Attribute "${attributeName}" contains "<".`);
        if (seen.has(attributeName)) reject(`Duplicate attribute "${attributeName}".`);
        seen.add(attributeName);
        const value = checkAttribute(name, attributeName, rawValue);
        if (value !== undefined) attributes.push([attributeName, value]);
      }
      const element: Element = { name, attributes, children: [] };
      if (stack.length > 0) stack.at(-1)!.children.push(element);
      else root = element;
      if (!selfClosing) stack.push(element);
      continue;
    }
    const next = input.indexOf("<", index);
    const text = input.slice(index, next === -1 ? input.length : next);
    index = next === -1 ? input.length : next;
    if (text.trim() === "") continue;
    const parent = stack.at(-1);
    if (!parent || !TEXT_ELEMENTS.has(parent.name))
      reject("Text is only allowed inside <text>, <tspan>, <title> and <desc>.");
    parent.children.push(decodeEntities(text));
  }
  if (stack.length > 0) reject(`Unclosed element <${stack.at(-1)!.name}>.`);
  if (!root) reject("No <svg> element found.");
  return root;
}

function serialize(element: Element): string {
  const attributes = element.attributes
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  if (element.children.length === 0) return `<${element.name}${attributes}/>`;
  const children = element.children
    .map((child) => (typeof child === "string" ? escapeText(child) : serialize(child)))
    .join("");
  return `<${element.name}${attributes}>${children}</${element.name}>`;
}

export function sanitizeProjectIconSvg(input: string): ProjectIconSvgResult {
  if (new TextEncoder().encode(input).length > PROJECT_ICON_SVG_MAX_BYTES)
    return { ok: false, reason: `The SVG must be at most ${PROJECT_ICON_SVG_MAX_BYTES} bytes.` };
  try {
    const root = parse(input);
    if (!root.attributes.some(([name]) => name === "viewBox"))
      return { ok: false, reason: "The <svg> element needs a viewBox." };
    const withNamespace: Element = root.attributes.some(([name]) => name === "xmlns")
      ? root
      : { ...root, attributes: [["xmlns", SVG_NAMESPACE], ...root.attributes] };
    const svg = serialize(withNamespace);
    if (new TextEncoder().encode(svg).length > PROJECT_ICON_SVG_MAX_BYTES)
      return { ok: false, reason: `The SVG must be at most ${PROJECT_ICON_SVG_MAX_BYTES} bytes.` };
    return { ok: true, svg };
  } catch (error) {
    if (isRejected(error)) return { ok: false, reason: error.reason };
    throw error;
  }
}

/** Renders only through <img>, where SVG cannot run scripts or fetch resources. */
export function projectIconSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
