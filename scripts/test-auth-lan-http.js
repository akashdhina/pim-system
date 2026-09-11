/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require("assert");

const {
  AuthError,
  assertSafeStateChange,
  clearSessionCookie,
  sessionCookie,
} = require("../lib/pim-auth");

const previousNodeEnv = process.env.NODE_ENV;
const previousAllowHttpLan = process.env.PIM_ALLOW_HTTP_LAN;

function setEnv(nodeEnv, allowHttpLan) {
  process.env.NODE_ENV = nodeEnv;

  if (allowHttpLan === undefined) {
    delete process.env.PIM_ALLOW_HTTP_LAN;
  } else {
    process.env.PIM_ALLOW_HTTP_LAN = allowHttpLan;
  }
}

function assertCookieBasics(cookie) {
  assert.match(cookie, /pim_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Expires=/);
}

function lanPost(origin = "http://192.168.1.13:3000") {
  return new Request("http://192.168.1.13:3000/api/pim/auth/login", {
    method: "POST",
    headers: {
      host: "192.168.1.13:3000",
      origin,
    },
  });
}

try {
  setEnv("production", "1");

  const lanCookie = sessionCookie("test-token", "2030-01-01T00:00:00.000Z");
  assertCookieBasics(lanCookie);
  assert.doesNotMatch(lanCookie, /(^|; )Secure($|;)/);

  const lanClearCookie = clearSessionCookie();
  assertCookieBasics(lanClearCookie);
  assert.doesNotMatch(lanClearCookie, /(^|; )Secure($|;)/);

  assert.doesNotThrow(() => assertSafeStateChange(lanPost()));

  setEnv("production");
  const productionCookie = sessionCookie("test-token", "2030-01-01T00:00:00.000Z");
  assertCookieBasics(productionCookie);
  assert.match(productionCookie, /(^|; )Secure($|;)/);

  setEnv("development");
  const developmentCookie = sessionCookie("test-token", "2030-01-01T00:00:00.000Z");
  assertCookieBasics(developmentCookie);
  assert.doesNotMatch(developmentCookie, /(^|; )Secure($|;)/);
  assert.doesNotThrow(() => assertSafeStateChange(lanPost()));

  setEnv("production", "1");
  assert.throws(
    () => assertSafeStateChange(lanPost("http://malicious.example")),
    (error) =>
      error instanceof AuthError &&
      error.status === 403 &&
      error.message === "Invalid request origin."
  );

  console.log("PIM LAN HTTP auth tests passed.");
} finally {
  if (previousNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previousNodeEnv;
  }

  if (previousAllowHttpLan === undefined) {
    delete process.env.PIM_ALLOW_HTTP_LAN;
  } else {
    process.env.PIM_ALLOW_HTTP_LAN = previousAllowHttpLan;
  }
}
