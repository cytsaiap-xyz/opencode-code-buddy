/**
 * PluginState — centralised mutable state for the plugin.
 *
 * Replaces the dozens of closured variables from the old single-file design.
 * Every tool and hook receives a reference to a single PluginState instance.
 */

import type {
    MemoryEntry, Entity, Relation, MistakeRecord,
    SessionState, Observation, SessionBuffer, PendingDeletion, ProviderInfo, PluginConfig,
} from "./types";
import { LocalStorage } from "./storage";
import { getMemoryCategory, nowTimestamp } from "./helpers";

export class PluginState {
    // Persisted data
    memories: MemoryEntry[];
    entities: Entity[];
    relations: Relation[];
    mistakes: MistakeRecord[];

    // Runtime-only
    session: SessionState;
    pendingDeletion: PendingDeletion | null = null;
    /** Per-session observation buffers — each agent/session gets isolated storage. */
    sessionBuffers: Map<string, SessionBuffer> = new Map();
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

    // ---- Observer buffers (per-session) ----

    /** Read-only aggregate of ALL sessions' observations (for cross-session searches like guide matching). */
    get observationBuffer(): Observation[] {
        const all: Observation[] = [];
        for (const buf of this.sessionBuffers.values()) {
            all.push(...buf.observations);
        }
        return all;
    }

    pushObservation(obs: Observation): void {
        const sid = obs.sessionId || "default";
        let buf = this.sessionBuffers.get(sid);
        if (!buf) {
            buf = { observations: [] };
            this.sessionBuffers.set(sid, buf);
        }
        buf.observations.push(obs);
        if (buf.observations.length > 50) {
            buf.observations.splice(0, buf.observations.length - 50);
        }
    }

    getSessionObservations(sessionId: string): Observation[] {
        return this.sessionBuffers.get(sessionId)?.observations || [];
    }

    clearSessionObservations(sessionId: string): void {
        const buf = this.sessionBuffers.get(sessionId);
        if (buf) {
            buf.observations.length = 0;
        }
    }

    /** Clear ALL session buffers. */
    clearObservations(): void {
        this.sessionBuffers.clear();
    }

    setDelegationContext(sessionId: string, context: string): void {
        let buf = this.sessionBuffers.get(sessionId);
        if (!buf) {
            buf = { observations: [] };
            this.sessionBuffers.set(sessionId, buf);
        }
        buf.delegationContext = context;
    }

    getDelegationContext(sessionId: string): string | undefined {
        return this.sessionBuffers.get(sessionId)?.delegationContext;
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
