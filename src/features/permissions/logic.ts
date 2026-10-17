// Pure helpers for the Permissions view. Backend: src-tauri/src/permissions.rs.

export type PermissionKind =
  | "notifications"
  | "screen_recording"
  | "microphone"
  | "full_disk_access"
  | "files_and_folders"
  | "automation"
  | "rec_microphone"
  | "rec_system_audio"
  | "rec_accessibility";

export type PermissionState =
  | "granted"
  | "denied"
  | "not_determined"
  | "unknown"
  | "not_installed"
  | "not_running"
  | "not_needed";

export interface PermissionStatus {
  kind: PermissionKind;
  state: PermissionState;
  /** Grant shows a system prompt instead of opening System Settings. */
  can_prompt: boolean;
}

export interface PermissionsReport {
  bundle_id: string;
  signing: { requirement: string | null; ad_hoc: boolean };
  items: PermissionStatus[];
}

export type PermissionGroupId = "butter" | "terminal" | "butter_rec";

export interface PermissionCopy {
  group: PermissionGroupId;
  name: string;
  reason: string;
  /** Status text when macOS can't be asked without prompting. */
  unknown: string;
}

export const PERMISSION_COPY: Record<PermissionKind, PermissionCopy> = {
  notifications: {
    group: "butter",
    name: "Notifications",
    reason: "Tells you when an agent finishes or needs input.",
    unknown: "Can't check",
  },
  screen_recording: {
    group: "butter",
    name: "Screen Recording",
    reason: "Screen recordings started from Butter.",
    unknown: "Can't check",
  },
  microphone: {
    group: "butter",
    name: "Microphone",
    reason: "Your voice in screen recordings.",
    unknown: "Can't check",
  },
  full_disk_access: {
    group: "terminal",
    name: "Full Disk Access",
    reason: "Commands can read any file, including other apps' data, without asking.",
    unknown: "Can't check",
  },
  files_and_folders: {
    group: "terminal",
    name: "Desktop, Documents and Downloads",
    reason: "macOS asks the first time a command opens one of these folders.",
    unknown: "Asked per folder",
  },
  automation: {
    group: "terminal",
    name: "Automation",
    reason: "Commands control other apps with AppleScript (osascript).",
    unknown: "Asked per app",
  },
  rec_microphone: {
    group: "butter_rec",
    name: "Microphone",
    reason: "Dictation and your side of meetings.",
    unknown: "Can't check",
  },
  rec_system_audio: {
    group: "butter_rec",
    name: "System Audio Recording",
    reason: "The other side of calls in meeting recordings.",
    unknown: "Asked on first meeting",
  },
  rec_accessibility: {
    group: "butter_rec",
    name: "Accessibility",
    reason: "Pastes dictated text into the app you're typing in.",
    unknown: "Can't check",
  },
};

export const PERMISSION_GROUPS: { id: PermissionGroupId; title: string }[] = [
  { id: "butter", title: "Butter" },
  { id: "terminal", title: "For apps run in Butter's terminals" },
  { id: "butter_rec", title: "ButterRec" },
];

export const groupPermissions = (items: PermissionStatus[]) =>
  PERMISSION_GROUPS.map((group) => ({
    ...group,
    items: items.filter((item) => PERMISSION_COPY[item.kind]?.group === group.id),
  })).filter((group) => group.items.length > 0);

export const stateLabel = (item: PermissionStatus): string => {
  switch (item.state) {
    case "granted":
      return "On";
    case "denied":
      return "Off";
    case "not_determined":
      return "Not asked yet";
    case "not_installed":
      return "Not installed";
    case "not_running":
      return "Not running";
    case "not_needed":
      return "Not needed";
    default:
      return PERMISSION_COPY[item.kind]?.unknown ?? "Can't check";
  }
};

/** Dot color class: on, off (needs action) or neutral. */
export const stateTone = (state: PermissionState): "on" | "off" | "neutral" =>
  state === "granted" ? "on" : state === "denied" || state === "not_determined" ? "off" : "neutral";

/** Rows that get a Grant button: ones Butter can do something about. */
export const canAct = (state: PermissionState) =>
  state === "granted" || state === "denied" || state === "not_determined" || state === "unknown";

/** The certificate name in a designated requirement, if there is one. */
export const signerName = (requirement: string | null): string | null => {
  if (!requirement) return null;
  const match = /subject\.CN\] = "([^"]+)"/.exec(requirement);
  return match ? match[1] : null;
};
