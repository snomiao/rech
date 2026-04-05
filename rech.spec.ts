import { describe, test, expect } from "bun:test";
import { parseUrl, authCheck, DEFAULT_PORT, ENV_KEY } from "./rech.ts";

describe("parseUrl", () => {
  test("parses key, host, and port from a remote-chrome URL", () => {
    const result = parseUrl("remote-chrome://mykey@example.com:9999");
    expect(result).toEqual({ key: "mykey", host: "example.com", port: 9999 });
  });

  test("falls back to DEFAULT_PORT when port is missing", () => {
    const result = parseUrl("remote-chrome://mykey@example.com");
    expect(result).toEqual({ key: "mykey", host: "example.com", port: DEFAULT_PORT });
  });

  test("handles URL-safe base64 characters in key", () => {
    const result = parseUrl("remote-chrome://ab_c-dEf12@host:8080");
    expect(result.key).toBe("ab_c-dEf12");
  });

  test("parses localhost URLs", () => {
    const result = parseUrl("remote-chrome://k@localhost:13775");
    expect(result).toEqual({ key: "k", host: "localhost", port: 13775 });
  });
});

describe("authCheck", () => {
  test("returns null for valid bearer token", () => {
    const req = new Request("http://localhost/run", {
      headers: { Authorization: "Bearer secret123" },
    });
    expect(authCheck(req, "secret123")).toBeNull();
  });

  test("returns 401 for wrong bearer token", () => {
    const req = new Request("http://localhost/run", {
      headers: { Authorization: "Bearer wrong" },
    });
    const res = authCheck(req, "secret123");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  test("returns 401 when no authorization header", () => {
    const req = new Request("http://localhost/run");
    const res = authCheck(req, "secret123");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  test("returns 401 for empty bearer token", () => {
    const req = new Request("http://localhost/run", {
      headers: { Authorization: "Bearer " },
    });
    const res = authCheck(req, "secret123");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });
});

describe("constants", () => {
  test("ENV_KEY is REMOTE_CHROME_URL", () => {
    expect(ENV_KEY).toBe("REMOTE_CHROME_URL");
  });

  test("DEFAULT_PORT is 13775", () => {
    expect(DEFAULT_PORT).toBe(13775);
  });
});
