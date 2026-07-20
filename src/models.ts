export interface ModelOption {
  /** "<provider>:<model id>" — what a conversation's `model` field stores. */
  id: string;
  label: string;
  provider: "anthropic" | "gemini";
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
];
