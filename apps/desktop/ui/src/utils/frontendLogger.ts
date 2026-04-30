export type FrontendLogType = 'business' | 'error' | 'security' | 'debug';

interface FrontendLogFields {
    domain: string;
    action?: string;
    stage?: string;
    code?: string;
    detail?: string;
}

function shouldEmit(level: 'info' | 'warn' | 'error' | 'debug', logType: FrontendLogType) {
    if (level === 'error' || level === 'warn') {
        return true;
    }
    if (logType === 'security') {
        return true;
    }
    return typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);
}

function emit(level: 'info' | 'warn' | 'error' | 'debug', logType: FrontendLogType, message: string, fields: FrontendLogFields) {
    if (!shouldEmit(level, logType)) {
        return;
    }

    const payload = {
        timestamp: new Date().toISOString(),
        level,
        logger: 'ui.renderer',
        logType,
        message,
        ...fields
    };
    const text = `[UI][${payload.domain}] ${message}`;

    if (level === 'error') {
        console.error(text, payload);
        return;
    }
    if (level === 'warn') {
        console.warn(text, payload);
        return;
    }
    if (level === 'debug') {
        console.debug(text, payload);
        return;
    }
    console.info(text, payload);
}

export function logUiBusiness(message: string, fields: FrontendLogFields) {
    emit('info', 'business', message, fields);
}

export function logUiWarn(message: string, fields: FrontendLogFields) {
    emit('warn', 'business', message, fields);
}

export function logUiError(message: string, fields: FrontendLogFields) {
    emit('error', 'error', message, fields);
}

export function logUiDebug(message: string, fields: FrontendLogFields) {
    emit('debug', 'debug', message, fields);
}
