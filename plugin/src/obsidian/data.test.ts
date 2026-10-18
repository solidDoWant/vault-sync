import { describe, expect, it } from "vitest";

import { parsePluginData, serverBaseUrl, signInProblem, type PluginData } from "./data";

const complete: PluginData = { serverUrl: "https://sync.example", oidcIssuer: "https://auth.example/o/vs/", oidcClientId: "vault-sync" };

describe("parsePluginData", () => {
  it("defaults everything when nothing is stored", () => {
    expect(parsePluginData(null)).toEqual({ serverUrl: "", oidcIssuer: "", oidcClientId: "" });
  });

  it("keeps stored fields, including the refresh token", () => {
    expect(parsePluginData({ ...complete, refreshToken: "secret" })).toEqual({ ...complete, refreshToken: "secret" });
  });

  it("ignores fields of the wrong type and an empty refresh token", () => {
    expect(parsePluginData({ serverUrl: 5, oidcIssuer: "https://auth.example/", refreshToken: "" })).toEqual({
      serverUrl: "",
      oidcIssuer: "https://auth.example/",
      oidcClientId: "",
    });
  });
});

describe("signInProblem", () => {
  it("accepts complete https settings", () => {
    expect(signInProblem(complete)).toBeUndefined();
  });

  it("asks for each missing setting", () => {
    expect(signInProblem({ ...complete, serverUrl: " " })).toBe("Enter the server URL.");
    expect(signInProblem({ ...complete, oidcIssuer: "" })).toBe("Enter the OIDC issuer URL.");
    expect(signInProblem({ ...complete, oidcClientId: "" })).toBe("Enter the OIDC client ID.");
  });

  it("refuses plain http except to localhost, so tokens never travel in the clear", () => {
    expect(signInProblem({ ...complete, serverUrl: "http://sync.example" })).toMatch(/server URL must use https/);
    expect(signInProblem({ ...complete, oidcIssuer: "http://auth.example/" })).toMatch(/issuer URL must use https/);
    expect(signInProblem({ ...complete, serverUrl: "http://127.0.0.1:8080", oidcIssuer: "http://localhost:9000/" })).toBeUndefined();
    expect(signInProblem({ ...complete, serverUrl: "sync.example" })).toMatch(/not a valid URL/);
  });
});

describe("serverBaseUrl", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(serverBaseUrl({ ...complete, serverUrl: " https://sync.example/base// " })).toBe("https://sync.example/base");
  });
});
