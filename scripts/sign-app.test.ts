// Unit tests for scripts/sign-app.sh's identity choice. Run: npm run test:composer
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./sign-app.sh", import.meta.url));

const pick = (findIdentityOutput: string) => {
  const result = spawnSync("bash", [SCRIPT, "--pick-identity"], { input: findIdentityOutput, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const DEV_HASH = "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678";
const DEVID_HASH = "0F1E2D3C4B5A69788796A5B4C3D2E1F00F1E2D3C";

test("picks the Apple Development identity by hash", () => {
  const out = `  1) ${DEV_HASH} "Apple Development: jane@example.com (QC7TVYBFM6)"
     1 valid identities found
`;
  assert.equal(pick(out), `${DEV_HASH}\tApple Development: jane@example.com (QC7TVYBFM6)`);
});

test("prefers Developer ID Application over Apple Development, wherever it is listed", () => {
  const out = `  1) ${DEV_HASH} "Apple Development: jane@example.com (QC7TVYBFM6)"
  2) 1111111111111111111111111111111111111111 "Apple Distribution: Jane Doe (TEAM123456)"
  3) ${DEVID_HASH} "Developer ID Application: Jane Doe (TEAM123456)"
     3 valid identities found
`;
  assert.equal(pick(out), `${DEVID_HASH}\tDeveloper ID Application: Jane Doe (TEAM123456)`);
});

test("takes the first of several Apple Development identities", () => {
  const out = `  1) ${DEV_HASH} "Apple Development: first@example.com (AAAAAAAAAA)"
  2) 2222222222222222222222222222222222222222 "Apple Development: second@example.com (BBBBBBBBBB)"
     2 valid identities found
`;
  assert.equal(pick(out), `${DEV_HASH}\tApple Development: first@example.com (AAAAAAAAAA)`);
});

test("nothing usable means no identity (ad-hoc)", () => {
  assert.equal(pick("     0 valid identities found\n"), "");
  assert.equal(pick(""), "");
  assert.equal(
    pick(`  1) 1111111111111111111111111111111111111111 "Apple Distribution: Jane Doe (TEAM123456)"\n`),
    "",
  );
});
