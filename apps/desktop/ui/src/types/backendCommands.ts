import type { BackendAction } from './backendCommands.generated';

export { BACKEND_ACTIONS } from './backendCommands.generated';
export type { BackendAction } from './backendCommands.generated';

export function withBackendAction(action: BackendAction, ...args: string[]): string[] {
    return ['--action', action, ...args];
}
