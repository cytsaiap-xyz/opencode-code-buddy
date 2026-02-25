import { vi } from "vitest";
import type { MemoryEntry, Observation, PluginConfig, SessionState } from "../types";
import type { PluginState } from "../state";

export function createMockState(overrides: {
    memories?: MemoryEntry[];
    observationBuffer?: Observation[];
    resolvedProvider?: any;
} = {}): PluginState {
    const memories = overrides.memories ?? [];
    const observationBuffer = overrides.observationBuffer ?? [];

    return {
        memories,
        observationBuffer,
        config: {
            enabled: true,
            llm: { preferredProvider: "", preferredModel: "", maxTokens: 1000, temperature: 0.7 },
            storage: { dataDir: "/tmp/test" },
            features: { memory: true, knowledgeGraph: false, errorLearning: false, workflow: false, ai: true, verbose: false },
            hooks: {
                autoRemind: false, protectEnv: false, trackFiles: false, compactionContext: false,
                autoObserve: true, observeMinActions: 2, observeIgnoreTools: [], fullAuto: true,
                autoErrorDetect: false, requireEditForRecord: true,
            },
        } as PluginConfig,
        resolvedProvider: overrides.resolvedProvider ?? null,
        session: {
            sessionId: "test_session",
            startTime: Date.now(),
            lastActivity: Date.now(),
            tasksCompleted: 0,
            memoriesCreated: 0,
            errorsRecorded: 0,
            currentPhase: "idle",
        } as SessionState,
        client: {
            config: { providers: vi.fn().mockResolvedValue({ data: null }) },
        },
        entities: [],
        relations: [],
        mistakes: [],
        pendingDeletion: null,
        storage: { read: vi.fn(() => []), write: vi.fn() } as any,
        configPath: "/tmp/test-config.json",
        saveMemories: vi.fn(),
        saveEntities: vi.fn(),
        saveRelations: vi.fn(),
        saveMistakes: vi.fn(),
        getSolutionMemories: vi.fn(() => []),
        getKnowledgeMemories: vi.fn(() => []),
        pushObservation: vi.fn((obs: Observation) => observationBuffer.push(obs)),
        clearObservations: vi.fn(() => { observationBuffer.length = 0; }),
        log: vi.fn(),
    } as unknown as PluginState;
}

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
    return {
        id: `mem_${Date.now()}_test`,
        type: "note",
        category: "knowledge",
        title: "Test Memory",
        content: "Test content for memory entry",
        tags: ["test"],
        timestamp: new Date().toISOString(),
        ...overrides,
    };
}

export function createObservation(overrides: Partial<Observation> = {}): Observation {
    return {
        timestamp: new Date().toISOString(),
        tool: "read",
        args: {},
        result: "",
        hasError: false,
        isWriteAction: false,
        ...overrides,
    };
}
