# Asupersync Leverage Inventory

- Bead: `bd-xdcrh.1`
- Date: 2026-03-10
- Scope: identify only the places where more `asupersync` leverage is likely to improve cancel-correctness, deadline propagation, quiescent shutdown, or runtime ownership.

This is not a rewrite wishlist. Pi already gets real value from `asupersync` in the runtime bootstrap, provider HTTP/TLS stack, extension budget model, and many tool/test paths. The goal here is to leave behind a precise map of the remaining high-ROI sites so downstream beads can start from concrete code locations instead of rerunning archaeology.

## Decision Legend

- `keep`: current shape already matches the runtime intent, or change would likely be aesthetic only.
- `refactor`: high-confidence improvement with a bounded surface.
- `defer`: plausible future work, but only after higher-value context/thread-ownership fixes or with measured evidence.

## Cluster 1: Extension/session helper surfaces still mint fresh request contexts

- Recommendation: `refactor`
- Why it matters: these helpers are reached from extension hostcall and interactive event flows that already have a meaningful current `Cx` or manager-level timeout. Creating a brand-new request scope at the helper boundary disconnects session locking and immediate-save work from the caller's deadline/cancellation semantics.
- Minimal targeted refactor:
  - Use `AgentCx::for_current_or_request()` or `Cx::current().unwrap_or_else(Cx::for_request)` at trait/helper boundaries where threading `&AgentCx` through the trait is awkward.
  - If a helper already sits on an internal API boundary, prefer accepting `&AgentCx` directly instead of recreating one.
- Exact modules and functions:
  - `src/session.rs`
    - `impl ExtensionSession for SessionHandle::{get_state,get_messages,get_entries,get_branch,set_name,append_message,append_custom_entry,set_model,get_model,set_thinking_level,get_thinking_level,set_label}`
  - `src/interactive/ext_session.rs`
    - `InteractiveExtensionHostActions::append_to_session`
    - `impl ExtensionSession for InteractiveExtensionSession::{get_state,get_messages,get_entries,get_branch,set_name,append_message,append_custom_entry,set_model,get_model,set_thinking_level,get_thinking_level,set_label}`
  - `src/agent.rs`
    - `AgentSessionHostActions::append_to_session`
- Keep unchanged:
  - The trait split between `ExtensionSession` and `ExtensionHostActions`
  - The current idle-vs-streaming enqueue semantics for extension messages
- Downstream beads:
  - `bd-xdcrh.2.1`
  - `bd-xdcrh.5`

## Cluster 2: Agent/RPC helper layers already have a live context but recreate request scope anyway

- Recommendation: `refactor`
- Why it matters: the top-level async flows already have a natural request lifetime, but several nested helpers recreate `AgentCx::for_request()` instead of inheriting that scope. That weakens future deadline/checkpoint work and makes cancellation behavior less explainable than it needs to be.
- Minimal targeted refactor:
  - Create one `AgentCx` near the top of each run/turn path and thread clones or references downward.
  - Keep the existing explicit-`cx` pattern where it already exists, then extend it to the nested helpers below it.
- Exact modules and functions:
  - `src/rpc.rs`
    - `run`
    - `run_prompt_with_retry` already accepts `cx: AgentCx`; preserve that pattern
    - `run_extension_command` already accepts `cx: AgentCx`; preserve that pattern
    - `apply_thinking_level`
    - `apply_model_change`
    - `maybe_auto_compact`
    - `rpc_emit_extension_ui_request`
  - `src/agent.rs`
    - `AgentSession::{set_provider_model,sync_runtime_selection_from_session_header,maybe_compact,apply_compaction_result,compact_synchronous,enable_extensions_with_policy,save_and_index,persist_session,revert_last_user_message}`
  - `src/main.rs`
    - `run` session snapshot/model-history/shutdown-flush lock sections
- Keep unchanged:
  - `src/rpc.rs::run_prompt_with_retry` carrying an explicit `AgentCx` parameter
  - `src/rpc.rs::run_extension_command` carrying an explicit `AgentCx` parameter
  - The current runtime split between CLI/bootstrap and mode-specific execution
