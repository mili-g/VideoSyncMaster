from __future__ import annotations

from vsm.app.contracts import describe_backend_commands
from vsm.app.dto.backend_request import BackendWorkerResponse
from vsm.app.workflows.action_router import WorkflowExecutionContext


def execute_action(
    args,
    *,
    build_asr_runtime_config,
    build_tts_kwargs,
    build_translation_kwargs,
    services,
    error_result,
    make_error,
    set_event_context,
    clear_event_context,
    build_action_router,
    log_error,
    logger,
):
    asr_kwargs = build_asr_runtime_config(args).to_runner_kwargs()
    tts_kwargs = build_tts_kwargs(args)
    extra_kwargs = build_translation_kwargs(args)
    set_event_context(action=args.action)
    try:
        router = build_action_router(
            args=args,
            asr_kwargs=asr_kwargs,
            tts_kwargs=tts_kwargs,
            extra_kwargs=extra_kwargs,
            services=services,
        )
        result = router.dispatch(WorkflowExecutionContext(action=args.action, args=args))
        if result is not None:
            return result

        available_actions = " | ".join(describe_backend_commands())
        log_error(logger, f"Unknown action: {args.action}", event="unknown_action", stage="dispatch", code="UNKNOWN_ACTION", retryable=False)
        return error_result(
            make_error(
                "UNKNOWN_ACTION",
                f"不支持的动作: {args.action}",
                category="validation",
                stage="dispatch",
                retryable=False,
                detail=f"Available backend commands: {available_actions}" if available_actions else "No registered commands",
                suggestion="请检查前端参数或升级到匹配版本的桌面端与后端"
            )
        )
    finally:
        clear_event_context()


def build_worker_error_response(request_id, error, *, debug_log, make_error):
    debug_log(f"Worker request failed: {error}")
    backend_error = make_error(
        "WORKER_REQUEST_FAILED",
        "后端工作线程请求执行失败",
        category="system",
        stage="worker",
        retryable=False,
        detail=str(error),
    )
    return BackendWorkerResponse(
        request_id=request_id,
        success=False,
        error=backend_error.message,
        error_info=backend_error.to_payload(),
    )


def execute_worker_request(parsed_args, request_id, *, scoped_event_context, execute_with_args):
    with scoped_event_context(trace_id=request_id or None, request_id=request_id or None):
        return execute_with_args(parsed_args)


def run_backend_worker_loop(
    base_args,
    *,
    build_parser,
    log_business,
    logger,
    logging,
    run_cli_worker_loop,
    stdout_print,
    sys_stdin,
    worker_result_prefix,
    execute_request,
    build_error_response,
):
    parser = build_parser()
    log_business(logger, logging.INFO, "Backend worker started", event="worker_started", stage="worker")
    run_cli_worker_loop(
        parser=parser,
        base_args=base_args,
        stdin=sys_stdin,
        stdout_write=lambda line: stdout_print(line, flush=True),
        worker_result_prefix=worker_result_prefix,
        execute_request=execute_request,
        build_error_response=build_error_response,
    )
