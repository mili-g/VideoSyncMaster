import type { BackendEventContext, StructuredErrorInfo } from '../types/workflow';

function coerceRecord(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' ? value as Record<string, any> : undefined;
}

export function normalizeBackendError(
    errorOrResult: unknown,
    fallbackMessage = '未知错误',
    context?: BackendEventContext
): StructuredErrorInfo {
    const record = coerceRecord(errorOrResult);
    const errorInfo = coerceRecord(record?.error_info);

    const message = String(
        errorInfo?.message
        || record?.error
        || (errorOrResult instanceof Error ? errorOrResult.message : '')
        || fallbackMessage
    );

    return {
        code: typeof errorInfo?.code === 'string' ? errorInfo.code : undefined,
        message,
        category: typeof errorInfo?.category === 'string' ? errorInfo.category : undefined,
        stage: typeof errorInfo?.stage === 'string' ? errorInfo.stage : undefined,
        retryable: typeof errorInfo?.retryable === 'boolean' ? errorInfo.retryable : undefined,
        detail: typeof errorInfo?.detail === 'string'
            ? errorInfo.detail
            : (errorOrResult instanceof Error && errorOrResult.message !== message ? errorOrResult.message : undefined),
        suggestion: typeof errorInfo?.suggestion === 'string' ? errorInfo.suggestion : undefined,
        traceId: context?.trace_id,
        requestId: context?.request_id,
        action: context?.action
    };
}

export function summarizeStructuredError(error?: StructuredErrorInfo) {
    if (!error) return '';
    const parts = [
        error.code ? `[${error.code}]` : '',
        error.message,
        error.category ? `分类: ${error.category}` : '',
        typeof error.retryable === 'boolean' ? `可重试: ${error.retryable ? '是' : '否'}` : '',
        error.traceId ? `Trace: ${error.traceId}` : ''
    ].filter(Boolean);
    return parts.join(' - ');
}

export function buildUserFacingErrorMessage(error?: StructuredErrorInfo) {
    if (!error) return '未知错误';
    return [
        error.code ? `[${error.code}]` : '',
        error.message,
        error.suggestion ? `建议: ${error.suggestion}` : ''
    ].filter(Boolean).join(' ');
}
