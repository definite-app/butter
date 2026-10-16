// Unit tests for the Permissions view's pure helpers. Run: npm run test:composer
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canAct,
  groupPermissions,
  signerName,
  stateLabel,
  stateTone,
  type PermissionStatus,
} from "../src/features/permissions/logic.ts";

const item = (kind: PermissionStatus["kind"], state: PermissionStatus["state"]): PermissionStatus => ({
  kind,
  state,
  can_prompt: false,
});

test("rows group in a fixed order and empty groups drop out", () => {
  const groups = groupPermissions([
    item("rec_microphone", "granted"),
    item("microphone", "denied"),
    item("notifications", "granted"),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.id, g.items.map((i) => i.kind)]),
    [
      ["butter", ["microphone", "notifications"]],
      ["butter_rec", ["rec_microphone"]],
    ],
  );
});

test("status text and tone", () => {
  assert.equal(stateLabel(item("microphone", "granted")), "On");
  assert.equal(stateLabel(item("microphone", "not_determined")), "Not asked yet");
  assert.equal(stateLabel(item("files_and_folders", "unknown")), "Asked per folder");
  assert.equal(stateLabel(item("rec_system_audio", "unknown")), "Asked on first meeting");
  assert.equal(stateLabel(item("rec_accessibility", "not_needed")), "Not needed");
  assert.equal(stateTone("granted"), "on");
  assert.equal(stateTone("denied"), "off");
  assert.equal(stateTone("not_determined"), "off");
  assert.equal(stateTone("not_running"), "neutral");
  assert.ok(canAct("unknown"));
  assert.ok(!canAct("not_installed"));
  assert.ok(!canAct("not_needed"));
});

test("signer name comes from the requirement's leaf certificate", () => {
  assert.equal(
    signerName(
      'identifier "com.butter.app" and anchor apple generic and certificate leaf[subject.CN] = "Apple Development: a@b.c (QC7TVYBFM6)" and certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */',
    ),
    "Apple Development: a@b.c (QC7TVYBFM6)",
  );
  assert.equal(signerName('cdhash H"e382c00d"'), null);
  assert.equal(signerName(null), null);
});
