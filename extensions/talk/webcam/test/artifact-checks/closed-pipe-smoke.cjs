var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// fixture:electron
var app = { getPath: () => process.env.LOG_TEST_DIR };

// src/main/logging.ts
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"));
var import_node_util = require("node:util");
function brokenPipe(error) {
  return !!error && typeof error === "object" && "code" in error && error.code === "EPIPE";
}
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (!brokenPipe(error)) throw error;
  });
}
for (const method of ["log", "info", "warn", "error", "debug"]) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    if (method === "error") {
      try {
        const directory = app.getPath("userData");
        (0, import_node_fs.mkdirSync)(directory, { recursive: true });
        (0, import_node_fs.appendFileSync)(import_node_path.default.join(directory, "main-errors.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${(0, import_node_util.format)(...args)}
`);
      } catch {
      }
    }
    try {
      original(...args);
    } catch (error) {
      if (!brokenPipe(error)) throw error;
    }
  };
}

// <stdin>
setTimeout(() => {
  console.error("closed-pipe-smoke");
  console.log("stdout-smoke");
  setTimeout(() => process.exit(0), 100);
}, 100);
