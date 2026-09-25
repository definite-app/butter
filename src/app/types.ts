export type SearchDirection = "next" | "prev";

export interface ThemeConfig {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
}

export interface AppearanceConfig {
  font_family: string;
  font_size: number;
  line_height: number;
  cursor_style: string;
  cursor_blink: boolean;
  theme: ThemeConfig;
}

export interface GeneralConfig {
  default_shell: string;
  default_directory: string;
  confirm_close_with_running_process: boolean;
}

export interface UiConfig {
  sidebar_width: number;
  show_tags_by_default: boolean;
}

export interface ConfigPreset {
  id: string;
  name: string;
  directory?: string;
  command?: string;
  tags: string[];
  footer?: boolean;
  worktree?: boolean;
}

export interface TagsConfig {
  list: string[];
}

export interface PresetsConfig {
  items: ConfigPreset[];
}

export interface AppConfig {
  version: number;
  general: GeneralConfig;
  appearance: AppearanceConfig;
  ui: UiConfig;
  presets: PresetsConfig;
  tags: TagsConfig;
}

export interface WebSession {
  id: string;
  title: string;
  createdAt: number;
  directory?: string;
  command?: string;
}

export type WorkspaceFileTabKind = "text_file" | "image_file";

interface WorkspaceFileTabBase {
  id: string;
  ownerSessionId: string;
  path: string;
  displayName: string;
  loading: boolean;
  error: string | null;
}

export interface WorkspaceTextFileTab extends WorkspaceFileTabBase {
  kind: "text_file";
  content: string;
  savedContent: string;
  dirty: boolean;
}

export interface WorkspaceImageFileTab extends WorkspaceFileTabBase {
  kind: "image_file";
  imageUrl: string | null;
  dirty: false;
}

export type WorkspaceFileTab = WorkspaceTextFileTab | WorkspaceImageFileTab;

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserSessionState {
  sessionId: string;
  open: boolean;
  visible: boolean;
  loading: boolean;
  url: string;
  title: string;
  profilePath?: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  bounds?: BrowserBounds | null;
  lastError?: string | null;
}

export interface DbSession {
  id: string;
  title: string;
  directory: string | null;
  command: string | null;
  created_at: number;
  last_accessed_at: number | null;
  is_closed: boolean;
  closed_at: number | null;
  agent_kind: string | null;
  agent_session_id: string | null;
  agent_cwd: string | null;
  agent_last_seen_at: number | null;
}

export type AgentKind = "claude" | "codex";

/** Per-terminal agent snapshot used to restart/resume the agent on reopen. */
export interface SessionAgentInfo {
  kind: AgentKind;
  agentSessionId: string | null;
  cwd: string | null;
  lastSeenAt: number;
  /** Original launch command, so resume can preserve flags (e.g. --dangerously-skip-permissions). */
  command?: string | null;
}

export interface DbScrollback {
  session_id: string;
  content: string;
  updated_at: number;
}

export interface TerminalPreset {
  id: string;
  name: string;
  directory?: string;
  command?: string;
  tags?: string[];
  footer?: boolean;
  worktree?: boolean;
}

export interface FileBrowserEntry {
  name: string;
  path: string;
  relative_path: string;
  is_dir: boolean;
  is_hidden: boolean;
  size: number | null;
}

export type RecorderState = "idle" | "recording" | "processing" | "error";

export interface RecordingTranscriptionResult {
  videoPath: string;
  transcriptPath: string;
  transcriptJsonPath: string;
  transcriptText: string;
  model: string;
}

export interface RecordingClipboardEvent {
  timestampMs: number;
  text: string;
}

export interface ClipboardHistoryEntry {
  id: number;
  kind: "text" | "image";
  text: string | null;
  imagePath: string | null;
  sourceApp: string | null;
  byteLen: number;
  contentHash: string;
  createdAt: number;
}

export type PasteQueueItemKind = "image" | "recording";

export interface PasteQueueItem {
  kind: PasteQueueItemKind;
  path: string;
  url: string;
  filename: string;
}

export type AppView = "terminal" | "canvas" | "team";
export type CanvasTool = "select" | "pen";
export type CanvasFileKind = "text" | "image" | "binary";

export interface TeamUser {
  id: string;
  username: string;
  display_name: string;
  avatar_color: string | null;
  pwd: string;
  cmd: string;
  description: string | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface TeamChannel {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface TeamConversation {
  id: string;
  kind: "channel" | "dm" | "group_dm";
  channel_id: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface TeamMessage {
  id: string;
  conversation_id: string;
  author_kind: "human" | "agent" | "system";
  author_user_id: string | null;
  content: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  status: string;
  parent_message_id: string | null;
  thread_reply_count: number;
  last_reply_at: number | null;
  pty_session_id: string | null;
}

export interface TeamAgentRun {
  id: string;
  trigger_message_id: string;
  reply_parent_message_id: string;
  user_id: string;
  pty_session_id: string | null;
  agent_kind: "claude" | "codex" | null;
  agent_session_id: string | null;
  cwd: string;
  command_template: string;
  rendered_command: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  started_at: number | null;
  completed_at: number | null;
  exit_code: number | null;
  error: string | null;
}

export interface TeamInboxItem {
  message: TeamMessage;
  conversation: TeamConversation;
  channel: TeamChannel | null;
  author: TeamUser | null;
  parent_message: TeamMessage | null;
  delivered_at: number | null;
  read_at: number | null;
}

export interface TeamSearchResult {
  message: TeamMessage;
  conversation: TeamConversation;
  channel: TeamChannel | null;
  author: TeamUser | null;
  parent_message: TeamMessage | null;
}

export type TeamPinKind = "file" | "message" | "link";

export interface TeamPin {
  id: string;
  kind: TeamPinKind;
  title: string;
  file_path: string | null;
  url: string | null;
  message_id: string | null;
  message_conversation_id: string | null;
  message_parent_message_id: string | null;
  message_preview: string | null;
  created_at: number;
  updated_at: number;
}

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasStroke {
  tool: "pen";
  points: CanvasPoint[];
}

interface CanvasObjectBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export interface CanvasTextObject extends CanvasObjectBase {
  type: "text";
  text: string;
}

export interface CanvasImageObject extends CanvasObjectBase {
  type: "image";
  path: string;
  name: string;
}

export interface CanvasTerminalObject extends CanvasObjectBase {
  type: "terminal";
  sessionId: string;
}

export interface CanvasFileObject extends CanvasObjectBase {
  type: "file";
  path: string;
  name: string;
  fileKind: CanvasFileKind;
  textContent?: string;
  error?: string;
}

export type CanvasObject =
  | CanvasTextObject
  | CanvasImageObject
  | CanvasTerminalObject
  | CanvasFileObject;

export interface CanvasBoard {
  objects: CanvasObject[];
  strokes: CanvasStroke[];
  activeTool: CanvasTool;
  selectedObjectId: string | null;
  selectedObjectIds: string[];
  zoom: number;
}

// ===== Conversation history search (cc-search) =====

export interface CcSearchSnippet {
  role: string;
  ts: string | null;
  text: string;
}

export interface CcSearchResult {
  session_id: string;
  project_dir: string | null;
  cwd: string | null;
  git_branch: string | null;
  file_path: string | null;
  title: string | null;
  latest_match: string | null;
  match_count: number;
  snippets: CcSearchSnippet[];
}

export interface CcFetchResponse {
  session_id: string;
  mode: string;
  count?: number;
  text?: string;
  error?: string;
}

export interface CcSearchResponse {
  query: string;
  results?: CcSearchResult[];
  elapsed_ms?: number;
  db_age_min?: number | null;
  error?: string;
}
