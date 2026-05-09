export type ViewId = 'home' | 'batch' | 'models' | 'licenses' | 'diagnostics' | 'logs' | 'asr' | 'tts' | 'translation' | 'merge' | 'about';

export interface ViewMeta {
    id: ViewId;
    title: string;
    description: string;
    section: 'workflow' | 'system';
}

export const VIEW_REGISTRY: ViewMeta[] = [
    { id: 'home', title: '项目工作台', description: '主流程', section: 'workflow' },
    { id: 'batch', title: '批量任务', description: '队列', section: 'workflow' },
    { id: 'asr', title: '识别中心', description: '识别', section: 'workflow' },
    { id: 'tts', title: '配音中心', description: '配音', section: 'workflow' },
    { id: 'translation', title: '翻译配置', description: '翻译', section: 'workflow' },
    { id: 'merge', title: '合成配置', description: '合成', section: 'workflow' },
    { id: 'models', title: '模型中心', description: '模型', section: 'system' },
    { id: 'licenses', title: '授权中心', description: '授权', section: 'system' },
    { id: 'diagnostics', title: '环境诊断', description: '诊断', section: 'system' },
    { id: 'logs', title: '运行日志', description: '日志', section: 'system' },
    { id: 'about', title: '关于', description: '版本', section: 'system' }
];

export function getViewMeta(viewId: ViewId): ViewMeta {
    return VIEW_REGISTRY.find((item) => item.id === viewId) || VIEW_REGISTRY[0];
}
