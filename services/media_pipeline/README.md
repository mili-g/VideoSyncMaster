# Media Pipeline Service

## Directory Layout

- `bootstrap/`: startup, dependency activation, and runtime environment bootstrap helpers.
- `infra/`: cross-cutting infrastructure utilities such as logging, event emission, and FFmpeg resolution.
- `runners/`: worker-oriented runtime helpers.
- `vsm/`: application workflows, DTOs, and interface adapters.
- flat `*.py` modules: legacy-compatible domain and orchestration modules that are being migrated incrementally.

## Current Migration Rules

1. New shared capabilities should prefer `bootstrap/` or `infra/` instead of adding more root-level utility modules.
2. Existing imports from `app_logging.py`, `event_protocol.py`, and `ffmpeg_utils.py` remain valid through compatibility shims.
3. `main.py` should keep delegating bootstrap concerns outward instead of growing more startup code inline.
4. TTS runtime activation and warmup now belong in `bootstrap/tts_runtime.py`; future engine switches should extend that module first.
5. Python dependency cache switching now belongs in `bootstrap/dependency_runtime.py`; `dependency_manager.py` remains as a compatibility facade.
6. Legacy CLI action router wiring is being centralized in `bootstrap/action_router_factory.py` so `main.py` stays focused on composition and process entry.
7. Basic CLI actions are being migrated into `vsm/app/workflows/basic_actions_workflow.py`; `action_handlers.py` now serves as a compatibility shim.
8. TTS reference-audio preparation helpers are being migrated into `vsm/app/workflows/tts_reference_workflow.py`; `tts_action_handlers.py` is being thinned incrementally instead of moved in one risky step.

## Design Patterns In Use

- `Facade`: `main.py` is being reduced into a process-entry facade over bootstrap, workflows, and legacy adapters.
- `Strategy`: translation now selects an external batch strategy or local sequential strategy in `vsm/app/workflows/translation_workflow.py`.
- `Command`: `vsm/app/workflows/action_router.py` now dispatches through a command registry instead of a growing `if` chain.
- `Factory`: `bootstrap/action_router_factory.py` and `bootstrap/tts_runtime.py` assemble runtime-specific handlers and runners.
- `Application Service`: media execution, translation, dubbing, and worker execution are moving into `vsm/app/workflows/*` instead of living in the process entry file.
- `Incremental Strangler`: large legacy files such as `tts_action_handlers.py` are being decomposed helper-by-helper behind stable call sites instead of rewritten wholesale.
- `Compatibility Shim`: root-level modules such as `dependency_manager.py`, `app_logging.py`, and `event_protocol.py` preserve old imports while implementation moves inward.

## Why This Improves Extensibility

- Adding a new CLI action now only needs a new command registration instead of editing router branching logic.
- Adding a new translation backend can reuse the workflow boundary and introduce another strategy without rewriting callers.
- Adding a new TTS runtime keeps dependency activation in one factory-oriented module instead of scattering checks across workflows.
- Adding a new worker protocol or execution surface can extend the application workflow layer without rewriting startup/bootstrap code.
- Legacy callers remain stable while the internal package structure becomes more explicit and replaceable.

## Preferred Patterns For Future Features

- New `action` types: use `Command` registration in the router factory.
- New translation or inference backends: use `Strategy` behind an existing workflow boundary.
- New runtime/environment switching logic: use `Factory` or dedicated bootstrap modules.
- New end-to-end business flows: add an application workflow module in `vsm/app/workflows/`.
- Old import paths that external callers may still use: keep `Compatibility Shim` files until migration is complete.

## Near-Term Refactor Targets

- Extract more startup orchestration from `main.py` into `bootstrap/`.
- Move cache, dependency, and process concerns into explicit infrastructure modules.
- Reduce the number of root-level service files after compatibility windows are no longer needed.
