import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

describe("home path resolution", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.chdir(ORIGINAL_CWD);
  });

  it("defaults to ~/.paperclip and default instance", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-home-paths-"));
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    process.chdir(home);

    const paths = describeLocalInstancePaths();
    expect(paths.homeDir).toBe(home);
    expect(paths.instanceId).toBe("default");
    expect(paths.activeSpaceId).toBe("default");
    expect(paths.activeSpaceRoot).toBe(
      path.resolve(home, "instances", "default", "spaces", "default"),
    );
    expect(paths.configPath).toBe(
      path.resolve(home, "instances", "default", "spaces", "default", "config.json"),
    );
  });

  it("supports PAPERCLIP_HOME and explicit instance ids", () => {
    process.env.PAPERCLIP_HOME = "~/paperclip-home";

    const home = resolvePaperclipHomeDir();
    expect(home).toBe(path.resolve(os.homedir(), "paperclip-home"));
    expect(resolvePaperclipInstanceId("dev_1")).toBe("dev_1");
  });

  it("rejects invalid instance ids", () => {
    expect(() => resolvePaperclipInstanceId("bad/id")).toThrow(/Invalid PAPERCLIP_INSTANCE_ID/);
  });

  it("expands ~ prefixes", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });
});
