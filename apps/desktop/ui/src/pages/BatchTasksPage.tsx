import BatchQueuePanel from '../components/BatchQueuePanel';
import type { BatchQueueItem } from '../hooks/useBatchQueue';
import type { BatchInputAsset } from '../utils/batchAssets';
import PageFrame from '../layout/PageFrame';
import type { AsrSourceLanguage } from '../utils/asrService';

interface BatchQueueSummary {
    total: number;
    pending: number;
    processing: number;
    success: number;
    error: number;
    canceled: number;
    totalSourceDurationSec: number;
    totalElapsedMs: number;
    nowEpochMs: number;
}

interface BatchTasksPageProps {
    items: BatchQueueItem[];
    unmatchedSubtitleAssets: BatchInputAsset[];
    summary: BatchQueueSummary;
    isRunning: boolean;
    canStart: boolean;
    canGenerateSubtitles: boolean;
    canGenerateTranslations: boolean;
    onAddAssets: (assets: BatchInputAsset[]) => void | Promise<void>;
    onAssignUnmatchedSubtitle: (assetPath: string, itemId: string, kind: 'subtitle-original' | 'subtitle-translated') => void;
    onRemoveUnmatchedSubtitle: (assetPath: string) => void;
    onRemoveItem: (id: string) => void;
    onClearCompleted: () => void;
    onClearAll: () => void;
    onGenerateSubtitles: () => void;
    onGenerateTranslations: () => void;
    onRetryFailed: () => void;
    onOpenOutput: (item: BatchQueueItem) => void;
    onStart: () => void;
    onStop: () => void;
    targetLang: string;
    onSetTargetLang: (lang: string) => void;
    asrOriLang: AsrSourceLanguage;
    onSetAsrOriLang: (lang: AsrSourceLanguage) => void;
}

export default function BatchTasksPage(props: BatchTasksPageProps) {
    return (
        <div className="view-page-shell view-page-shell--batch">
            <PageFrame
                eyebrow="Batch"
                title="批量任务"
                description="集中管理批量素材、执行队列与成片产出。"
                headerMode="hidden"
            >
                <BatchQueuePanel {...props} />
            </PageFrame>
        </div>
    );
}
