import path from "node:path";

describe("published package consumption", () => {
  it("loads the declared CommonJS entry point from the package root", () => {
    const packageRoot = path.resolve(__dirname, "../..");
    const packageJson = require(path.join(packageRoot, "package.json"));
    const resolvedEntry = require.resolve(packageRoot);
    const sdk = require(packageRoot);

    expect(resolvedEntry).toBe(path.join(packageRoot, packageJson.main));
    expect(typeof sdk.canonicalize).toBe("function");
    expect(sdk.ErrorRegistry).toBeDefined();
  });
});