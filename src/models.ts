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
  /** True when a turn on this model is billed per token against a prepaid
   * balance, rather than covered by the flat subscription (2026-08-10,
   * Edvard's hard rule in issues.md — that balance had $16 left and will
   * not be refilled). The picker had no way to show this, and the labels
   * pointed the wrong way: the metered "Claude Haiku 4.5" reads like the
   * plain choice and the free one carries the technical "(CLI)" suffix.
   *
   * Deliberately left undefined on the Gemini entries rather than set to
   * false — that key's billing status has not been measured, and guessing
   * "free" here is exactly the mistake this field exists to prevent. The
   * UI only marks `metered === true`. */
  metered?: boolean;
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
    metered: true,
    supportsThinking: false,
    contextWindow: "200K",
  },
  {
    id: "anthropic:claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "anthropic",
    metered: true,
    supportsThinking: true,
    contextWindow: "1M",
  },
  {
    id: "anthropic:claude-opus-4-8",
    label: "Claude Opus 4.8",
    provider: "anthropic",
    metered: true,
    supportsThinking: true,
    contextWindow: "1M",
  },
  {
    id: "anthropic:claude-opus-5",
    label: "Claude Opus 5",
    provider: "anthropic",
    metered: true,
    supportsThinking: true,
    contextWindow: "1M",
  },
  {
    id: "anthropic:claude-fable-5",
    label: "Claude Fable 5",
    provider: "anthropic",
    metered: true,
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
  // Fable 5 was reachable through the raw API above but not through the
  // CLI, so no tool-using persona could run on it. `claude --model
  // claude-fable-5` works (verified live 2026-08-09), so this is only a
  // catalog entry.
  //
  // Do NOT reach for this to save quota. Measured 2026-08-09 on the
  // identical prompt and 257KB input, cold session both times: Fable
  // $2.47 / 106s / 10,353 output tokens against Opus 5 $0.71 / 59s /
  // 5,770 -- 3.5x the cost AND 1.8x the wall time for a same-length
  // answer, i.e. worse on both axes at once. Cause is already stated
  // above: Fable's thinking is always on and cannot be turned off (that
  // is what `supportsThinking: false` means here, unlike Haiku), so it
  // pays to reason even about a mechanical task. It also has its own
  // weekly cap on top of the shared one, filling ~2.7x faster
  // (agora-claude-bridge#23).
  //
  // That is one workload -- bulk summarisation of a large input, which is
  // the shape that punishes always-on thinking hardest. Short prompts may
  // well go the other way (a trivial one returned in 2.3s), but that has
  // not been measured properly, so it is not a recommendation yet.
  {
    id: "claude-cli:claude-fable-5",
    label: "Claude Fable 5 (CLI)",
    provider: "claude-cli",
    supportsThinking: false,
    contextWindow: "1M",
  },
  // Fable 5.1, the successor to the entry above. Added 2026-09-13 on
  // Edvard's capture asking whether a larger model is worth buying for
  // long-horizon project work: the catalog only offered Fable 5, so the
  // question could not be tried at all through Agora. `claude --model
  // claude-fable-5-1` answers on the subscription (verified live
  // 2026-09-13), so this is only a catalog entry.
  //
  // CLI-only on purpose, unlike Fable 5, which also has an `anthropic:`
  // twin above. The raw-API entries are metered against a prepaid balance
  // Edvard will not refill, and the thing this model is wanted for is a
  // multi-hour run — the one shape that must never be able to reach the
  // meter. The "offers every anthropic model through the CLI as well"
  // test is a superset check, so CLI-only passes it.
  //
  // What it costs, measured 2026-09-13 against Opus 5 on one identical
  // prompt, cold `--print` session both times, a single-shot build of a
  // ~310-line module plus its own unittest suite: Fable 5.1 $2.01 / 297s
  // / 28,314 output tokens against Opus 5 $0.80 / 360s / 29,035 -- so
  // 2.5x the cost and 1.2x FASTER, which is the opposite of the Fable 5
  // reading above on both axes. Quality came out level: both passed all
  // eight properties of an independent judge (2,000 head inserts, 2,000
  // tail, 500 into one gap, 1,000 random, both error paths, rebalance),
  // both wrote a green suite of their own, and both shared the same
  // defect of letting keys grow to ~400 characters.
  //
  // So on a bounded single-shot task there is no measured quality gain
  // to pay 2.5x for. That is NOT a verdict on what Edvard asked about --
  // a multi-hour agentic run with tools -- which nothing here has
  // measured, and which the 45-minute CLI_TIMEOUT_SECONDS in the bridge
  // currently forbids anyway. See nova/resources/research/
  // fable-51-vs-opus-5-2026-09-13.md.
  {
    id: "claude-cli:claude-fable-5-1",
    label: "Claude Fable 5.1 (CLI)",
    provider: "claude-cli",
    supportsThinking: false,
    contextWindow: "1M",
  },
];