- Downstream beads:
  - `bd-xdcrh.2.2`
  - `bd-xdcrh.2.3`
  - `bd-xdcrh.3`
  - `bd-xdcrh.5`

## Cluster 3: Session persistence and discovery still rely on raw threads plus oneshot rendezvous

- Recommendation: `refactor`
- Why it matters: the raw-thread wrappers do isolate blocking work, but the waiting side also recreates fresh request contexts. That means outer cancellation and shutdown budgets do not naturally propagate into the wait path, and worker ownership lives outside the runtime even when the caller is already async.
- Minimal targeted refactor:
  - Migrate the JSONL scan/open/save wrappers to `asupersync::runtime::spawn_blocking_io` or a small runtime-owned blocking helper.
  - Accept an inherited `&AgentCx` or `&Cx` for the wait path instead of constructing a new request context internally.
  - For SQLite helpers, pass the caller context through instead of minting a new one inside the helper.
- Exact modules and functions:
  - `src/session.rs`
    - `Session::resume_with_picker`
    - `Session::continue_recent_in_dir`
    - `Session::open_v2_with_diagnostics`
    - `Session::open_jsonl_with_diagnostics`
    - `Session::save_inner`
    - `scan_sessions_on_disk`
  - `src/session_sqlite.rs`
    - `load_session`
    - `load_session_meta`
    - `save_session`
    - `append_entries`
- Keep unchanged:
  - JSONL atomic temp-file persist behavior
  - Session index reconciliation heuristics
  - SQLite schema/layout choices
- Downstream beads:
  - `bd-xdcrh.2.1`
  - `bd-xdcrh.4.1`
  - `bd-xdcrh.5`

## Cluster 4: Background compaction is async work running on a thread-owned runtime

- Recommendation: `refactor`
- Why it matters: compaction is provider/network work, not plain blocking I/O. Today it launches on a dedicated OS thread that builds a fresh current-thread runtime per attempt. That preserves foreground responsiveness, but it also gives up structured task ownership and direct cancellation inheritance.
- Minimal targeted refactor:
  - Keep the two-phase worker state machine and quota logic.
  - Rehost the actual compaction future on the existing multi-thread runtime behind an owned task handle and explicit shutdown/abort path.
- Exact modules and functions:
  - `src/compaction_worker.rs`
    - `CompactionWorkerState::start`
    - `run_compaction_thread`
  - `src/agent.rs`
    - `AgentSession::maybe_compact`
    - `AgentSession::compact_synchronous`
    - `AgentSession::apply_compaction_result`
- Keep unchanged:
  - Cooldown/attempt-count quota policy
  - The non-blocking "apply finished result, then maybe launch next compaction" model
- Downstream beads:
  - `bd-xdcrh.4.2`
  - `bd-xdcrh.3`
  - `bd-xdcrh.5`

## Cluster 5: Pipe pumps and subprocess cleanup threads are mostly acceptable as-is

- Recommendation: `keep` for now, with a narrow `defer` for measurement-based follow-up
- Why it matters: these threads are tied to blocking OS pipes and short-lived child-process cleanup. Replacing them preemptively with generic runtime blocking lanes is not obviously better, and several of these surfaces already combine timeouts with explicit kill/cleanup logic correctly.
- Exact modules and functions:
  - `src/tools.rs`
    - `BashTool::execute`
    - `GrepTool::execute`
    - `FindTool::execute`
    - `ProcessGuard::drop`
  - `src/extensions.rs`
    - extension exec/tool child-process pump paths
  - `src/extension_dispatcher.rs`
    - extension exec/command child-process pump paths
- Keep unchanged:
  - `src/tools.rs::{EditTool::execute,WriteTool::execute,HashlineEditTool::execute}` using `spawn_blocking_io` for atomic writes
  - `AgentCx::for_current_or_request()` timer usage in tool polling loops
  - Current `TERM -> grace -> KILL` and process-tree cleanup semantics
