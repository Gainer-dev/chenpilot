const {
  basicUsageExample,
  multiSignatureExample,
} = require("../examples/basic-usage.ts");

async function main() {
  await basicUsageExample();
  await multiSignatureExample();
}

main().catch((error) => {
  console.error("Selected SDK quick-start examples failed:", error);
  process.exitCode = 1;
});