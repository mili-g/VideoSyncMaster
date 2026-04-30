export interface DiagnosticReference {
    label: string;
    description: string;
}

const STAGE_REFERENCES: Record<string, DiagnosticReference> = {
    bootstrap: {
        label: '启动阶段',
        description: '处理运行环境、模型目录、依赖路径和基础上下文初始化。'
    },
    dispatch: {
        label: '动作分发',
        description: '校验动作名并把请求路由到具体后端命令或工作流。'
    },
    worker: {
        label: '工作线程',
        description: '桌面端与后端 worker 之间的请求收发和执行包装阶段。'
    },
    asr: {
        label: '语音识别',
        description: '调用 ASR 引擎识别原视频或音频中的字幕片段。'
    },
    translate: {
        label: '字幕翻译',
        description: '将识别结果或输入文本翻译为目标语言字幕。'
    },
    translation: {
        label: '字幕翻译',
        description: '处理翻译参数、模型调用和翻译结果输出。'
    },
    tts: {
        label: '语音合成',
        description: '根据字幕文本和参考音生成目标语音频。'
    },
    dubbing: {
        label: '配音流程',
        description: '编排整条配音工作流，包括翻译、TTS、重试与结果汇总。'
    },
    merge: {
        label: '视频合成',
        description: '把配音音频按时间轴写回视频并处理混音策略。'
    },
    media: {
        label: '媒体处理',
        description: '读取媒体元数据、转码或进行基础音视频处理。'
    }
};

const CODE_REFERENCES: Record<string, DiagnosticReference> = {
    UNKNOWN_ACTION: {
        label: '未知动作',
        description: '前端请求了当前后端不支持的动作名，通常是版本不匹配或参数构造错误。'
    },
    WORKER_REQUEST_FAILED: {
        label: '工作线程执行失败',
        description: '桌面端已成功发起请求，但后端 worker 在执行过程中抛出了未处理异常。'
    },
    JIANYING_SIGN_SERVICE_UNAVAILABLE: {
        label: '剪映签名服务不可用',
        description: '剪映 API 依赖的签名服务当前不可用，建议稍后重试或切换其他 ASR 引擎。'
    },
    ASR_MODEL_MISSING: {
        label: 'ASR 模型缺失',
        description: '当前选择的识别引擎模型未安装，或模型目录不存在。'
    },
    ASR_RUNTIME_UNSUPPORTED: {
        label: 'ASR 运行时不兼容',
        description: '本地 Python 或 transformers 运行环境不满足当前 ASR 引擎要求。'
    },
    ASR_FAILED: {
        label: '语音识别失败',
        description: 'ASR 阶段执行失败，通常与模型、输入媒体、网络或语言配置有关。'
    },
    ASR_NO_SEGMENTS: {
        label: '未识别到片段',
        description: '识别流程完成但没有得到有效字幕片段，常见于源语言、VAD 或音频质量问题。'
    },
    ASR_BINARY_MISSING: {
        label: '识别组件缺失',
        description: 'faster-whisper 等本地识别所需的可执行组件未找到。'
    },
    TTS_RUNTIME_INIT_FAILED: {
        label: 'TTS 运行时初始化失败',
        description: '切换或预热语音合成运行环境失败，通常与依赖版本或模型目录有关。'
    },
    TTS_SEGMENT_FAILED: {
        label: '单段配音失败',
        description: '某个字幕片段在语音合成阶段失败，需要结合详细日志检查文本、参考音或模型状态。'
    },
    MERGE_VIDEO_FAILED: {
        label: '视频合成失败',
        description: '视频合成或混音阶段发生异常，常见于音频时长、ffmpeg 处理或输出路径问题。'
    },
    QUEUE_PREPARE_FAILED: {
        label: '批处理准备失败',
        description: '批量任务在准备输出目录、字幕或恢复现场时失败。'
    },
    QUEUE_FINALIZE_FAILED: {
        label: '批处理收尾失败',
        description: '批量任务在生成配音、重试或最终合成阶段失败。'
    }
};

export function getStageReference(stage?: string): DiagnosticReference | null {
    if (!stage) return null;
    return STAGE_REFERENCES[stage] || null;
}

export function getCodeReference(code?: string): DiagnosticReference | null {
    if (!code) return null;
    return CODE_REFERENCES[code] || null;
}
