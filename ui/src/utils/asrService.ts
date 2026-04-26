export const SUPPORTED_ASR_SERVICES = ['bcut', 'jianying', 'whisperx', 'qwen'] as const;

export type AsrService = typeof SUPPORTED_ASR_SERVICES[number];

export interface AsrServiceMeta {
    id: AsrService;
    name: string;
    shortName: string;
    description: string;
    detailTitle: string;
    detailBody: string;
}

export const ASR_SERVICE_META: Record<AsrService, AsrServiceMeta> = {
    whisperx: {
        id: 'whisperx',
        name: 'WhisperX (本地实时)',
        shortName: 'WhisperX',
        description: '高质量本地模型，支持 VAD 与强制对齐',
        detailTitle: 'WhisperX 本地识别',
        detailBody: '适合对时间轴精度要求高的项目。支持本地模型、VAD 阈值微调与长视频字幕对齐。'
    },
    qwen: {
        id: 'qwen',
        name: 'Qwen3 ASR (本地)',
        shortName: 'Qwen3',
        description: '端到端多语种识别模型，准确率高',
        detailTitle: 'Qwen3 本地识别',
        detailBody: '适合多语种内容与纯本地流程。当前项目中与 Qwen3-TTS 运行环境兼容，不能与 Index-TTS 同时启用。'
    },
    jianying: {
        id: 'jianying',
        name: '剪映 API (云端)',
        shortName: '剪映 API',
        description: '云端识别，速度快，适合中文长视频',
        detailTitle: '剪映云端接口',
        detailBody: '无需额外 API Key。后端会直接调用剪映相关接口完成上传、提交和结果查询，更适合想快速出稿的场景。'
    },
    bcut: {
        id: 'bcut',
        name: '必剪 API (云端)',
        shortName: '必剪 API',
        description: '云端识别，稳定性更好，适合通用视频',
        detailTitle: '必剪云端接口',
        detailBody: '无需额外 API Key。后端直接接入必剪/Bcut 的转录流程，依赖更少，通常比剪映接口更稳一点。'
    }
};

export function isSupportedAsrService(value: string | null | undefined): value is AsrService {
    return !!value && (SUPPORTED_ASR_SERVICES as readonly string[]).includes(value);
}

export function getAsrServiceLabel(value: string | null | undefined): string {
    if (value && isSupportedAsrService(value)) {
        return ASR_SERVICE_META[value].shortName;
    }
    return '必剪 API';
}
