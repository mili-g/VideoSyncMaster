export type ViewId = 'home' | 'batch' | 'models' | 'diagnostics' | 'logs' | 'asr' | 'tts' | 'translation' | 'merge' | 'about';

export interface ViewMeta {
    id: ViewId;
    title: string;
    description: string;
    section: 'workflow' | 'system';
}

export const VIEW_REGISTRY: ViewMeta[] = [
    { id: 'home', title: '项目工作台', description: '以视频、字幕、配音和合成为主链路的执行台。', section: 'workflow' },
    { id: 'batch', title: '批量任务', description: '集中处理多个视频素材和输出目录。', section: 'workflow' },
    { id: 'asr', title: '识别中心', description: '配置识别引擎、模型档位和本地 Runtime 参数。', section: 'workflow' },
    { id: 'tts', title: '配音中心', description: '管理语音克隆、音色模式和批量生成参数。', section: 'workflow' },
    { id: 'translation', title: '翻译配置', description: '维护字幕翻译策略和语言输出设置。', section: 'workflow' },
    { id: 'merge', title: '合成配置', description: '控制混音、烧录与视频交付策略。', section: 'workflow' },
    { id: 'models', title: '模型中心', description: '查看本地模型状态、路径和下载入口。', section: 'system' },
    { id: 'diagnostics', title: '环境诊断', description: '检查 Python、模型、ASR 通道和工作流就绪度。', section: 'system' },
    { id: 'logs', title: '运行日志', description: '在应用内查看、清空和导出后端运行日志。', section: 'system' },
    { id: 'about', title: '关于', description: '查看应用版本与能力说明。', section: 'system' }
];

export function getViewMeta(viewId: ViewId): ViewMeta {
    return VIEW_REGISTRY.find((item) => item.id === viewId) || VIEW_REGISTRY[0];
}
