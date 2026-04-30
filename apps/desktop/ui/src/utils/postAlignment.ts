import type { ModelStatusResponse } from '../types/backend';
import type { AsrService } from './asrService';

export type PostAlignmentProvider = 'none' | 'qwen-forced-aligner';

export interface PostAlignmentProviderMeta {
    id: PostAlignmentProvider;
    name: string;
    requiredModelKeys: string[];
    implementationState: 'none' | 'planned' | 'active';
    detail: string;
}

export interface AsrExecutionPlan {
    asrService: AsrService;
    outputMode: 'timed_subtitles' | 'transcript_only';
    postAlignmentProvider: PostAlignmentProvider;
    workflowReady: boolean;
    workflowBlockReason?: string;
}

export const POST_ALIGNMENT_PROVIDER_META: Record<PostAlignmentProvider, PostAlignmentProviderMeta> = {
    none: {
        id: 'none',
        name: 'None',
        requiredModelKeys: [],
        implementationState: 'none',
        detail: '当前 ASR provider 自身即可产出时间轴字幕，不需要额外后对齐。'
    },
    'qwen-forced-aligner': {
        id: 'qwen-forced-aligner',
        name: 'Qwen3 Forced Aligner',
        requiredModelKeys: ['qwen_asr_aligner'],
        implementationState: 'active',
        detail: '当前仓库已集成 Qwen3 Forced Aligner 作为 transcript-only ASR 的后对齐执行器。若具体 provider 仍不可执行，会由该 provider 自身的运行时或平台限制继续阻塞。'
    }
};

export function getAsrExecutionPlan(service: AsrService): AsrExecutionPlan {
    return {
        asrService: service,
        outputMode: 'timed_subtitles',
        postAlignmentProvider: 'none',
        workflowReady: true
    };
}

export function getPostAlignmentBlockingReason(
    plan: AsrExecutionPlan,
    modelStatus: ModelStatusResponse | null
): string | null {
    if (plan.workflowReady) {
        return null;
    }

    const providerMeta = POST_ALIGNMENT_PROVIDER_META[plan.postAlignmentProvider];
    if (!providerMeta || providerMeta.id === 'none') {
        return plan.workflowBlockReason || '当前 ASR 输出无法进入字幕主流程。';
    }

    const status = modelStatus?.status || {};
    const statusDetails = modelStatus?.status_details || {};
    for (const modelKey of providerMeta.requiredModelKeys) {
        if (!status[modelKey]) {
            return statusDetails[modelKey]?.detail || `${providerMeta.name} 未就绪。`;
        }
    }

    if (providerMeta.implementationState !== 'active') {
        return plan.workflowBlockReason || providerMeta.detail;
    }

    return null;
}
