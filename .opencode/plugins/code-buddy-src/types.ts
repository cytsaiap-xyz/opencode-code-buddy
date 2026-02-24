/**
 * Type definitions for Code Buddy Plugin.
 */

// ---- Memory ----

export type MemoryType = "decision" | "pattern" | "bugfix" | "lesson" | "feature" | "note";
export type MemoryCategory = "solution" | "knowledge";

export const VALID_MEMORY_TYPES: MemoryType[] = ["decision", "pattern", "bugfix", "lesson", "feature", "note"];

export const MEMORY_TYPE_CATEGORY: Record<MemoryType, MemoryCategory> = {
    decision: "solution",
    bugfix: "solution",
    lesson: "solution",
    pattern: "knowledge",
    feature: "knowledge",
    note: "knowledge",
};

export interface MemoryEntry {
    id: string;
    type: MemoryType;
    category?: MemoryCategory;
    title: string;
    content: string;
    tags: string[];
    timestamp: number;
}

// ---- Knowledge Graph ----

export type EntityType = "decision" | "feature" | "component" | "file" | "bug_fix" | "lesson" | "pattern" | "technology";

export interface Entity {
    id: string;
    name: string;
    type: EntityType;
    observations: string[];
    tags: string[];
    createdAt: number;
}

export interface Relation {
    id: string;
    from: string;
    to: string;
    type: string;
    description?: string;
    createdAt: number;
}

// ---- Error Learning ----

export type ErrorType =
    | "procedure-violation" | "workflow-skip" | "assumption-error" | "validation-skip"
    | "responsibility-lack" | "firefighting" | "dependency-miss" | "integration-error"
    | "deployment-error" | "other";

export interface MistakeRecord {
    id: string;
    timestamp: number;
    action: string;
    errorType: ErrorType;
    userCorrection: string;
    correctMethod: string;
    impact: string;
    preventionMethod: string;
    relatedRule?: string;
}

// ---- Session ----

export interface SessionState {
    sessionId: string;
    startTime: number;
    lastActivity: number;
    tasksCompleted: number;
    memoriesCreated: number;
    errorsRecorded: number;
    currentPhase: string;
}

// ---- Observer ----

export interface Observation {
    timestamp: number;
    tool: string;
    args: Record<string, unknown>;
    result?: string;
    hasError: boolean;
    fileEdited?: string;
    isWriteAction: boolean;
}

// ---- Pending Deletion ----

export interface PendingDeletion {
    type: "memory" | "entity" | "relation" | "mistake";
    ids: string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: any[];
    timestamp: number;
    confirmCode: string;
}

// ---- LLM ----

export interface ProviderInfo {
    providerID: string;
    modelID: string;
    baseURL: string;
    apiKey: string;
    name: string;
}

// ---- Config ----

export interface PluginConfig {
    enabled: boolean;
    llm: {
        preferredProvider: string;
        preferredModel: string;
        maxTokens: number;
        temperature: number;
    };
    storage: {
        dataDir: string;
    };
    features: {
        memory: boolean;
        knowledgeGraph: boolean;
        errorLearning: boolean;
        workflow: boolean;
        ai: boolean;
        verbose: boolean;
    };
    hooks: {
        autoRemind: boolean;
        protectEnv: boolean;
        trackFiles: boolean;
        compactionContext: boolean;
        autoObserve: boolean;
        observeMinActions: number;
        observeIgnoreTools: string[];
        fullAuto: boolean;
        autoErrorDetect: boolean;
        /** Only auto-record when the observation buffer contains at least one write action (file edit, bash, etc.). */
        requireEditForRecord: boolean;
    };
}

// ---- Dedup result ----

export interface DedupResult {
    action: "created" | "merged" | "skipped";
    entry?: MemoryEntry;
    similarMemories?: MemoryEntry[];
    method?: string;
    message: string;
}
