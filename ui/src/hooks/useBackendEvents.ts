import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Segment } from './useVideoProject';

interface PartialResultPayload {
    index?: number;
    audio_path?: string;
    success?: boolean;
    duration?: number;
    text?: string;
}

interface BackendEventsOptions {
    setIsIndeterminate: Dispatch<SetStateAction<boolean>>;
    setProgress: Dispatch<SetStateAction<number>>;
    setTranslatedSegments: Dispatch<SetStateAction<Segment[]>>;
    setInstallingDeps: Dispatch<SetStateAction<boolean>>;
    setDepsPackageName: Dispatch<SetStateAction<string>>;
}

export function useBackendEvents({
    setIsIndeterminate,
    setProgress,
    setTranslatedSegments,
    setInstallingDeps,
    setDepsPackageName
}: BackendEventsOptions) {
    useEffect(() => {
        const handleProgress = (value: number) => {
            setIsIndeterminate(false);
            setProgress(value);
        };

        const handlePartialResult = (_event: unknown, data: PartialResultPayload) => {
            if (data && typeof data.index === 'number') {
                const segmentIndex = data.index;
                setTranslatedSegments(prev => {
                    const newSegs = [...prev];
                    if (newSegs[segmentIndex]) {
                        if (data.audio_path !== undefined) {
                            const isSuccess = data.success === true;
                            let status: 'ready' | 'error' = isSuccess ? 'ready' : 'error';

                            if (isSuccess && data.duration) {
                                const seg = newSegs[segmentIndex];
                                const expectedDur = seg.end - seg.start;
                                if (data.duration - expectedDur > 5.0) status = 'error';
                            }

                            if (isSuccess && !data.audio_path) status = 'error';

                            newSegs[segmentIndex] = {
                                ...newSegs[segmentIndex],
                                audioPath: data.audio_path,
                                audioStatus: status,
                                audioDuration: data.duration
                            };
                        }

                        if (data.text !== undefined) {
                            newSegs[segmentIndex] = {
                                ...newSegs[segmentIndex],
                                text: data.text
                            };
                        }
                    }
                    return newSegs;
                });
            }
        };

        const handleDepsInstalling = (pkgName: string) => {
            setInstallingDeps(true);
            setDepsPackageName(pkgName);
        };

        const handleDepsDone = () => {
            setInstallingDeps(false);
            setDepsPackageName('');
        };

        const offProgress = window.api.onBackendProgress(handleProgress);
        const offPartial = window.api.onBackendPartialResult((data) => handlePartialResult(undefined, data as PartialResultPayload));
        const offDepsInstalling = window.api.onBackendDepsInstalling(handleDepsInstalling);
        const offDepsDone = window.api.onBackendDepsDone(handleDepsDone);

        return () => {
            offProgress();
            offPartial();
            offDepsInstalling();
            offDepsDone();
        };
    }, [setDepsPackageName, setInstallingDeps, setIsIndeterminate, setProgress, setTranslatedSegments]);
}
