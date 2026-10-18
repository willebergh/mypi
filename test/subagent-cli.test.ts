import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolvePiCli } from "../extensions/subagents/cli.ts";

function fixture(t: test.TestContext, bin: string | Record<string, string>, version = "1.3.0") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mypi-cli-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, typeof bin === "string" ? bin : bin.pi);
  mkdirSync(path.dirname(cli), { recursive: true });
  writeFileSync(cli, "");
  const manifest = { name: "@earendil-works/pi-coding-agent", bin, version };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  const module = path.join(root, "dist/bundle/chunks/index.js");
  mkdirSync(path.dirname(module), { recursive: true });
  writeFileSync(module, "");
  const options = { sdkVersion: "1.3.0", packageDir: "/missing/package", managedRoot: path.join(root, "install") };
  return { root, cli, manifest, options, moduleUrl: pathToFileURL(module).href };
}

test("resolves bundled Pi from its manifest, not the chunks directory", (t) => {
  const pi = fixture(t, { pi: "dist/bundle/cli.js" });
  assert.equal(resolvePiCli("/missing/old/pi.js", pi.moduleUrl, pi.options), pi.cli);
});

test("supports legacy dist/cli.js and string bin manifests", (t) => {
  const pi = fixture(t, "dist/cli.js");
  assert.equal(resolvePiCli("/missing/pi.js", pi.moduleUrl, pi.options), pi.cli);
});

test("prefers the running Pi over the repository SDK, following symlinks", (t) => {
  const running = fixture(t, { pi: "dist/bundle/cli.js" });
  const sdk = fixture(t, { pi: "dist/cli.js" });
  const link = path.join(sdk.root, "pi");
  symlinkSync(running.cli, link);
  assert.equal(resolvePiCli(link, sdk.moduleUrl, sdk.options), running.cli);
});

test("fails clearly when neither installation has a CLI", (t) => {
  const pi = fixture(t, { pi: "dist/bundle/cli.js" });
  rmSync(pi.cli);
  assert.throws(() => resolvePiCli("/missing/pi.js", pi.moduleUrl, pi.options), /Cannot locate Pi's CLI/);
});

test("rejects an older local CLI instead of mixing RPC protocol versions", (t) => {
  const sdk = fixture(t, { pi: "dist/bundle/cli.js" }, "0.87.1");
  assert.throws(() => resolvePiCli("/removed/homebrew/pi.js", sdk.moduleUrl, sdk.options),
    /matching RPC client 1\.3\.0.*incompatible versions: 0\.87\.1/);
});

test("uses the SDK package when getPackageDir identifies the current host", (t) => {
  const host = fixture(t, { pi: "dist/bundle/cli.js" });
  const sdk = fixture(t, { pi: "dist/cli.js" }, "0.87.1");
  assert.equal(resolvePiCli("/removed/pi.js", sdk.moduleUrl, {
    ...sdk.options, packageDir: host.root,
  }), host.cli);
});

test("finds a matching managed installation after the old parent entrypoint was removed", (t) => {
  const sdk = fixture(t, { pi: "dist/cli.js" }, "0.87.1");
  const managed = path.join(sdk.options.managedRoot, "releases/1.3.0/node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(path.join(managed, "dist/bundle"), { recursive: true });
  writeFileSync(path.join(sdk.options.managedRoot, "current-version"), "1.3.0\n");
  writeFileSync(path.join(managed, "package.json"), JSON.stringify({
    ...sdk.manifest, version: "1.3.0", bin: { pi: "dist/bundle/cli.js" },
  }));
  const cli = path.join(managed, "dist/bundle/cli.js");
  writeFileSync(cli, "");
  assert.equal(resolvePiCli("/removed/homebrew/pi.js", sdk.moduleUrl, sdk.options), cli);
});

test("does not follow invalid managed release names outside releases", (t) => {
  const sdk = fixture(t, { pi: "dist/cli.js" }, "0.87.1");
  mkdirSync(sdk.options.managedRoot);
  writeFileSync(path.join(sdk.options.managedRoot, "current-version"), "../outside\n");
  assert.throws(() => resolvePiCli("/removed/pi.js", sdk.moduleUrl, sdk.options), /Restart Pi/);
});
