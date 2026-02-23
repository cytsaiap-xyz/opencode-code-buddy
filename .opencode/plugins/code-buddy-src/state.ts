/**
 * PluginState — centralised mutable state for the plugin.
 *
 * Replaces the dozens of closured variables from the old single-file design.
 * Every tool and hook receives a reference to a single PluginState instance.
 */

import type {
    MemoryEntry, Entity, Relation, MistakeRecord,
    SessionState, Observation, PendingDeletion, ProviderInfo, PluginConfig,
} from "./types";
import { LocalStorage } from "./storage";
import { getMemoryCategory } from "./helpers";

export class PluginState {
    // Persisted data
    memories: MemoryEntry[];
    entities: Entity[];
    relations: Relation[];
    mistakes: MistakeRecord[];

    // Runtime-only
    session: SessionState;
    pendingDeletion: PendingDeletion | null = null;
    observationBuffer: Observation[] = [];
    resolvedProvider: ProviderInfo | null = null;

    // References
    readonly storage: LocalStorage;
    readonly config: PluginConfig;
    readonly configPath: string;
    readonly client: any; // OpenCode SDK client

    constructor(storage: LocalStorage, config: PluginConfig, configPath: string, client: unknown) {
        this.storage = storage;
        this.config = config;
        this.configPath = configPath;
        this.client = client;

        this.memories = storage.read("memory.json", []);
        this.entities = storage.read("entities.json", []);
        this.relations = storage.read("relations.json", []);
        this.mistakes = storage.read("mistakes.json", []);

        this.session = {
            sessionId: `session_${Date.now()}`,
            startTime: Date.now(),
            lastActivity: Date.now(),
            tasksCompleted: 0,
            memoriesCreated: 0,
            errorsRecorded: 0,
            currentPhase: "idle",
        };
    }

    // ---- Persistence ----

    saveMemories(): void {
        this.storage.write("memory.json", this.memories);
    }
    saveEntities(): void {
        this.storage.write("entities.json", this.entities);
    }
    saveRelations(): void {
        this.storage.write("relations.json", this.relations);
    }
    saveMistakes(): void {
        this.storage.write("mistakes.json", this.mistakes);
    }

    // ---- Category-based queries ----

    getSolutionMemories(): MemoryEntry[] {
        return this.memories.filter((m) => getMemoryCategory(m) === "solution");
    }
    getKnowledgeMemories(): MemoryEntry[] {
        return this.memories.filter((m) => getMemoryCategory(m) === "knowledge");
    }

    // ---- Observer buffer ----

    pushObservation(obs: Observation): void {
        this.observationBuffer.push(obs);
        if (this.observationBuffer.length > 50) {
            this.observationBuffer.splice(0, this.observationBuffer.length - 50);
        }
    }

    clearObservations(): void {
        this.observationBuffer.length = 0;
    }

    // ---- Logging (respects verbose flag) ----

    /** Log to console only when verbose is enabled. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log(...args: any[]): void {
        if (this.config.features.verbose !== false) {
            console.log(...args);
        }
    }
}
