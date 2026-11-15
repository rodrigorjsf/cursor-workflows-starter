// Seam: the error boundary the two pages mount their root in. The fallback is rendered to static markup (`render.ts`: there is no DOM here),
// and the boundary's own contract, that whatever a child throws, even `undefined`, becomes a state that shows the fallback, is called
// as React calls it. That both entry files wrap their root in it is checked in ui.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBoundary, ErrorFallback } from "../app/ErrorBoundary.js";
import { errorText } from "../app/error-text.js";
import { render, textOf } from "./render.js";

test("the fallback shows the error and a link that reloads the page", () => {
  const html = render(ErrorFallback, { error: new Error("graph exploded: <b>x</b>") });
  assert.match(textOf(html), /The dashboard hit an error/);
  assert.match(textOf(html), /graph exploded: <b>x<\/b>/, "the message is text, never markup");
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /<a [^>]*href=""[^>]*>Reload the page<\/a>/, "an empty href is this same address");
  assert.match(html, /role="alert"/);
});

test("what a thrown value says: an Error's message, a string, and something that is neither", () => {
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText("plain text"), "plain text");
  assert.equal(errorText(undefined), "an unknown error (nothing was thrown with it)");
  assert.equal(errorText({ code: 7 }), '{"code":7}');
  assert.equal(errorText(null), "an unknown error (nothing was thrown with it)");
});

test("a boundary around a child that renders shows the child, and a thrown value of any kind becomes a failed state", () => {
  assert.equal(renderToStaticMarkup(createElement(ErrorBoundary, null, createElement("p", null, "all good"))), "<p>all good</p>");
  for (const thrown of [new Error("x"), "text", undefined, null, 0]) {
    const state = ErrorBoundary.getDerivedStateFromError(thrown);
    assert.equal(state.failed, true, String(thrown));
  }
});
