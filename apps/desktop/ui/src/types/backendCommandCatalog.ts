import backendCommandCatalogJson from './backendCommandCatalog.generated.json';

export interface BackendCommandCatalogArgument {
    name: string;
    required: boolean;
    description: string;
}

export interface BackendCommandCatalogEntry {
    name: string;
    description: string;
    category: string;
    json_supported: boolean;
    args: BackendCommandCatalogArgument[];
}

interface BackendCommandCatalogDocument {
    version: number;
    generated_from: string;
    commands: BackendCommandCatalogEntry[];
}

export const BACKEND_COMMAND_CATALOG = backendCommandCatalogJson as BackendCommandCatalogDocument;
export const BACKEND_COMMAND_CATALOG_BY_NAME = Object.fromEntries(
    BACKEND_COMMAND_CATALOG.commands.map((command) => [command.name, command])
) as Record<string, BackendCommandCatalogEntry>;
