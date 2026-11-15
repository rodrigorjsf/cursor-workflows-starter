// Seam: the predicate that says where the Cursor SDK may send the API key. The SDK reads CURSOR_BACKEND_URL (the API and the token
// exchange) and CURSOR_WEBSITE_URL (login) from the environment and sends the key to whatever they hold, with no check of its own:
// the kit refuses a value that is not an https URL on cursor.sh or cursor.com, before the SDK is called. The cases are hosts a
// check written as a prefix test or an unanchored match lets through, and a message must never repeat the userinfo of a URL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_ENDPOINT_VARIABLES, cursorEndpointProblems, cursorEndpointRefusal } from "../src/runtime/cursor-endpoints.js";

const problemsOf = (value: string) => cursorEndpointProblems({ CURSOR_BACKEND_URL: value });

test("the two variables the SDK reads for an endpoint are the ones checked", () => {
  assert.deepEqual([...CURSOR_ENDPOINT_VARIABLES], ["CURSOR_BACKEND_URL", "CURSOR_WEBSITE_URL"]);
});

test("an https URL on cursor.sh or cursor.com, on the bare domain or any subdomain, with or without a path, is accepted", () => {
  for (const value of [
    "https://api2.cursor.sh",
    "https://api2.cursor.sh/",
    "https://api.cursor.com",
    "https://cursor.com",
    "https://cursor.sh/some/path",
    "https://a.b-c.cursor.sh/v1",
    "https://eu1.api2.cursor.com/",
  ]) {
    assert.deepEqual(problemsOf(value), [], value);
  }
});

test("a variable that is unset or empty is not a problem: the SDK falls back to its own endpoint", () => {
  assert.deepEqual(cursorEndpointProblems({}), []);
  assert.deepEqual(cursorEndpointProblems({ CURSOR_BACKEND_URL: undefined, CURSOR_WEBSITE_URL: "" }), []);
});

test("a plain-text scheme, another host, and every spelling that makes a host look like cursor.sh are refused", () => {
  for (const value of [
    "http://api.cursor.sh",
    "HTTPS://api2.cursor.sh",
    "https://evil.example",
    "https://evil.example/cursor.sh",
    "https://evil.example/?x=https://api2.cursor.sh",
    "https://cursor.sh.evil.example",
    "https://cursor.com.evil.example/",
    "https://evilcursor.sh",
    "https://notcursor.com/",
    "https://api2.cursor.sh@evil.example/",
    "https://cursor.sh@evil.example",
    "https://user:secret@api2.cursor.sh",
    "https://api2.cursor.sh:8443",
    "https://api2.cursor.sh\\@evil.example",
    "https://api2.cursor.sh.",
    "https://127.0.0.1:8080",
    "https://localhost",
    "//api2.cursor.sh",
    "api2.cursor.sh",
    "ftp://api2.cursor.sh",
    " https://api2.cursor.sh",
    "https://api2.cursor.sh\nhttps://evil.example",
  ]) {
    assert.equal(problemsOf(value).length, 1, `${JSON.stringify(value)} must be refused`);
  }
});

test("both variables are checked, each problem names its variable, and the refusal is one sentence per problem", () => {
  const env = { CURSOR_BACKEND_URL: "http://api.cursor.sh", CURSOR_WEBSITE_URL: "https://evil.example/login" };
  assert.deepEqual(cursorEndpointProblems(env).map((p) => p.variable), ["CURSOR_BACKEND_URL", "CURSOR_WEBSITE_URL"]);
  const refusal = cursorEndpointRefusal(env)!;
  assert.match(refusal, /CURSOR_BACKEND_URL is http:\/\/api\.cursor\.sh/);
  assert.match(refusal, /CURSOR_WEBSITE_URL is https:\/\/evil\.example/);
  assert.match(refusal, /https URL on cursor\.sh or cursor\.com/, "it says what is accepted");
  assert.equal(cursorEndpointRefusal({ CURSOR_BACKEND_URL: "https://api2.cursor.sh" }), undefined);
});

test("a message shows the scheme and host of the value and nothing else: no userinfo, no path, no query, and no text that is not a URL", () => {
  const secret = "s3cr3t-token";
  for (const value of [`https://user:${secret}@evil.example/path?token=${secret}`, `https://evil.example/${secret}`, `${secret}`, `not a url ${secret}`]) {
    const refusal = cursorEndpointRefusal({ CURSOR_BACKEND_URL: value })!;
    assert.ok(refusal, value);
    assert.ok(!refusal.includes(secret), `${JSON.stringify(refusal)} repeats part of the value`);
  }
  assert.match(cursorEndpointRefusal({ CURSOR_BACKEND_URL: "https://user:pw@evil.example:8443/x" })!, /CURSOR_BACKEND_URL is https:\/\/evil\.example:8443,/);
  assert.match(cursorEndpointRefusal({ CURSOR_BACKEND_URL: "gibberish" })!, /CURSOR_BACKEND_URL is not a URL,/);
});
