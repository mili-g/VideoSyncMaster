import sys
import os
import logging
current_script_dir = os.path.dirname(os.path.abspath(__file__))
if current_script_dir not in sys.path:
    sys.path.insert(0, current_script_dir)
from bootstrap.action_router_factory import build_action_router
from bootstrap.entrypoint import BackendExecutionContext, WorkerLoopContext, run_backend_entrypoint
from bootstrap.execution_services_factory import (
    ExecutionObservabilityDependencies,
    ExecutionRuntimeDependencies,
    ExecutionServiceFactoryContext,
    RuntimeProfileDependencies,
    build_execution_services,
)
from bootstrap.runtime_env import setup_gpu_paths
from bootstrap.startup_context import initialize_runtime_bootstrap
from bootstrap.tts_runtime import get_tts_runner as resolve_tts_runner, warmup_tts_runtime as run_tts_runtime_warmup
from infra.events import clear_event_context, emit_partial_result, emit_progress, emit_stage, scoped_event_context, set_event_context
from infra.logging import log_business, log_error

runtime_context = initialize_runtime_bootstrap(__file__, sys.argv)
logger = runtime_context.logger
_stdout_print = runtime_context.stdout_print
debug_log = runtime_context.debug_log
ffmpeg = runtime_context.ffmpeg_module
from cli_options import build_parser, build_tts_kwargs, build_translation_kwargs
from vsm.app.workflows.execution_runtime import (
    build_worker_error_response as build_worker_error_response_workflow,
    execute_action,
    execute_worker_request as execute_worker_request_workflow,
    run_backend_worker_loop,
)
from vsm.interfaces.cli.json_output import emit_json_block
from vsm.interfaces.cli.worker_host import run_worker_loop as run_cli_worker_loop
from dependency_manager import ensure_transformers_version, check_gpu_deps, get_installed_version, infer_runtime_profile, normalize_runtime_profile, resolve_runtime_profile_version
from error_model import emit_error_issue, error_result, exception_result, make_error
from runtime_config import build_asr_runtime_config

WORKER_RESULT_PREFIX = "__WORKER_RESULT__"
execution_services = build_execution_services(
    ExecutionServiceFactoryContext(
        runtime=ExecutionRuntimeDependencies(
            logger=logger,
            logging_module=logging,
            ffmpeg_module=ffmpeg,
            setup_gpu_paths=setup_gpu_paths,
        ),
        runtime_profiles=RuntimeProfileDependencies(
            resolve_tts_runner=resolve_tts_runner,
            run_tts_runtime_warmup=run_tts_runtime_warmup,
            ensure_transformers_version=ensure_transformers_version,
            check_gpu_deps=check_gpu_deps,
            get_installed_version=get_installed_version,
            infer_runtime_profile=infer_runtime_profile,
            normalize_runtime_profile=normalize_runtime_profile,
            resolve_runtime_profile_version=resolve_runtime_profile_version,
        ),
        observability=ExecutionObservabilityDependencies(
            log_business=log_business,
            log_error=log_error,
            emit_stage=emit_stage,
            emit_error_issue=emit_error_issue,
            error_result=error_result,
            make_error=make_error,
            exception_result=exception_result,
            emit_progress=emit_progress,
            emit_partial_result=emit_partial_result,
        ),
    )
)


def execute_with_args(args):
    return execute_action(
        args,
        build_asr_runtime_config=build_asr_runtime_config,
        build_tts_kwargs=build_tts_kwargs,
        build_translation_kwargs=build_translation_kwargs,
        services=execution_services,
        error_result=error_result,
        make_error=make_error,
        set_event_context=set_event_context,
        clear_event_context=clear_event_context,
        build_action_router=build_action_router,
        log_error=log_error,
        logger=logger,
    )


def build_worker_error_response(request_id, error):
    return build_worker_error_response_workflow(
        request_id,
        error,
        debug_log=debug_log,
        make_error=make_error,
    )


def execute_worker_request(parsed_args, request_id):
    return execute_worker_request_workflow(
        parsed_args,
        request_id,
        scoped_event_context=scoped_event_context,
        execute_with_args=execute_with_args,
    )


def run_worker_loop(base_args):
    run_backend_worker_loop(
        base_args,
        build_parser=build_parser,
        log_business=log_business,
        logger=logger,
        logging=logging,
        run_cli_worker_loop=run_cli_worker_loop,
        stdout_print=_stdout_print,
        sys_stdin=sys.stdin,
        worker_result_prefix=WORKER_RESULT_PREFIX,
        execute_request=execute_worker_request,
        build_error_response=build_worker_error_response,
    )


def handle_unhandled_exception(error):
    import traceback

    err_msg = traceback.format_exc()
    debug_log(f"Unhandled Exception in main:\n{err_msg}")
    logger.error("Unhandled exception in main: %s", error)
    logger.error(err_msg)


def finalize_non_worker_process():
    try:
        sys.stdout.close()
        sys.stderr.close()
    except Exception:
        pass
    os._exit(0)


if __name__ == "__main__":
    run_backend_entrypoint(
        argv=sys.argv,
        backend_context=BackendExecutionContext(
            execute_with_args=execute_with_args,
            build_parser=build_parser,
            scoped_event_context=scoped_event_context,
            emit_json_block=emit_json_block,
            stdout_print=_stdout_print,
            setup_gpu_paths=setup_gpu_paths,
            logger=logger,
        ),
        worker_context=WorkerLoopContext(run_worker_loop=run_worker_loop),
        debug_log=debug_log,
        handle_unhandled_exception=handle_unhandled_exception,
        exit_process=sys.exit,
        finalize_non_worker_process=finalize_non_worker_process,
    )
