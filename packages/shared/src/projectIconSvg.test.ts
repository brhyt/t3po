import { describe, expect, it } from "@effect/vitest";

import { PROJECT_ICON_SVG_MAX_BYTES, sanitizeProjectIconSvg } from "./projectIconSvg.ts";

const icon = (body: string, rootAttributes = 'viewBox="0 0 16 16"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${rootAttributes}>${body}</svg>`;

describe("sanitizeProjectIconSvg", () => {
  it("re-serializes an allowed icon, adding the namespace and dropping comments and declarations", () => {
    const result = sanitizeProjectIconSvg(
      `<?xml version="1.0"?>\n<!-- drawn by the lead -->\n<svg viewBox='0 0 16 16' xmlns:xlink="http://www.w3.org/1999/xlink">
        <defs><linearGradient id="g"><stop offset="0" stop-color="#0ea5e9"/></linearGradient></defs>
        <title>Studio &amp; Co</title>
        <rect width="16" height="16" rx="4" fill="url(#g)"/>
        <path d="M4 8h8" stroke="#fff" stroke-width="2"></path>
      </svg>`,
    );
    expect(result).toEqual({
      ok: true,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><defs><linearGradient id="g"><stop offset="0" stop-color="#0ea5e9"/></linearGradient></defs><title>Studio &amp; Co</title><rect width="16" height="16" rx="4" fill="url(#g)"/><path d="M4 8h8" stroke="#fff" stroke-width="2"/></svg>',
    });
  });

  it.each([
    ["a script element", icon("<script>alert(1)</script>")],
    ["an event handler", icon('<rect width="16" height="16" onload="alert(1)"/>')],
    ["an uppercase event handler", icon('<rect width="16" height="16" ONCLICK="alert(1)"/>')],
    ["a root event handler", icon("", 'viewBox="0 0 16 16" onload="alert(1)"')],
    [
      "foreignObject",
      icon('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"/></foreignObject>'),
    ],
    [
      "an embedded image",
      icon('<image href="data:image/png;base64,AAAA" width="16" height="16"/>'),
    ],
    ["a use reference", icon('<use href="https://example.com/sprite.svg#a"/>')],
    ["an xlink href", icon('<rect xlink:href="https://example.com" width="1" height="1"/>')],
    ["an anchor", icon('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>')],
    ["a style element", icon("<style>@import url(https://example.com/x.css);</style>")],
    ["a style attribute", icon('<rect width="1" height="1" style="fill:red"/>')],
    [
      "an external url paint",
      icon('<rect width="1" height="1" fill="url(https://example.com/x)"/>'),
    ],
    [
      "an entity-encoded external url",
      icon('<rect width="1" height="1" fill="&#x75;rl(https://example.com/x)"/>'),
    ],
    [
      "a css-escaped url",
      icon('<rect width="1" height="1" fill="u\\72l(https://example.com/x)"/>'),
    ],
    ["a javascript value", icon('<rect width="1" height="1" fill="javascript:alert(1)"/>')],
    [
      "a doctype with entities",
      '<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><text>&a;</text></svg>',
    ],
    ["a CDATA section", icon("<text><![CDATA[<script>alert(1)</script>]]></text>")],
    ["a processing instruction", icon('<?xml-stylesheet href="https://example.com/x.css"?>')],
    [
      "a filter element",
      icon('<filter id="f"><feImage href="https://example.com/x.png"/></filter>'),
    ],
    [
      "a foreign namespace",
      icon("", 'viewBox="0 0 16 16" xmlns:html="http://www.w3.org/1999/xhtml"'),
    ],
    ["a non-svg root", '<html><svg viewBox="0 0 1 1"/></html>'],
    ["two roots", `${icon("")}${icon("")}`],
    ["unclosed markup", '<svg viewBox="0 0 1 1"><g>'],
    ["mismatched tags", '<svg viewBox="0 0 1 1"><g></svg></g>'],
    ["an unquoted attribute", "<svg viewBox=0>"],
    ["stray text", icon("hello")],
    [
      "a missing viewBox",
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
    ],
    ["an oversized icon", icon(`<path d="${"M0 0".repeat(PROJECT_ICON_SVG_MAX_BYTES)}"/>`)],
  ])("rejects %s", (_name, svg) => {
    expect(sanitizeProjectIconSvg(svg).ok).toBe(false);
  });

  it("escapes decoded text so markup cannot be smuggled in", () => {
    const result = sanitizeProjectIconSvg(icon("<text>&lt;script&gt;</text>"));
    expect(result).toEqual({
      ok: true,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text>&lt;script&gt;</text></svg>',
    });
  });
});
