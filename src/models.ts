export interface ModelOption {
  /** "<provider>:<model id>" — what a conversation's `model` field stores. */
  id: string;
  label: string;
  provider: "anthropic" | "gemini" | "claude-cli";
  /** Whether the thinking toggle does anything for this model. Haiku
   * doesn't support thinking at all; Fable 5's thinking is always on and
   * can't be turned off — both are `false` here for the same UI reason
   * (hide the toggle), even though the underlying reason differs. */
  supportsThinking: boolean;
  /** Phase 5 capability badge (Feature-Ideas.md #34) — static metadata
   * only, no live capability grants yet (that's Decisions/0002, Phase 6/7).
   * Left undefined rather than guessed where not confidently known. */
  contextWindow?: string;
}

// Current-generation models only — not every legacy/deprecated snapshot.
// "-latest" aliases used for Gemini rather than a pinned dated snapshot:
// a pinned gemini-2.5-flash 404'd ("no longer available to new users")
// against this project's API key, see agora-gemini-poc's deploy notes.
export const MODEL_CATALOG: ModelOption[] = [
  {
    id: "anthropic:claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    supportsThinking: false,
    contextWindow: "200K",
  },
  {
    id: "anthropic:claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "anthropic",
    supportsThinking: true,
    contextWindow: "1M",
  },
  {
    id: "anthropic:claude-opus-4-8",
    label: "Claude Opus 4.8",
    provider: "anthropic",
    supportsThinking: true,
    contextWindow: "1M",
  },
  {
    id: "anthropic:claude-opus-5",
    label: "Claude Opus 5",
    provider: "anthropic",
    supportsThinking: true,
    contextWindow: "1M",
  },
  {
    id: "anthropic:claude-fable-5",
    label: "Claude Fable 5",
    provider: "anthropic",
    supportsThinking: false,
    contextWindow: "1M",
  },
  {
    id: "gemini:gemini-flash-latest",
    label: "Gemini Flash",
    provider: "gemini",
    supportsThinking: true,
  },
  {
    id: "gemini:gemini-flash-lite-latest",
    label: "Gemini Flash Lite",
    provider: "gemini",
    supportsThinking: true,
  },
  {
    id: "gemini:gemini-pro-latest",
    label: "Gemini Pro",
    provider: "gemini",
    supportsThinking: true,
  },
  // Pinned snapshots below, added 2026-07-22 alongside the "-latest" aliases
  // above so free-tier users aren't limited to whatever "latest" currently
  // resolves to. Each was live-tested for generateContent access under this
  // project's API key before being added -- gemini-2.5-flash/-flash-lite were
  // tried too and 404'd ("no longer available to new users", same failure
  // mode noted above for a pinned 2.5 snapshot) so they're deliberately
  // excluded. If any entry below starts 404ing the same way, pull it.
  {
    id: "gemini:gemini-3-flash-preview",
    label: "Gemini 3 Flash (Preview)",
    provider: "gemini",
    supportsThinking: true,
  },
  {
    id: "gemini:gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    provider: "gemini",
    supportsThinking: true,
  },
  {
    id: "gemini:gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    provider: "gemini",
    supportsThinking: true,
  },
  {
    id: "gemini:gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash Lite",
    provider: "gemini",
    supportsThinking: true,
  },
  {
    id: "gemini:gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    provider: "gemini",
    supportsThinking: true,
  },
  // claude-cli (2026-08-01): same underlying models as the anthropic:
  // entries above, reached via a persistent Claude Code CLI session
  // (agora-claude-bridge) instead of the raw Messages API -- subscription-
  // authenticated once real credentials are wired in, not billed per
  // token. Chat mode only for now (no tool loop) -- see
  // agora-persona-runner's providers/claude_cli.py.
  {
    id: "claude-cli:claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5 (CLI)",
    provider: "claude-cli",
    supportsThinking: false,
    contextWindow: "200K",
  },
  {
    id: "claude-cli:claude-sonnet-5",
    label: "Claude Sonnet 5 (CLI)",
    provider: "claude-cli",
    supportsThinking: true,
    contextWindow: "1M",
  },
  {
    id: "claude-cli:claude-opus-4-8",
    label: "Claude Opus 4.8 (CLI)",
    provider: "claude-cli",
    supportsThinking: true,
    contextWindow: "1M",
  },
  {
    id: "claude-cli:claude-opus-5",
    label: "Claude Opus 5 (CLI)",
    provider: "claude-cli",
    supportsThinking: true,
    contextWindow: "1M",
  },
];