- Defer only if evidence appears:
  - thread proliferation under parallel subprocess load
  - shutdown hangs or orphan cleanup regressions
  - measurable contention that runtime-owned blocking lanes would clearly solve
- Downstream beads:
  - `bd-xdcrh.4.3`

## Cluster 6: Long-lived loop/checkpoint work should wait until inherited-context fixes land

- Recommendation: `defer`, then revisit with focused tests
- Why it matters: several loops already use timer-driver-aware `now` calculations, but explicit checkpoint/cancellation discipline is hard to evaluate cleanly while the surrounding helper layers are still recreating fresh request contexts.
- Exact modules and functions to revisit after Clusters 1-4:
  - `src/rpc.rs`
    - `run_prompt_with_retry` retry backoff loop
    - `maybe_auto_compact`
    - `rpc_emit_extension_ui_request`
  - `src/tools.rs`
    - `BashTool::execute`
    - `GrepTool::execute`
    - `FindTool::execute`
  - `src/compaction_worker.rs`
    - `CompactionWorkerState::try_recv`
- Keep unchanged right now:
  - timer-driver-aware `now` lookups in `src/tools.rs` and `src/http/client.rs`
  - extension manager timeout clamping via `ExtensionManager::effective_timeout`
- Downstream beads:
  - `bd-xdcrh.3`
  - `bd-xdcrh.3.1`
  - `bd-xdcrh.5`

## High-Confidence Keep Surface

These are the places where Pi is already using `asupersync` in the right way and should be treated as baseline patterns, not cleanup targets:

- `src/http/client.rs`
  - `RequestBuilder::send`
  - response timeout paths that consult `Cx::current()` for timer-driver time
- `src/extensions.rs`
  - `cx_with_deadline`
  - `ExtensionManager::{with_budget,set_budget,extension_cx,effective_timeout,dispatch_event*,execute_command,execute_shortcut}`
- `src/tools.rs`
  - `EditTool::execute`
  - `WriteTool::execute`
  - `HashlineEditTool::execute`
  - wide use of `asupersync::fs` and `spawn_blocking_io`
- `src/interactive.rs`
  - the TUI core itself is not the leverage problem; the actionable context issue is in `src/interactive/ext_session.rs`

## Testing Obligations For Downstream Work

Existing strong examples:

- `src/extensions.rs` budget/timeout tests
- `src/http/client.rs` deterministic timeout/stream tests
- `src/tools.rs` broad `asupersync::test_utils::run_test` coverage

Coverage gaps worth filling as code lands:

1. Session/extension-session helper calls should inherit a current deadline instead of silently creating an unbounded request scope.
2. Session JSONL/SQLite worker wrappers should prove cancellation and shutdown behavior when the caller budget expires mid-wait.
3. Compaction worker changes should prove that background work respects shutdown budgets and does not outlive the owning runtime.
4. RPC retry/auto-compaction paths should prove deadline propagation across nested helper calls.

## Recommended Execution Order

1. `bd-xdcrh.2.1`: fix session and extension-session helper inheritance first.
2. `bd-xdcrh.2.2`: thread inherited `AgentCx` through RPC control/model/thinking helpers.
3. `bd-xdcrh.2.3`: thread inherited `AgentCx` through agent and interactive background helpers.
4. `bd-xdcrh.4.1`: move session JSONL/SQLite worker islands under runtime-owned blocking execution.
5. `bd-xdcrh.4.2`: migrate background compaction ownership onto the runtime.
6. `bd-xdcrh.3` and `bd-xdcrh.3.1`: revisit checkpoint boundaries once the inherited-context work is in place.
7. `bd-xdcrh.4.3`: only revisit subprocess pipe pumps if measured evidence says the current thread model is a real problem.
8. `bd-xdcrh.5`: land deterministic tests alongside each slice instead of saving them for the end.
9. `bd-xdcrh.6` and `bd-xdcrh.6.1`: only escalate to broader supervision/AppSpec work if lifecycle hazards remain after the narrow fixes above.
