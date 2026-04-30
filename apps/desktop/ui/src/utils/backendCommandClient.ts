import type { BackendAction } from '../types/backendCommands';
import type { BackendCommandResponse } from '../types/backend';

type BackendLane = 'default' | 'prep';

export interface BackendCommandSpec<Action extends BackendAction = BackendAction> {
    action: Action;
    args: string[];
}

export async function runBackendCommand<Action extends BackendAction>(
    command: BackendCommandSpec<Action>,
    options?: { lane?: BackendLane }
): Promise<BackendCommandResponse<Action>> {
    return window.api.runBackend<BackendCommandResponse<Action>>(command.args, options);
}
