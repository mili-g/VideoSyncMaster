from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class BackendExecutionContext:
    execute_with_args: Callable[[Any], Any]
    build_parser: Callable[[], Any]
    scoped_event_context: Callable[..., Any]
    emit_json_block: Callable[..., Any]
    stdout_print: Callable[..., Any]
    setup_gpu_paths: Callable[[Any], None]
    logger: Any


@dataclass(frozen=True)
class WorkerLoopContext:
    run_worker_loop: Callable[[list[str]], None]


def extract_worker_base_args(argv: list[str]) -> list[str]:
    if "--model_dir" not in argv:
        return []

    idx = argv.index("--model_dir")
    if idx + 1 >= len(argv):
        return []
    return ["--model_dir", argv[idx + 1]]


def run_cli_entrypoint(context: BackendExecutionContext) -> None:
    context.setup_gpu_paths(context.logger)
    parser = context.build_parser()
    args = parser.parse_args()
    cli_trace_id = f"cli:{args.action}"
    with context.scoped_event_context(trace_id=cli_trace_id, request_id=cli_trace_id):
        result_data = context.execute_with_args(args)

    if result_data is not None and args.json:
        context.emit_json_block(result_data, context.stdout_print)


def run_worker_entrypoint(context: WorkerLoopContext, argv: list[str]) -> None:
    context.run_worker_loop(extract_worker_base_args(argv))


def run_backend_entrypoint(
    *,
    argv: list[str],
    backend_context: BackendExecutionContext,
    worker_context: WorkerLoopContext,
    debug_log: Callable[[str], None],
    handle_unhandled_exception: Callable[[Exception], None],
    exit_process: Callable[[int], None],
    finalize_non_worker_process: Callable[[], None],
) -> None:
    debug_log("Entering main block")
    worker_mode = "--worker" in argv
    try:
        if worker_mode:
            run_worker_entrypoint(worker_context, argv)
        else:
            run_cli_entrypoint(backend_context)
    except Exception as error:
        handle_unhandled_exception(error)
        exit_process(1)

    debug_log("Main finished normally")
    if not worker_mode:
        finalize_non_worker_process()
